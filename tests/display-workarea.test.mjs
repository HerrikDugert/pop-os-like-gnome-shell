import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ExtensionTimers } from '../target/extension_timers.js';
const source = readFileSync(new URL('../src/extension.ts', import.meta.url), 'utf8');
function method(name) {
    const start = source.indexOf('    ' + name + '('); assert.ok(start >= 0, name);
    return source.slice(start, source.indexOf('\n    }', start) + 6);
}
function erase(text) {
    return text.replace(/        type Migration = .*;\n/, '')
        .replaceAll('new exec.OnceExecutor<Migration, Migration[]>', 'new exec.OnceExecutor')
        .replaceAll('new Map<number, number>()', 'new Map()')
        .replaceAll('new Set<number>()', 'new Set()')
        .replaceAll('migration: null | [Fork, number, Rectangle, boolean]', 'migration')
        .replaceAll(': Array<Migration>', '').replaceAll(': Set<number>', '')
        .replaceAll(': Ecs.Entity', '').replaceAll(': Ext', '').replaceAll(': boolean', '')
        .replaceAll('monitor as Monitor', 'monitor');
}
function fixture() {
    const sources = new Map(), removed = [], queue = [], calls = [], errors = [], trace = [];
    let serial = 0, reused = null;
    const env = { ready: false, locked: false, removeError: false, enqueueError: false,
        monitors: [{ index: 0, x: 0, y: 0, width: 1920, height: 1080 }] };
    const backend = {
        add(priority, delay, callback) {
            const id = reused ?? ++serial; reused = null; assert.equal(sources.has(id), false);
            sources.set(id, { priority, delay, callback }); return id;
        },
        remove(id) { assert.equal(sources.delete(id), true, `invalid remove ${id}`); removed.push(id);
            if (env.removeError) throw new Error('remove failed'); },
    };
    class Rectangle {
        constructor([x, y, width, height]) { Object.assign(this, { x, y, width, height }); }
        clone() { return new Rectangle([this.x, this.y, this.width, this.height]); }
    }
    const owner = {
        events_enabled: true, event_generation: 0, ignore_display_update: false,
        workareas_request: null, workareas_update: null, displays_updating: null,
        auto_tiler: { forest: { forks: new Map(), iter: () => [] } },
        displays: [0, new Map([[0, { area: new Rectangle([0, 0, 1920, 1080]), ws: new Rectangle([0, 0, 1920, 1040]) }]])],
        windows: { iter: () => [], values: () => [] }, monitors: { with() {} },
        monitor_work_area: () => new Rectangle([0, 0, 1920, 1040]), settings: { smart_gaps: () => false },
        stop_config_io() { trace.push('config'); }, first_frames: { stop() { trace.push('frames'); } },
        register_fn(callback) { if (env.enqueueError) throw new Error('enqueue failed'); queue.push(callback); },
    };
    owner.extension_timers = new ExtensionTimers(backend, () => owner.events_enabled,
        () => owner.event_generation, e => errors.push(e));
    const global = { display: { get_primary_monitor: () => 0, get_n_monitors: () => env.monitors.length,
        get_monitor_geometry: () => new Rectangle([0, 0, env.ready ? 1920 : 0, 1080]) } };
    const layoutManager = { get monitors() { return env.monitors; } };
    const sessionMode = { get isLocked() { return env.locked; } };
    const code = erase(method('update_display_configuration')) + ',\n' + method('stop_window_io');
    const methods = new Function('GLib', 'global', 'layoutManager', 'sessionMode', 'Rect', 'utils', 'exec', 'node', `return ({ ${code} });`)(
        { PRIORITY_DEFAULT: 0, timeout_add: (...args) => backend.add(...args), source_remove: id => backend.remove(id) },
        global, layoutManager, sessionMode, { Rectangle }, { map_eq: () => false },
        { OnceExecutor: class { start() { throw new Error('legacy migration execution is outside this suite'); } } }, { NodeKind: { WINDOW: 2 } });
    owner.stop_window_io = methods.stop_window_io;
    owner.update_display_configuration = function(value) { calls.push(value); return methods.update_display_configuration.call(this, value); };
    function tick(id) {
        const entry = sources.get(id); assert.ok(entry, `missing ${id}`); const keep = entry.callback();
        if (!keep && sources.get(id) === entry) sources.delete(id); return keep;
    }
    const retry = () => [...sources].find(([, e]) => e.delay === 500)?.[0];
    return { owner, sources, removed, queue, calls, errors, env, trace, tick, retry,
        update(value = true) { owner.update_display_configuration(value); },
        runQueue() { const callback = queue.shift(); assert.ok(callback); callback(); },
        stop() { owner.events_enabled = false; owner.event_generation++; owner.stop_window_io(); },
        start() { owner.events_enabled = true; }, reuse(id) { reused = id; } };
}

test('unready workareas create one owned 500ms retry', () => {
    const f = fixture(); f.update(false); assert.equal(f.sources.size, 1); assert.equal(f.owner.extension_timers.size, 1);
    const e = f.sources.get(f.retry()); assert.equal(e.delay, 500); assert.equal(e.priority, 0); assert.equal(f.queue.length, 0);
});
test('repeated requests replace the retry and reject a dispatched older callback', () => {
    const f = fixture(); f.update(); const old = f.sources.get(f.retry()).callback; f.update(false); const id = f.retry();
    assert.equal(old(), false); assert.equal(f.sources.has(id), true); assert.equal(f.queue.length, 0); assert.equal(f.sources.size, 1);
});
test('expiry queues one guarded update, preserving the workareas-only argument', () => {
    const f = fixture(); f.update(false); assert.equal(f.tick(f.retry()), false);
    assert.equal(f.sources.size, 0); assert.equal(f.owner.extension_timers.size, 0); assert.equal(f.queue.length, 1);
    f.runQueue(); assert.deepEqual(f.calls, [false, false]); assert.equal(f.sources.size, 1);
});
test('stop removes the retry and a captured callback stays revoked after restart', () => {
    const f = fixture(); f.update(); const old = f.sources.get(f.retry()).callback; f.stop(); f.start(); old();
    assert.equal(f.sources.size, 0); assert.equal(f.queue.length, 0); assert.equal(f.owner.workareas_request, null);
});
test('an already queued retry cannot resume after disable and reenable', () => {
    const f = fixture(); f.update(); f.tick(f.retry()); f.stop(); f.start(); f.runQueue();
    assert.equal(f.calls.length, 1); assert.equal(f.sources.size, 0);
});
test('a newer request invalidates an older queued continuation in the same activation', () => {
    const f = fixture(); f.update(); f.tick(f.retry()); f.update(false); const id = f.retry(); f.runQueue();
    assert.deepEqual(f.calls, [true, false]); assert.equal(f.sources.has(id), true);
});
test('ready geometry also invalidates older queued retry work', () => {
    const f = fixture(); f.update(); f.tick(f.retry()); f.env.ready = true; f.update(); f.runQueue();
    assert.equal(f.calls.length, 2); assert.equal(f.sources.size, 0);
});
test('AutoTiler replacement before expiry prevents enqueueing', () => {
    const f = fixture(); f.update(); f.owner.auto_tiler = { forest: { forks: new Map() } }; f.tick(f.retry());
    assert.equal(f.queue.length, 0); assert.equal(f.owner.extension_timers.size, 0);
});
test('forest replacement inside the same AutoTiler prevents enqueueing', () => {
    const f = fixture(); f.update(); f.owner.auto_tiler.forest = { forks: new Map() }; f.tick(f.retry()); assert.equal(f.queue.length, 0);
});
test('AutoTiler replacement after enqueueing suppresses the queued update', () => {
    const f = fixture(); f.update(); f.tick(f.retry()); f.owner.auto_tiler = { forest: {} }; f.runQueue(); assert.equal(f.calls.length, 1);
});
test('forest replacement after enqueueing suppresses the queued update', () => {
    const f = fixture(); f.update(); f.tick(f.retry()); f.owner.auto_tiler.forest = {}; f.runQueue(); assert.equal(f.calls.length, 1);
});
test('locked session at dispatch prevents the retry from enqueueing', () => {
    const f = fixture(); f.update(); f.env.locked = true; f.tick(f.retry()); assert.equal(f.queue.length, 0);
});
test('locked session at queue execution suppresses the continuation', () => {
    const f = fixture(); f.update(); f.tick(f.retry()); f.env.locked = true; f.runQueue(); assert.equal(f.calls.length, 1);
});
test('inactive extension creates no retry', () => {
    const f = fixture(); f.owner.events_enabled = false; f.update(); assert.equal(f.sources.size, 0);
});
test('an explicit update while locked revokes the existing retry', () => {
    const f = fixture(); f.update(); const old = f.sources.get(f.retry()).callback; f.env.locked = true; f.update(); f.env.locked = false;
    old(); assert.equal(f.queue.length, 0); assert.equal(f.sources.size, 0);
});
test('an explicit update without a tiler revokes the existing retry', () => {
    const f = fixture(); f.update(); f.owner.auto_tiler = null; f.update(); assert.equal(f.sources.size, 0);
});
test('zero monitors invalidate pending and queued retry work', () => {
    const f = fixture(); f.update(); f.tick(f.retry()); f.env.monitors = []; f.update(); f.runQueue();
    assert.equal(f.calls.length, 2); assert.equal(f.sources.size, 0);
});
test('zero monitors before dispatch prevent enqueueing', () => {
    const f = fixture(); f.update(); f.env.monitors = []; f.tick(f.retry()); assert.equal(f.queue.length, 0);
});
test('the existing pending-migration readiness gate does not allocate a retry', () => {
    const f = fixture(); f.owner.displays_updating = 999; f.update();
    assert.equal(f.sources.size, 0); assert.equal(f.queue.length, 0); assert.deepEqual(f.removed, []);
});
test('ready geometry cancels a pending retry without removing an expired ID', () => {
    const f = fixture(); f.update(); f.env.ready = true; f.update(); f.stop();
    assert.equal(f.sources.size, 0); assert.equal(f.removed.length, 1); assert.deepEqual(f.errors, []);
});
test('replacing the workarea retry leaves a different managed timer untouched', () => {
    const f = fixture(); f.owner.extension_timers.schedule('other', 0, 3000, () => true); const [other] = f.sources.keys();
    f.update(); f.update(); assert.equal(f.sources.has(other), true); assert.equal(f.removed.includes(other), false);
});
test('numeric source ID reuse cannot give the old retry ownership of its replacement', () => {
    const f = fixture(); f.update(); const id = f.retry(), old = f.sources.get(id).callback;
    f.stop(); f.start(); f.reuse(id); f.update(); old(); assert.equal(f.sources.has(id), true); assert.equal(f.queue.length, 0);
    f.tick(id); assert.equal(f.queue.length, 1);
});
test('a queued continuation invoked twice cannot create two successor retries', () => {
    const f = fixture(); f.update(); f.tick(f.retry()); const callback = f.queue.shift(); callback(); callback();
    assert.equal(f.calls.length, 2); assert.equal(f.sources.size, 1);
});
test('enqueue failures are contained by the managed timer', () => {
    const f = fixture(); f.update(); f.env.enqueueError = true; assert.doesNotThrow(() => f.tick(f.retry()));
    assert.equal(f.owner.extension_timers.size, 0); assert.equal(f.sources.size, 0); assert.equal(f.errors.length, 1);
});
test('generation change invalidates an expired queued retry even without explicit cleanup', () => {
    const f = fixture(); f.update(); f.tick(f.retry()); f.owner.event_generation++; f.runQueue(); assert.equal(f.calls.length, 1);
});
test('generation change invalidates a native retry even without explicit cleanup', () => {
    const f = fixture(); f.update(); f.owner.event_generation++; f.tick(f.retry()); assert.equal(f.queue.length, 0);
});
test('the existing ignore-once workspace event preserves a legitimate pending retry', () => {
    const f = fixture(); f.update(); const id = f.retry(); f.owner.ignore_display_update = true; f.update(false);
    assert.equal(f.owner.ignore_display_update, false); assert.equal(f.sources.has(id), true); f.tick(id); assert.equal(f.queue.length, 1);
});
test('ready topology-change scheduling stays outside this retry-only patch', () => {
    const f = fixture(); f.env.ready = true; f.owner.displays = [0, new Map()]; f.update();
    assert.equal(f.retry(), undefined); assert.equal([...f.sources.values()][0].delay, 2000);
    assert.equal(f.owner.extension_timers.size, 0);
});
