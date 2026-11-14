import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ExtensionTimers } from '../target/extension_timers.js';
const source = readFileSync(new URL('../src/extension.ts', import.meta.url), 'utf8');
function method(name) {
    const start = source.indexOf('    ' + name + '(');
    assert.ok(start >= 0, name);
    return source.slice(start, source.indexOf('\n    }', start) + 6)
        .replaceAll(': Window.ShellWindow', '');
}
function fixture() {
    const sources = new Map(), removed = [], errors = [];
    let serial = 0, reused = null, active = true, generation = 0;
    const flags = { addError: false, removeError: false, addHook: null };
    const backend = {
        add(priority, delay, callback) {
            if (flags.addError) throw new Error('add failed');
            const id = reused ?? ++serial; reused = null; assert.equal(sources.has(id), false);
            sources.set(id, { priority, delay, callback });
            const hook = flags.addHook; flags.addHook = null; hook?.(); return id;
        },
        remove(id) {
            assert.equal(sources.delete(id), true, `invalid remove ${id}`); removed.push(id);
            if (flags.removeError) throw new Error('remove failed');
        },
    };
    const reporter = { call(error) { errors.push(error); } };
    const timers = new ExtensionTimers(backend, () => active, () => generation, e => reporter.call(e));
    function tick(id) {
        const entry = sources.get(id); assert.ok(entry, `missing source ${id}`);
        const keep = entry.callback(); if (!keep && sources.get(id) === entry) sources.delete(id); return keep;
    }
    return { timers, sources, removed, errors, flags, reporter, backend, tick,
        deactivate(cleanup = true) { active = false; generation++; if (cleanup) timers.stop(); },
        activate() { active = true; }, reuse(id) { reused = id; } };
}

test('owned timeout runs once and never removes an already expired ID', () => {
    const f = fixture(); let calls = 0; f.timers.schedule('a', 300, 500, () => { calls++; return false; });
    const [id, e] = [...f.sources][0]; assert.equal(e.priority, 300); assert.equal(e.delay, 500);
    assert.equal(f.tick(id), false); f.timers.stop(); assert.equal(calls, 1);
    assert.equal(f.timers.size, 0); assert.deepEqual(f.removed, []); assert.deepEqual(f.errors, []);
});
test('true repeats the same source until the task returns false', () => {
    const f = fixture(); let n = 0; f.timers.schedule('a', 0, 50, () => ++n < 3); const [id] = f.sources.keys();
    assert.deepEqual([f.tick(id), f.tick(id), f.tick(id)], [true, true, false]); assert.equal(f.timers.size, 0);
});
test('same-key replacement rejects an already dispatched previous callback', () => {
    const f = fixture(); let oldCalls = 0, newCalls = 0;
    f.timers.schedule('a', 0, 1, () => { oldCalls++; return true; }); const [oldId, entry] = [...f.sources][0];
    f.timers.schedule('a', 0, 1, () => { newCalls++; return false; }); const [id] = f.sources.keys();
    assert.notEqual(id, oldId); assert.equal(entry.callback(), false); assert.equal(f.sources.has(id), true);
    f.tick(id); assert.equal(oldCalls, 0); assert.equal(newCalls, 1);
});
test('independent keys do not cancel each other', () => {
    const f = fixture(); const a = {}, b = {}; f.timers.schedule(a, 0, 1, () => false); f.timers.schedule(b, 0, 1, () => false);
    f.timers.cancel(a); assert.equal(f.sources.size, 1); assert.equal(f.timers.size, 1);
    const [id] = f.sources.keys(); assert.equal(f.tick(id), false);
});
test('cancel is idempotent and leaves unrelated backend sources alone', () => {
    const f = fixture(); f.timers.schedule('a', 0, 1, () => true); f.sources.set(999, { callback: () => true });
    f.timers.cancel('a'); f.timers.cancel('a'); assert.equal(f.removed.length, 1); assert.equal(f.sources.has(999), true);
});
test('stop revokes all owned requests before cleanup and is repeatable', () => {
    const f = fixture(); f.timers.schedule('a', 0, 1, () => true); f.timers.schedule('b', 0, 1, () => true);
    const callbacks = [...f.sources.values()].map(e => e.callback); f.deactivate(); f.timers.stop(); f.activate();
    assert.equal(f.removed.length, 2); assert.equal(f.timers.size, 0);
    for (const cb of callbacks) assert.equal(cb(), false); assert.deepEqual(f.errors, []);
});
test('generation invalidation works even before explicit source cleanup', () => {
    const f = fixture(); let calls = 0; f.timers.schedule('a', 0, 1, () => { calls++; return true; });
    const [id] = f.sources.keys(); f.deactivate(false); f.activate();
    assert.equal(f.tick(id), false); assert.equal(calls, 0); assert.equal(f.timers.size, 0);
});
test('inactive owner schedules no source', () => {
    const f = fixture(); f.deactivate(); f.timers.schedule('a', 0, 1, () => true); assert.equal(f.sources.size, 0);
});
test('invalid operation schedules no source', () => {
    const f = fixture(); f.timers.schedule('a', 0, 1, () => true, () => false);
    assert.equal(f.sources.size, 0); assert.equal(f.timers.size, 0);
});
test('validity is checked again before the task runs', () => {
    const f = fixture(); let valid = true, calls = 0;
    f.timers.schedule('a', 0, 1, () => { calls++; return false; }, () => valid);
    const [id] = f.sources.keys(); valid = false; assert.equal(f.tick(id), false); assert.equal(calls, 0);
});
test('callback failures release ownership and report the error', () => {
    const f = fixture(); f.timers.schedule('a', 0, 1, () => { throw new Error('task failed'); });
    const [id] = f.sources.keys(); assert.equal(f.tick(id), false); assert.equal(f.timers.size, 0);
    assert.match(String(f.errors[0]), /task failed/); f.timers.stop(); assert.deepEqual(f.removed, []);
});
test('a failing reporter cannot stop source cleanup', () => {
    const f = fixture(); f.reporter.call = () => { throw new Error('report failed'); };
    f.timers.schedule('a', 0, 1, () => { throw new Error('task failed'); }); const [id] = f.sources.keys();
    assert.equal(f.tick(id), false); assert.equal(f.timers.size, 0);
});
test('stop continues when source removal and reporting fail', () => {
    const f = fixture(); f.timers.schedule('a', 0, 1, () => true); f.timers.schedule('b', 0, 1, () => true);
    f.flags.removeError = true; f.reporter.call = () => { throw new Error('report failed'); };
    assert.doesNotThrow(() => f.deactivate()); assert.equal(f.removed.length, 2); assert.equal(f.timers.size, 0);
});
test('creation failure does not leave an unremovable request', () => {
    const f = fixture(); f.flags.addError = true; f.timers.schedule('a', 0, 1, () => true); f.timers.stop();
    assert.equal(f.timers.size, 0); assert.equal(f.sources.size, 0); assert.deepEqual(f.removed, []);
});
test('validation failure before allocation is contained', () => {
    const f = fixture(); f.timers.schedule('a', 0, 1, () => true, () => { throw new Error('invalid'); });
    assert.equal(f.timers.size, 0); assert.equal(f.sources.size, 0); assert.equal(f.errors.length, 1);
});
test('validation failure after allocation removes the allocated source', () => {
    const f = fixture(); let validations = 0;
    f.timers.schedule('a', 0, 1, () => true, () => { if (++validations === 2) throw new Error('late validation'); return true; });
    assert.equal(f.sources.size, 0); assert.equal(f.timers.size, 0); assert.equal(f.removed.length, 1);
});
test('reentrant replacement during backend allocation preserves the replacement', () => {
    const f = fixture(); f.flags.addHook = () => f.timers.schedule('a', 0, 1, () => true);
    f.timers.schedule('a', 0, 1, () => true); assert.equal(f.sources.size, 1); assert.equal(f.timers.size, 1);
    const [id] = f.sources.keys(); assert.equal(f.tick(id), true); assert.deepEqual(f.errors, []);
});
test('reentrant task replacement cannot revive the old request', () => {
    const f = fixture(); f.timers.schedule('a', 0, 1, () => { f.timers.schedule('a', 0, 1, () => true); return true; });
    const [id] = f.sources.keys(); assert.equal(f.tick(id), false); assert.equal(f.sources.size, 1); assert.equal(f.timers.size, 1);
});
test('numeric ID reuse during a running callback cannot erase its replacement', () => {
    const f = fixture(); let id;
    f.timers.schedule('a', 0, 1, () => { f.reuse(id); f.timers.schedule('a', 0, 1, () => false); return true; });
    [id] = f.sources.keys(); assert.equal(f.tick(id), false); assert.equal(f.sources.has(id), true);
    assert.equal(f.tick(id), false); assert.equal(f.timers.size, 0);
});
test('stop and restart inside a repeating callback cannot restart its source', () => {
    const f = fixture(); f.timers.schedule('a', 0, 1, () => { f.deactivate(); f.activate(); return true; });
    const [id] = f.sources.keys(); assert.equal(f.tick(id), false); assert.equal(f.sources.size, 0);
});
test('reentrant validation cannot restore ownership to the outer request', () => {
    const f = fixture(); let once = true, calls = 0;
    f.timers.schedule('a', 0, 1, () => { calls++; return true; }, () => {
        if (once) { once = false; f.timers.schedule('a', 0, 1, () => false); } return true;
    });
    assert.equal(f.sources.size, 1); const [id] = f.sources.keys(); f.tick(id); assert.equal(calls, 0);
});

function extensionFixture() {
    const f = fixture(), wins = new Map(), callbacks = new Map(), events = [], trace = [];
    const owner = {
        events_enabled: true, event_generation: 0, auto_tiler: null,
        size_requests: new Map(), // Supports the unmodified-controller negative control.
        windows: { get: entity => wins.get(String(entity)) ?? null, values: () => wins.values() },
        connect_meta(_win, signal, cb) { callbacks.set(signal, cb); return callbacks.size; },
        connect_size_signal(_win, signal, cb) { callbacks.set(signal, cb); return callbacks.size; },
        size_signals: { insert() {} }, register(event) { events.push(event); },
        stop_config_io() { trace.push('config'); },
        first_frames: { stop() {} },
    };
    owner.extension_timers = new ExtensionTimers(f.backend, () => owner.events_enabled,
        () => owner.event_generation, error => f.errors.push(error));
    const code = ['connect_window', 'restack', 'stop_window_io'].map(method).join(',\n');
    Object.assign(owner, new Function('GLib', 'Events', 'WindowEvent', `return ({ ${code} });`)(
        { PRIORITY_LOW: 300, timeout_add: (...args) => f.backend.add(...args), source_remove: id => f.backend.remove(id) }, { window_event: (win, kind) => ({ win, kind }) }, { Size: 'size', Workspace: 'workspace', Minimize: 'minimize' }));
    const win = { entity: [0, 0], meta: {}, destroying: false, actor_exists() { return !this.destroying; },
        stop_ui_work() { trace.push('ui'); }, cancel_decoration() { trace.push('decoration'); } };
    wins.set(String(win.entity), win);
    function stop() { owner.events_enabled = false; owner.event_generation++; owner.stop_window_io(); }
    return { ...f, owner, win, wins, callbacks, events, trace, stop, start() { owner.events_enabled = true; } };
}
test('size and position changes debounce into one 500ms window event', () => {
    const f = extensionFixture(); f.owner.connect_window(f.win); f.callbacks.get('size-changed')(); f.callbacks.get('position-changed')();
    assert.equal(f.sources.size, 1); const [id, entry] = [...f.sources][0]; assert.equal(entry.delay, 500);
    assert.equal(f.tick(id), false); assert.deepEqual(f.events, [{ win: f.win, kind: 'size' }]);
});
test('dispatched old size callback cannot erase the new debounce request', () => {
    const f = extensionFixture(); f.owner.connect_window(f.win); f.callbacks.get('size-changed')();
    const entry = [...f.sources.values()][0]; f.callbacks.get('position-changed')(); const [id] = f.sources.keys();
    assert.equal(entry.callback(), false); assert.equal(f.sources.has(id), true); f.tick(id); assert.equal(f.events.length, 1);
});
test('size callback does not enqueue work for a destroying window', () => {
    const f = extensionFixture(); f.owner.connect_window(f.win); f.callbacks.get('size-changed')();
    const [id] = f.sources.keys(); f.win.destroying = true; assert.equal(f.tick(id), false); assert.equal(f.events.length, 0);
});
test('size callback checks current window identity, not only actor presence', () => {
    const f = extensionFixture(); f.owner.connect_window(f.win); f.callbacks.get('size-changed')();
    const [id] = f.sources.keys(); f.wins.set(String(f.win.entity), {}); assert.equal(f.tick(id), false); assert.equal(f.events.length, 0);
});
test('regular window-I/O stop cancels pending size work before UI cleanup', () => {
    const f = extensionFixture(); f.owner.connect_window(f.win); f.callbacks.get('size-changed')(); const cb = [...f.sources.values()][0].callback;
    f.stop(); f.start(); assert.equal(cb(), false); assert.equal(f.sources.size, 0); assert.equal(f.events.length, 0);
    assert.deepEqual(f.trace, ['config', 'ui', 'decoration']); assert.equal(f.owner.extension_timers.size, 0);
});
test('size signals after deactivation cannot create a source', () => {
    const f = extensionFixture(); f.owner.connect_window(f.win); f.stop(); f.callbacks.get('size-changed')(); assert.equal(f.sources.size, 0);
});
test('window timer cancellation does not cancel a different window', () => {
    const f = extensionFixture(); const other = { entity: [1, 0], meta: {}, actor_exists: () => true };
    f.owner.connect_window(f.win); f.callbacks.get('size-changed')(); f.wins.set('1,0', other);
    f.owner.connect_window(other); f.callbacks.get('size-changed')();
    f.win.destroying = true; f.owner.extension_timers.cancel(f.win.meta); assert.equal(f.sources.size, 1);
    const [id] = f.sources.keys(); f.tick(id); assert.strictEqual(f.events[0].win, other);
});
test('stack restack retains eleven 50ms iterations', () => {
    const f = extensionFixture(); let n = 0; f.owner.auto_tiler = { forest: { stacks: new Map([[0, { restack() { n++; } }]]) } };
    f.owner.restack(); const [id, entry] = [...f.sources][0]; assert.equal(entry.delay, 50);
    for (let i = 0; i < 10; i++) assert.equal(f.tick(id), true);
    assert.equal(f.tick(id), false); assert.equal(n, 11); assert.equal(f.owner.extension_timers.size, 0);
});
test('repeated stack-restack requests coalesce instead of multiplying sources', () => {
    const f = extensionFixture(); f.owner.auto_tiler = { forest: { stacks: new Map() } };
    f.owner.restack(); f.owner.restack(); f.owner.restack(); assert.equal(f.sources.size, 1); assert.equal(f.owner.extension_timers.size, 1);
});
test('stack callback rejects a replacement tiler in the same activation', () => {
    const f = extensionFixture(); let n = 0;
    f.owner.auto_tiler = { forest: { stacks: new Map([[0, { restack() { n++; } }]]) } }; f.owner.restack();
    const [id] = f.sources.keys(); f.owner.auto_tiler = { forest: { stacks: new Map() } };
    assert.equal(f.tick(id), false); assert.equal(n, 0);
});
test('stack restack with no tiler allocates no timeout', () => {
    const f = extensionFixture(); f.owner.restack(); assert.equal(f.sources.size, 0);
});
test('reentrant stop in the first stack prevents work on later stacks', () => {
    const f = extensionFixture(); const calls = [];
    f.owner.auto_tiler = { forest: { stacks: new Map([[0, { restack() { calls.push(0); f.stop(); } }],
        [1, { restack() { calls.push(1); } }]]) } }; f.owner.restack(); const [id] = f.sources.keys();
    assert.equal(f.tick(id), false); assert.deepEqual(calls, [0]);
});
test('reentrant replacement in the first stack does not continue the old request', () => {
    const f = extensionFixture(); const calls = []; let again = true;
    f.owner.auto_tiler = { forest: { stacks: new Map([[0, { restack() { calls.push(0); if (again) { again = false; f.owner.restack(); } } }],
        [1, { restack() { calls.push(1); } }]]) } }; f.owner.restack(); const [id] = f.sources.keys();
    assert.equal(f.tick(id), false); assert.deepEqual(calls, [0]); assert.equal(f.sources.size, 1);
});
test('stack failures terminate only their owned retry request', () => {
    const f = extensionFixture(); f.owner.auto_tiler = { forest: { stacks: new Map([[0, { restack() { throw new Error('stack failed'); } }]]) } };
    f.owner.restack(); const [id] = f.sources.keys(); assert.equal(f.tick(id), false);
    assert.equal(f.owner.extension_timers.size, 0); assert.equal(f.errors.length, 1);
});
test('window destruction marks the owner invalid before cancelling its debounce', () => {
    assert.match(method('on_destroy'), /window.destroying = true;\s*this.extension_timers.cancel\(window.meta\);\s*window.stop_ui_work\(\);/);
});
test('production timer adapter uses extension activation and GLib backend', () => {
    assert.match(source, /new ExtensionTimers\(\{\s*add: .*GLib.timeout_add/);
    assert.match(source, /\(\) => this.events_enabled, \(\) => this.event_generation/);
    assert.doesNotMatch(method('connect_window') + method('restack'), /GLib.timeout_add|size_requests/);
});
