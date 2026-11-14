import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../src/extension.ts', import.meta.url), 'utf8');
function method(name) {
    const begin = source.indexOf('    ' + name + '(');
    const end = source.indexOf('\n    }', begin) + 6;
    assert.ok(begin >= 0 && end > begin, name);
    return source.slice(begin, end);
}
const lifecycle = source.slice(source.indexOf('    start_events() {'),
    source.indexOf('    /** Registers a generic callback')).replace('register(event: ExtEvent): void', 'register(event)');
const idle = method('schedule_idle').replace('func: () => boolean', 'func').replace(': boolean', '');
function timerFixture() {
    const sources = new Map(), removed = [], errors = [];
    let serial = 0, reused = null;
    const GLib = {
        PRIORITY_DEFAULT: 0,
        timeout_add(_priority, delay, callback) {
            assert.equal(delay, 100);
            const id = reused ?? ++serial; reused = null;
            assert.equal(sources.has(id), false); sources.set(id, callback); return id;
        },
        source_remove(id) { assert.equal(sources.delete(id), true); removed.push(id); }
    };
    const log = { log(error) { errors.push(error); } };
    class Base { register() {} }
    const Type = new Function('GLib', 'log', 'Base', `return class extends Base {
        events_enabled = true; event_generation = 0; idle_sources = new Map();
        event_executor = { stop() {} }; empty = false;
        movements = { is_empty: () => this.empty };
        ${lifecycle}
        ${idle}
    }`)(GLib, log, Base);
    const owner = new Type();
    const tick = id => {
        const callback = sources.get(id); assert.equal(typeof callback, 'function');
        const keep = callback();
        if (!keep && sources.get(id) === callback) sources.delete(id);
        return keep;
    };
    return { owner, sources, removed, errors, log, tick, reuse(id) { reused = id; } };
}

test('idle action runs immediately once when no movements are pending', () => {
    const f = timerFixture(); f.owner.empty = true; let calls = 0;
    assert.equal(f.owner.schedule_idle(() => { calls++; return true; }), false);
    assert.equal(calls, 1); assert.equal(f.sources.size, 0); assert.equal(f.owner.idle_sources.size, 0);
});

test('idle source waits for movement completion and drops ownership after a one-shot callback', () => {
    const f = timerFixture(); let calls = 0;
    f.owner.schedule_idle(() => { calls++; return false; });
    const [id] = f.sources.keys(); assert.equal(f.tick(id), true); assert.equal(calls, 0);
    f.owner.empty = true; assert.equal(f.tick(id), false);
    assert.equal(calls, 1); assert.equal(f.owner.idle_sources.size, 0); assert.equal(f.sources.size, 0);
});

test('true callback result retains the original delayed repeat behavior', () => {
    const f = timerFixture(); let calls = 0;
    f.owner.schedule_idle(() => ++calls < 2); f.owner.empty = true;
    const [id] = f.sources.keys(); assert.equal(f.tick(id), true); assert.equal(f.tick(id), false);
    assert.equal(calls, 2); assert.equal(f.owner.idle_sources.size, 0);
});

test('disabled instance schedules no source and performs no immediate action', () => {
    const f = timerFixture(); f.owner.stop_events(); f.owner.empty = true;
    f.owner.schedule_idle(() => { throw new Error('must not run'); });
    f.owner.empty = false; f.owner.schedule_idle(() => { throw new Error('must not run'); });
    assert.equal(f.sources.size, 0); assert.equal(f.errors.length, 0);
});

test('stop removes every owned idle source exactly once', () => {
    const f = timerFixture(); f.owner.schedule_idle(() => false); f.owner.schedule_idle(() => false);
    const ids = [...f.sources.keys()]; f.owner.stop_events(); f.owner.stop_events();
    assert.deepEqual(f.removed, ids); assert.equal(f.sources.size, 0); assert.equal(f.owner.idle_sources.size, 0);
});

test('an already-dispatched stale callback cannot run after stop', () => {
    const f = timerFixture(); let calls = 0; f.owner.schedule_idle(() => { calls++; return false; });
    const callback = [...f.sources.values()][0]; f.owner.stop_events(); f.owner.empty = true;
    assert.equal(callback(), false); assert.equal(calls, 0);
});

test('reenable does not revive an old callback', () => {
    const f = timerFixture(); let calls = 0; f.owner.schedule_idle(() => { calls++; return false; });
    const callback = [...f.sources.values()][0];
    f.owner.stop_events(); f.owner.start_events(); f.owner.empty = true;
    assert.equal(callback(), false); assert.equal(calls, 0);
});

test('reused numeric GLib ID cannot transfer ownership to an old callback', () => {
    const f = timerFixture(); let calls = 0;
    f.owner.schedule_idle(() => { throw new Error('old'); });
    const [id, callback] = [...f.sources][0]; f.owner.stop_events(); f.owner.start_events();
    f.reuse(id); f.owner.schedule_idle(() => { calls++; return false; }); f.owner.empty = true;
    assert.equal(callback(), false); assert.equal(f.owner.idle_sources.size, 1);
    f.tick(id); assert.equal(calls, 1); assert.equal(f.owner.idle_sources.size, 0);
});

test('stop and restart inside a repeating callback cannot restart its old source', () => {
    const f = timerFixture();
    f.owner.schedule_idle(() => { f.owner.stop_events(); f.owner.start_events(); return true; });
    f.owner.empty = true; const [id] = f.sources.keys();
    assert.equal(f.tick(id), false); assert.equal(f.owner.idle_sources.size, 0); assert.equal(f.sources.size, 0);
});

test('a reentrant replacement with the same ID survives old callback completion', () => {
    const f = timerFixture(); let calls = 0; let id;
    f.owner.schedule_idle(() => {
        f.owner.stop_events(); f.owner.start_events(); f.owner.empty = false;
        f.reuse(id); f.owner.schedule_idle(() => { calls++; return false; });
        return true;
    });
    [id] = f.sources.keys(); f.owner.empty = true;
    assert.equal(f.tick(id), false); assert.equal(f.owner.idle_sources.size, 1);
    f.owner.empty = true; f.tick(id); assert.equal(calls, 1); assert.equal(f.owner.idle_sources.size, 0);
});

test('callback failure stops the source and releases ownership', () => {
    const f = timerFixture(); f.owner.schedule_idle(() => { throw new Error('callback failure'); });
    f.owner.empty = true; const [id] = f.sources.keys();
    assert.equal(f.tick(id), false); assert.equal(f.owner.idle_sources.size, 0);
    assert.match(f.errors[0], /callback failure/);
});

test('unavailable logger cannot prevent idle source cleanup', () => {
    const f = timerFixture(); f.log.log = () => { throw new Error('logger unavailable'); };
    f.owner.schedule_idle(() => { throw new Error('failure'); }); f.owner.empty = true;
    const [id] = f.sources.keys(); assert.equal(f.tick(id), false); assert.equal(f.owner.idle_sources.size, 0);
});

test('immediate callback errors are contained without creating a source', () => {
    const f = timerFixture(); f.owner.empty = true;
    f.owner.schedule_idle(() => { throw new Error('immediate failure'); });
    assert.match(f.errors[0], /immediate failure/); assert.equal(f.sources.size, 0);
});

test('stop leaves unrelated GLib sources alone', () => {
    const f = timerFixture(); f.owner.schedule_idle(() => false);
    const foreign = () => true; f.sources.set(999, foreign); f.owner.stop_events();
    assert.deepEqual([...f.sources], [[999, foreign]]);
});

const attachStart = source.indexOf('    signals_attach() {');
const modeStart = source.indexOf('        if (this.settings.tile_by_default() && !this.auto_tiler) {', attachStart);
const modeEnd = source.indexOf('        // Post-init', modeStart);
assert.ok(modeStart >= 0 && modeEnd > modeStart);
const mode = source.slice(modeStart, modeEnd).replace('this.register_storage<Entity>()', 'this.register_storage()');
const startupStart = source.indexOf('export default class PopShellExtension');
const cleanupStart = source.indexOf('            if (ext.auto_tiler) {', source.indexOf('    disable() {', startupStart));
const cleanupEnd = source.indexOf('\n            }', cleanupStart) + '\n            }'.length;
assert.ok(cleanupStart >= 0 && cleanupEnd > cleanupStart);
const cleanup = new Function('ext', source.slice(cleanupStart, cleanupEnd));
function tilerFixture(windows = []) {
    const stores = new Set(), constructed = [], destroyed = [], tiled = [], queue = [];
    class Forest { connect_on_attach() { return this; } connect_on_detach() { return this; } }
    class AutoTiler {
        constructor(forest, attached) { this.forest = forest; this.attached = attached; constructed.push(this); }
        auto_tile(owner, window) { assert.strictEqual(owner.auto_tiler, this); tiled.push(window); }
        destroy() { assert.equal(stores.has(this.attached), false); destroyed.push(this); }
    }
    const methods = new Function('auto_tiler', 'Forest', 'indicator', `return {
        ${method('auto_tile_on')},
        ${method('auto_tile_off')}
    };`)({ AutoTiler }, { Forest }, null);
    const owner = {
        auto_tiler: null, settings: { tile_by_default: () => true,
            set_edge_tiling() {}, set_tile_by_default() {}, active_hint: () => false },
        register_storage() { const storage = {}; stores.add(storage); return storage; },
        unregister_storage(storage) { assert.equal(stores.delete(storage), true); },
        active_workspace: () => 0, hide_all_borders() {}, show_border_on_focused() {},
        on_tile_attach() {}, on_tile_detach() {}, button: { icon: {} },
        windows: { values: () => windows }, register_fn(fn) { queue.push(fn); }, switch_to_workspace() {},
        ...methods
    };
    const initializeMode = new Function('auto_tiler', 'Forest', mode).bind(owner, { AutoTiler }, { Forest });
    return { owner, stores, constructed, destroyed, tiled, initializeMode, cleanup: () => cleanup(owner) };
}

test('startup mode initialization and auto_tile_on share one tiler and one storage', () => {
    const f = tilerFixture(); f.initializeMode(); const original = f.owner.auto_tiler; f.owner.auto_tile_on();
    assert.strictEqual(f.owner.auto_tiler, original); assert.equal(f.constructed.length, 1); assert.equal(f.stores.size, 1);
});

test('auto_tile_on still creates a tiler when none exists', () => {
    const f = tilerFixture(); f.owner.auto_tile_on(); assert.equal(f.constructed.length, 1); assert.equal(f.stores.size, 1);
});

test('repeated auto_tile_on does not replace an active tiler', () => {
    const f = tilerFixture(); f.owner.auto_tile_on(); const original = f.owner.auto_tiler;
    f.owner.auto_tile_on(); assert.strictEqual(f.owner.auto_tiler, original); assert.equal(f.constructed.length, 1);
});

test('manual auto_tile_off releases its storage and destroys the tiler once', () => {
    const f = tilerFixture(); f.owner.auto_tile_on(); f.owner.auto_tile_off(); f.owner.auto_tile_off();
    assert.equal(f.stores.size, 0); assert.equal(f.destroyed.length, 1); assert.equal(f.owner.auto_tiler, null);
});

test('regular extension teardown deregisters storage before destroying the tiler', () => {
    const f = tilerFixture(); f.initializeMode(); f.owner.auto_tile_on(); f.cleanup(); f.cleanup();
    assert.equal(f.stores.size, 0); assert.equal(f.destroyed.length, 1); assert.equal(f.owner.auto_tiler, null);
});

test('twenty start/disable cycles leave no registered tiler storages behind', () => {
    const f = tilerFixture();
    for (let i = 0; i < 20; i++) {
        f.initializeMode(); f.owner.auto_tile_on(); assert.equal(f.stores.size, 1); f.cleanup(); assert.equal(f.stores.size, 0);
    }
    assert.equal(f.constructed.length, 20); assert.equal(f.destroyed.length, 20);
});

test('tiling still skips floating, minimized and actorless windows', () => {
    const window = (tilable, minimized, actor) => ({ is_tilable: () => tilable,
        meta: { minimized, get_compositor_private: () => actor } });
    const valid = window(true, false, {});
    const f = tilerFixture([valid, window(false, false, {}), window(true, true, {}), window(true, false, null)]);
    f.initializeMode(); f.owner.auto_tile_on(); assert.deepEqual(f.tiled, [valid]);
});
