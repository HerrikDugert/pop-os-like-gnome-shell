import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { FirstFrames } from '../target/first_frames.js';
const source = readFileSync(new URL('../src/extension.ts', import.meta.url), 'utf8');
function method(name) {
    const start = source.indexOf('    ' + name + '('); assert.ok(start >= 0, name);
    return source.slice(start, source.indexOf('\n    }', start) + 6);
}
function fixture() {
    const sources = new Map(), removed = [], errors = [], actions = [];
    let serial = 0, reused = null, active = true, generation = 0;
    const flags = { addError: false, removeError: false, addHook: null };
    const backend = {
        add(priority, delay, callback) {
            if (flags.addError) throw new Error('add failed');
            const id = reused ?? ++serial; reused = null; assert.equal(sources.has(id), false);
            sources.set(id, { priority, delay, callback }); const hook = flags.addHook; flags.addHook = null; hook?.(); return id;
        },
        remove(id) { assert.equal(sources.delete(id), true, `invalid source ${id}`); removed.push(id);
            if (flags.removeError) throw new Error('remove failed'); },
    };
    const report = { call(why) { errors.push(why); } };
    const owner = new FirstFrames(backend, () => active, () => generation, e => report.call(e));
    function actor() {
        const handlers = new Map(), disconnected = []; let next = 0;
        return { handlers, disconnected, alive: true, connectHook: null, disconnectHook: null,
            frameError: false, destroyError: false, disconnectError: false,
            connect(name, callback) {
                if ((name === 'first-frame' && this.frameError) || (name === 'destroy' && this.destroyError)) throw new Error('connect ' + name);
                const id = ++next; handlers.set(id, { name, callback }); const hook = this.connectHook; hook?.(name, callback); return id;
            },
            disconnect(id) { assert.equal(handlers.delete(id), true, `invalid signal ${id}`); disconnected.push(id);
                this.disconnectHook?.(id); if (this.disconnectError) throw new Error('disconnect failed'); },
            emit(name) { for (const e of [...handlers.values()]) if (e.name === name) e.callback(); },
            capture(name) { return [...handlers.values()].find(e => e.name === name)?.callback; },
        };
    }
    function tick(id) {
        const e = sources.get(id); assert.ok(e); const keep = e.callback();
        if (!keep && sources.get(id) === e) sources.delete(id); return keep;
    }
    return { owner, sources, removed, errors, actions, flags, report, backend, actor, tick,
        arm(key, a, callback = () => actions.push(key), valid = () => true) { owner.arm(key, a, 0, 250, callback, valid); },
        stop(cleanup = true) { active = false; generation++; if (cleanup) owner.stop(); },
        start() { active = true; }, reuse(id) { reused = id; } };
}

test('first-frame wins once and cleans both signals and fallback before the action', () => {
    const f = fixture(), a = f.actor(); f.arm('w', a, () => {
        assert.equal(a.handlers.size, 0); assert.equal(f.sources.size, 0); f.actions.push('w');
    }); const stale = [...f.sources.values()][0].callback; a.emit('first-frame'); stale();
    assert.deepEqual(f.actions, ['w']); assert.equal(f.owner.size, 0); assert.equal(f.removed.length, 1);
});
test('fallback wins once without removing its already dispatched source', () => {
    const f = fixture(), a = f.actor(); f.arm('w', a); const frame = a.capture('first-frame');
    const [id, e] = [...f.sources][0]; assert.equal(e.delay, 250); assert.equal(e.priority, 0);
    assert.equal(f.tick(id), false); frame(); f.owner.stop(); assert.deepEqual(f.actions, ['w']);
    assert.deepEqual(f.removed, []); assert.equal(a.handlers.size, 0); assert.deepEqual(f.errors, []);
});
test('actor destroy cancels both completion paths without performing the action', () => {
    const f = fixture(), a = f.actor(); f.arm('w', a); const frame = a.capture('first-frame'), timeout = [...f.sources.values()][0].callback;
    a.alive = false; a.emit('destroy'); frame(); timeout();
    assert.deepEqual(f.actions, []); assert.equal(a.handlers.size, 0); assert.equal(f.sources.size, 0); assert.equal(f.owner.size, 0);
});
test('regular stop cleans every actor request and cannot revive callbacks after restart', () => {
    const f = fixture(), a = f.actor(), b = f.actor(); f.arm('a', a); f.arm('b', b);
    const callbacks = [a.capture('first-frame'), b.capture('first-frame'), ...[...f.sources.values()].map(e => e.callback)];
    f.stop(); f.owner.stop(); f.start(); for (const cb of callbacks) cb();
    assert.equal(f.actions.length, 0); assert.equal(a.handlers.size + b.handlers.size, 0); assert.equal(f.removed.length, 2);
});
test('generation change rejects a first-frame even before explicit cleanup', () => {
    const f = fixture(), a = f.actor(); f.arm('w', a); f.stop(false); f.start(); a.emit('first-frame');
    assert.equal(f.actions.length, 0); assert.equal(f.sources.size, 0); assert.equal(a.handlers.size, 0);
});
test('generation change rejects fallback even before explicit cleanup', () => {
    const f = fixture(), a = f.actor(); f.arm('w', a); const [id] = f.sources.keys(); f.stop(false); f.start();
    f.tick(id); assert.equal(f.actions.length, 0); assert.equal(a.handlers.size, 0);
});
test('same-key replacement cannot be completed or erased by old callbacks', () => {
    const f = fixture(), a = f.actor(), b = f.actor(); f.arm('w', a); const frame = a.capture('first-frame'), destroy = a.capture('destroy');
    const fallback = [...f.sources.values()][0].callback; f.arm('w', b); const ids = [...f.sources.keys()];
    frame(); destroy(); fallback(); assert.deepEqual([...f.sources.keys()], ids); assert.equal(b.handlers.size, 2);
    b.emit('first-frame'); assert.deepEqual(f.actions, ['w']);
});
test('cancel one actor leaves a different actor request intact', () => {
    const f = fixture(), a = f.actor(), b = f.actor(); f.arm('a', a); f.arm('b', b); f.owner.cancel('a'); f.owner.cancel('a');
    assert.equal(b.handlers.size, 2); assert.equal(f.sources.size, 1); b.emit('first-frame'); assert.deepEqual(f.actions, ['b']);
});
test('inactive owner allocates no signal or timer', () => {
    const f = fixture(), a = f.actor(); f.stop(); f.arm('w', a); assert.equal(a.handlers.size, 0); assert.equal(f.sources.size, 0);
});
test('invalid request allocates no resources', () => {
    const f = fixture(), a = f.actor(); f.arm('w', a, () => f.actions.push('wrong'), () => false);
    assert.equal(a.handlers.size, 0); assert.equal(f.owner.size, 0);
});
test('a request becoming invalid still cleans up both paths', () => {
    const f = fixture(), a = f.actor(); let valid = true; f.arm('w', a, () => f.actions.push('wrong'), () => valid);
    valid = false; a.emit('first-frame'); assert.equal(f.actions.length, 0); assert.equal(a.handlers.size, 0); assert.equal(f.sources.size, 0);
});
test('action exceptions cannot retain a completed request', () => {
    const f = fixture(), a = f.actor(); f.arm('w', a, () => { throw new Error('action failed'); }); a.emit('first-frame');
    assert.equal(f.owner.size, 0); assert.equal(a.handlers.size, 0); assert.equal(f.sources.size, 0); assert.match(String(f.errors[0]), /action failed/);
});
test('a failing reporter cannot interrupt remaining cleanup', () => {
    const f = fixture(), a = f.actor(); f.arm('w', a); a.disconnectError = true; f.flags.removeError = true;
    f.report.call = () => { throw new Error('report failed'); }; assert.doesNotThrow(() => f.stop());
    assert.equal(a.handlers.size, 0); assert.equal(f.sources.size, 0); assert.equal(f.owner.size, 0);
});
test('failure to create fallback removes already installed signals', () => {
    const f = fixture(), a = f.actor(); f.flags.addError = true; f.arm('w', a);
    assert.equal(a.handlers.size, 0); assert.equal(f.owner.size, 0); assert.equal(f.sources.size, 0);
});
test('unsupported first-frame signal still permits the fallback', () => {
    const f = fixture(), a = f.actor(); a.frameError = true; f.arm('w', a); const [id] = f.sources.keys();
    assert.equal(a.handlers.size, 1); f.tick(id); assert.deepEqual(f.actions, ['w']); assert.equal(a.handlers.size, 0);
});
test('unavailable destroy signal fails closed without allocating a fallback', () => {
    const f = fixture(), a = f.actor(); a.destroyError = true; f.arm('w', a);
    assert.equal(f.sources.size, 0); assert.equal(a.handlers.size, 0); assert.equal(f.owner.size, 0);
});
test('synchronous first-frame during connect leaves no returned handler behind', () => {
    const f = fixture(), a = f.actor(); a.connectHook = (name, cb) => { if (name === 'first-frame') cb(); };
    f.arm('w', a); assert.deepEqual(f.actions, ['w']); assert.equal(a.handlers.size, 0); assert.equal(f.sources.size, 0);
});
test('synchronous destroy during connect cannot complete or leak its returned handler', () => {
    const f = fixture(), a = f.actor(); a.connectHook = (name, cb) => { if (name === 'destroy') cb(); };
    f.arm('w', a); assert.deepEqual(f.actions, []); assert.equal(a.handlers.size, 0); assert.equal(f.sources.size, 0);
});
test('reentrant stop during cleanup prevents completion', () => {
    const f = fixture(), a = f.actor(); f.arm('w', a); a.disconnectHook = () => f.stop(); a.emit('first-frame');
    assert.equal(f.actions.length, 0); assert.equal(f.owner.size, 0);
});
test('reentrant replacement during cleanup prevents the superseded completion', () => {
    const f = fixture(), a = f.actor(), b = f.actor(); f.arm('w', a); let replace = true;
    a.disconnectHook = () => { if (replace) { replace = false; f.arm('w', b); } }; a.emit('first-frame');
    assert.equal(f.actions.length, 0); assert.equal(b.handlers.size, 2); b.emit('first-frame'); assert.deepEqual(f.actions, ['w']);
});
test('reentrant completed replacement cannot allow an older completion afterwards', () => {
    const f = fixture(), a = f.actor(), b = f.actor(); f.arm('w', a); let replace = true;
    a.disconnectHook = () => { if (replace) { replace = false; f.arm('w', b); b.emit('first-frame'); } };
    a.emit('first-frame'); assert.deepEqual(f.actions, ['w']); assert.equal(f.owner.size, 0);
});
test('source ID reuse cannot let an old fallback finish a newer actor request', () => {
    const f = fixture(), a = f.actor(), b = f.actor(); f.arm('w', a); const [id, e] = [...f.sources][0];
    f.stop(); f.start(); f.reuse(id); f.arm('w', b); e.callback(); assert.equal(f.sources.has(id), true); assert.equal(f.actions.length, 0);
    f.tick(id); assert.deepEqual(f.actions, ['w']);
});
test('validation exceptions clean up without performing the action', () => {
    const f = fixture(), a = f.actor(); let fail = false;
    f.arm('w', a, () => f.actions.push('wrong'), () => { if (fail) throw new Error('validation'); return true; });
    fail = true; a.emit('first-frame'); assert.equal(a.handlers.size, 0); assert.equal(f.sources.size, 0); assert.equal(f.actions.length, 0);
});
test('completion or cancellation during fallback allocation cleans the returned ID', () => {
    const f = fixture(), a = f.actor(); f.flags.addHook = () => a.emit('first-frame'); f.arm('w', a);
    assert.deepEqual(f.actions, ['w']); assert.equal(f.sources.size, 0); assert.equal(a.handlers.size, 0);
});

function integration() {
    const f = fixture(), stored = new Map(), ids = new Map(), trace = [], pending = [];
    const a = f.actor(); let created = 0;
    const meta = { minimized: false, tilable: true, actor: a,
        get_stable_sequence: () => 9, get_compositor_private() { return this.actor; }, get_window_type: () => 0,
        get_monitor: () => 0, raise() { trace.push('raise'); this.raiseHook?.(); }, unminimize() { trace.push('unminimize'); } };
    class ShellWindow {
        constructor(entity, m) { this.entity = entity; this.meta = m; this.destroying = false; }
        actor_exists() { return !this.destroying && this.meta.get_compositor_private() !== null; }
        is_tilable() { return this.meta.tilable; }
        update_decoration() {} workspace_id() { return 0; }
        activate() { trace.push('activate'); }
        stop_ui_work() {} cancel_decoration() {}
    }
    let code = method('window_entity').replace('meta: Meta.Window | null', 'meta').replace(': Entity | null', '')
        .replace('let id: number', 'let id').replace('let window_app: any, name: string', 'let window_app, name')
        .replaceAll('(meta as any)', 'meta').replaceAll(': number | null', '')
        .replace('valid: () => boolean = () => true', 'valid = () => true');
    const owner = {
        events_enabled: true, event_generation: 0, init: false,
        ids: { find: predicate => [...ids].filter(([, id]) => predicate(id)).map(([e]) => e)[Symbol.iterator](), insert(e, id) { ids.set(e, id); } },
        names: { insert() {} }, monitors: { insert() {} }, create_entity: () => [created++, 0],
        windows: { insert(e, w) { stored.set(String(e), w); }, get: e => stored.get(String(e)) ?? null,
            with(e, cb) { const w = stored.get(String(e)); if (w) return cb(w); }, values: () => stored.values() },
        schedule_idle(cb) { const generation = this.event_generation; pending.push(() => {
            if (this.events_enabled && generation === this.event_generation) cb(); }); },
        stop_config_io() {}, extension_timers: { stop() {} },
        auto_tiler: { auto_tile() { trace.push('tile'); owner.tileHook?.(); } },
    };
    owner.first_frames = new FirstFrames(f.backend, () => owner.events_enabled, () => owner.event_generation, e => f.errors.push(e));
    Object.assign(owner, new Function('Window', 'GLib', `return ({ ${code}, ${method('stop_window_io')} });`)(
        { ShellWindow, window_tracker: { get_window_app: () => ({ get_name: () => 'App' }) } },
        { PRIORITY_DEFAULT: 0, SOURCE_REMOVE: false, timeout_add: (...args) => f.backend.add(...args), source_remove: id => f.backend.remove(id) }));
    const create = () => owner.window_entity(meta);
    return { ...f, owner, a, meta, trace, stored, pending, create,
        win: () => [...stored.values()][0], flush() { for (const cb of pending.splice(0)) cb(); },
        stop() { owner.events_enabled = false; owner.event_generation++; owner.stop_window_io(); },
        start() { owner.events_enabled = true; } };
}
test('production window creation tiles once on first-frame then focuses through idle', () => {
    const f = integration(); f.create(); f.a.emit('first-frame'); assert.deepEqual(f.trace, ['tile']); f.flush();
    assert.deepEqual(f.trace, ['tile', 'raise', 'unminimize', 'activate']); assert.equal(f.a.handlers.size, 0);
});
test('production fallback tiles and focuses without a frame signal', () => {
    const f = integration(); f.create(); const [id] = f.sources.keys(); f.tick(id); f.a.emit('first-frame'); f.flush();
    assert.deepEqual(f.trace, ['tile', 'raise', 'unminimize', 'activate']);
});
test('production stop removes pending frame work and cannot tile after reenable', () => {
    const f = integration(); f.create(); const frame = f.a.capture('first-frame'), timer = [...f.sources.values()][0].callback;
    f.stop(); f.start(); frame(); timer(); f.flush(); assert.deepEqual(f.trace, []); assert.equal(f.a.handlers.size, 0);
});
test('production frame cannot tile a replacement AutoTiler', () => {
    const f = integration(); f.create(); f.owner.auto_tiler = { auto_tile() { f.trace.push('wrong'); } };
    f.a.emit('first-frame'); f.flush(); assert.deepEqual(f.trace, []); assert.equal(f.sources.size, 0);
});
test('production frame cannot tile a replaced window component', () => {
    const f = integration(); const e = f.create(); f.stored.set(String(e), {}); f.a.emit('first-frame');
    assert.deepEqual(f.trace, []); assert.equal(f.a.handlers.size, 0);
});
test('production frame rejects a replaced compositor actor', () => {
    const f = integration(); f.create(); f.meta.actor = f.actor(); f.a.emit('first-frame'); assert.deepEqual(f.trace, []);
});
test('production actor destruction cancels fallback without tiling', () => {
    const f = integration(); f.create(); f.a.emit('destroy'); assert.equal(f.sources.size, 0); f.flush(); assert.deepEqual(f.trace, []);
});
test('minimized window at completion is not tiled or refocused', () => {
    const f = integration(); f.create(); f.meta.minimized = true; f.a.emit('first-frame'); f.flush(); assert.deepEqual(f.trace, []);
});
test('a window that became floating is not tiled by its old frame request', () => {
    const f = integration(); f.create(); f.meta.tilable = false; f.a.emit('first-frame'); assert.deepEqual(f.trace, []);
});
test('destroying a window after tiling suppresses its delayed focus', () => {
    const f = integration(); f.create(); f.a.emit('first-frame'); f.win().destroying = true; f.flush(); assert.deepEqual(f.trace, ['tile']);
});
test('AutoTiler replacement after tiling suppresses the old delayed focus', () => {
    const f = integration(); f.create(); f.a.emit('first-frame'); f.owner.auto_tiler = {}; f.flush(); assert.deepEqual(f.trace, ['tile']);
});
test('reentrant stop inside auto_tile prevents focus submission', () => {
    const f = integration(); f.create(); f.owner.tileHook = () => f.stop(); f.a.emit('first-frame');
    assert.deepEqual(f.trace, ['tile']); assert.equal(f.pending.length, 0);
});
test('destroy during raise prevents subsequent unminimize and activate calls', () => {
    const f = integration(); f.create(); f.a.emit('first-frame'); f.meta.raiseHook = () => { f.win().destroying = true; };
    f.flush(); assert.deepEqual(f.trace, ['tile', 'raise']);
});
test('non-tilable creation retains the existing idle-focus path', () => {
    const f = integration(); f.meta.tilable = false; f.create(); assert.equal(f.a.handlers.size, 0); assert.equal(f.sources.size, 0);
    f.flush(); assert.deepEqual(f.trace, ['raise', 'unminimize', 'activate']);
});
test('cached window lookup does not register a second first-frame job', () => {
    const f = integration(); const first = f.create(), second = f.create(); assert.deepEqual(first, second);
    assert.equal(f.sources.size, 1); assert.equal(f.a.handlers.size, 2);
});
