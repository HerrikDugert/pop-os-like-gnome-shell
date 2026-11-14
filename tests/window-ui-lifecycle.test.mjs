import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const source = readFileSync(new URL('../src/window.ts', import.meta.url), 'utf8');
const extension = readFileSync(new URL('../src/extension.ts', import.meta.url), 'utf8');
function method(text, name) {
    const match = new RegExp('^    (?:private )?' + name + '\\(', 'm').exec(text);
    if (!match) return '';
    return text.slice(match.index, text.indexOf('\n    }', match.index) + 6);
}
function helper(name) {
    const start = source.indexOf('function ' + name + '(');
    return start < 0 ? '' : source.slice(start, source.indexOf('\n}', start) + 2);
}
function erase(text) {
    return text.replaceAll('private ', '')
        .replaceAll(': RESTACK_STATE', '')
        .replace(/: (WindowUIRequest|number|unknown|boolean|void)(?=[,)= {])/g, '');
}
function fixture() {
    const sources = new Map(), removed = [], layers = [], errors = [], windows = new Map();
    let serial = 0, reused = null, enabled = true, generation = 0, focused = null;
    const flags = { addError: false, removeError: false };
    const GLib = {
        PRIORITY_DEFAULT: 0, PRIORITY_LOW: 300, SOURCE_REMOVE: false, SOURCE_CONTINUE: true,
        timeout_add(_priority, delay, callback) {
            if (flags.addError) throw new Error('add failed');
            const id = reused ?? ++serial; reused = null;
            assert.equal(sources.has(id), false); sources.set(id, { delay, callback }); return id;
        },
        source_remove(id) {
            assert.equal(sources.delete(id), true, `invalid source removal ${id}`); removed.push(id);
            if (flags.removeError) throw new Error('remove failed'); return true;
        },
    };
    const log = { log(error) { errors.push(error); } };
    const group = { set_child_above_sibling(border) { layers.push(border); },
        set_child_below_sibling(border) { layers.push(border); } };
    const methods = ['restack', 'show_border', 'hide_border', 'ui_current', 'stop_ui_work']
        .map(name => method(source, name)).filter(Boolean).map(erase).join(',\n');
    const methodsObject = new Function('GLib', 'global', 'log', 'RESTACK_STATE', 'RESTACK_SPEED', `
        'use strict'; let SCHEDULED_RESTACK = null, ACTIVE_HINT_SHOW_ID = null;
        ${erase(helper('report_ui_error'))}
        ${erase(helper('cancel_ui_source'))}
        return { ${methods} };
    `)(GLib, { window_group: group }, log, { RAISED: 0, WORKSPACE_CHANGED: 1, NORMAL: 2 },
        { RAISED: 430, WORKSPACE_CHANGED: 300, NORMAL: 200 });
    const ext = {
        allows_window_io: () => enabled, window_io_generation: () => generation,
        settings: { active_hint: () => true, active_hint_show_on_maximized: () => true },
        active_window_list: () => [...windows.values()], focus_window: () => focused,
        windows: { values: () => windows.values(), get: entity => windows.get(String(entity)) ?? null },
    };
    let slot = 0;
    function addWindow(mapped = true) {
        const actor = { get_parent: () => group };
        const border = { visible: false, show() { this.visible = true; },
            hide() { this.visible = false; }, get_parent: () => group };
        const owner = {
            entity: [slot++, 0], ext, border, destroying: false,
            meta: { minimized: false, is_fullscreen: () => false, get_monitor: () => 0,
                get_compositor_private: () => actor, get_transient_for: () => null },
            actor_exists() { return !this.destroying && this.meta.get_compositor_private() !== null; },
            same_workspace: () => true, is_snap_edge: () => false, always_top_windows: [],
            update_border_layout() {}, update_border_style() {}, ...methodsObject,
        };
        if (mapped) windows.set(String(owner.entity), owner);
        focused ??= owner; return owner;
    }
    function tick(id) {
        const entry = sources.get(id); assert.ok(entry, `Missing source ${id}`);
        const keep = entry.callback();
        if (!keep && sources.get(id) === entry) sources.delete(id);
        return keep;
    }
    const hintId = () => [...sources].find(([, e]) => e.delay === 600)?.[0];
    return { addWindow, sources, removed, layers, errors, windows, ext, log, flags, tick, hintId,
        stop(cleanup = true) { enabled = false; generation++; if (cleanup) for (const w of windows.values()) w.stop_ui_work(); },
        start() { enabled = true; }, focus(w) { focused = w; }, reuse(id) { reused = id; } };
}

test('destroying window stops restack without touching the layer tree', () => {
    const f = fixture(), w = f.addWindow(); w.restack(); const [id] = f.sources.keys(); w.destroying = true;
    assert.equal(f.tick(id), false); assert.equal(f.layers.length, 0);
});
test('restack rejects a stopped activation even before explicit cleanup', () => {
    const f = fixture(), w = f.addWindow(); w.restack(); const [id] = f.sources.keys(); f.stop(false);
    assert.equal(f.tick(id), false); assert.equal(f.layers.length, 0);
});
test('hint cannot show a hidden border after activation stop', () => {
    const f = fixture(), w = f.addWindow(); w.show_border(); const cb = f.sources.get(f.hintId()).callback;
    f.stop(false); w.hide_border(); assert.equal(cb(), false); assert.equal(w.border.visible, false);
});
test('dispatched old restack cannot cancel a replacement on its fourth tick', () => {
    const f = fixture(), a = f.addWindow(), b = f.addWindow(); a.restack();
    const [id, entry] = [...f.sources][0]; f.tick(id); f.tick(id); f.tick(id); b.restack();
    const [next] = f.sources.keys(); f.layers.length = 0;
    assert.equal(entry.callback(), false); assert.equal(f.sources.has(next), true); assert.equal(f.layers.length, 0);
});
test('live restack performs exactly four ticks and releases its expired source', () => {
    const f = fixture(), w = f.addWindow(); w.restack(); const [id] = f.sources.keys();
    assert.deepEqual([f.tick(id), f.tick(id), f.tick(id), f.tick(id)], [true, true, true, false]);
    assert.equal(f.layers.length, 4); assert.equal(f.sources.size, 0); w.stop_ui_work(); assert.deepEqual(f.removed, []); assert.equal(f.errors.length, 0);
});
test('live focused hint retains its existing repeat behavior', () => {
    const f = fixture(), w = f.addWindow(); w.show_border(); const id = f.hintId();
    assert.equal(f.tick(id), true); assert.equal(w.border.visible, true);
});
test('regular cleanup removes both sources once and rejects captured callbacks after restart', () => {
    const f = fixture(), w = f.addWindow(); w.show_border(); const callbacks = [...f.sources.values()].map(e => e.callback);
    f.stop(); f.stop(); assert.equal(f.sources.size, 0); assert.equal(f.removed.length, 2); f.start(); f.layers.length = 0;
    w.border.visible = false; for (const cb of callbacks) assert.equal(cb(), false);
    assert.equal(f.layers.length, 0); assert.equal(w.border.visible, false);
});
test('an unmapped constructor request works after its window is inserted', () => {
    const f = fixture(), w = f.addWindow(false); w.restack(); const [id] = f.sources.keys();
    f.windows.set(String(w.entity), w); assert.equal(f.tick(id), true); assert.equal(f.layers.length, 1);
});
test('activation generation rejects constructor work across stop/restart before insertion', () => {
    const f = fixture(), w = f.addWindow(false); w.restack(); const [id] = f.sources.keys();
    f.stop(); f.start(); f.windows.set(String(w.entity), w);
    assert.equal(f.tick(id), false); assert.equal(f.layers.length, 0);
});
test('numeric source reuse cannot make an old request own the new source', () => {
    const f = fixture(), w = f.addWindow(); w.restack(); const [id, entry] = [...f.sources][0];
    f.stop(); f.start(); f.reuse(id); w.restack();
    assert.equal(entry.callback(), false); assert.equal(f.sources.has(id), true); assert.equal(f.tick(id), true);
});
test('old hint cannot erase or show over a replacement hint', () => {
    const f = fixture(), a = f.addWindow(), b = f.addWindow(); a.show_border(); const old = f.sources.get(f.hintId()).callback;
    f.focus(b); b.show_border(); const next = f.hintId(); a.border.visible = false;
    assert.equal(old(), false); assert.equal(f.sources.has(next), true); assert.equal(a.border.visible, false);
});
test('hiding a previous window does not cancel the current window hint', () => {
    const f = fixture(), a = f.addWindow(), b = f.addWindow(); b.show_border(); f.focus(b); b.show_border();
    const next = f.hintId(); a.hide_border(); a.stop_ui_work(); assert.equal(f.sources.has(next), true);
});
test('hide cancels only its hint, not its pending restack', () => {
    const f = fixture(), w = f.addWindow(); w.show_border(); w.hide_border();
    assert.equal(f.hintId(), undefined); assert.equal(f.sources.size, 1); assert.equal(w.border.visible, false);
});
test('replacing the registered window invalidates callbacks while its actor still exists', () => {
    const f = fixture(), w = f.addWindow(); w.restack(); const [id] = f.sources.keys();
    f.windows.set(String(w.entity), {}); assert.equal(f.tick(id), false); assert.equal(f.layers.length, 0);
});
test('replacing the border invalidates an already captured hint', () => {
    const f = fixture(), w = f.addWindow(); w.show_border(); const id = f.hintId(), border = w.border;
    w.border = {}; border.visible = false; assert.equal(f.tick(id), false); assert.equal(border.visible, false);
});
test('callback errors release restack ownership even if logging fails', () => {
    const f = fixture(), w = f.addWindow(); w.restack(); const [id] = f.sources.keys();
    w.update_border_layout = () => { throw new Error('layout failed'); }; f.log.log = () => { throw new Error('logger failed'); };
    assert.equal(f.tick(id), false); w.stop_ui_work(); assert.equal(f.sources.size, 0);
});
test('hint show errors terminate their source and release ownership', () => {
    const f = fixture(), w = f.addWindow(); w.show_border(); const id = f.hintId();
    w.border.show = () => { throw new Error('show failed'); };
    assert.equal(f.tick(id), false); assert.equal(f.errors.length, 1); w.stop_ui_work(); assert.equal(f.sources.size, 0);
});
test('failed source creation leaves no ownership referring to a nonexistent source', () => {
    const f = fixture(), w = f.addWindow(); f.flags.addError = true; w.restack(); w.show_border();
    assert.equal(f.sources.size, 0); assert.doesNotThrow(() => w.stop_ui_work()); assert.deepEqual(f.removed, []);
});
test('cleanup errors cannot preserve callback ownership or interrupt cleanup', () => {
    const f = fixture(), w = f.addWindow(); w.show_border(); const callbacks = [...f.sources.values()].map(e => e.callback);
    f.flags.removeError = true; f.log.log = () => { throw new Error('logger failed'); }; assert.doesNotThrow(() => f.stop());
    assert.equal(f.removed.length, 2); f.start(); for (const cb of callbacks) assert.equal(cb(), false);
});
test('reentrant restack replacement survives completion of the old callback', () => {
    const f = fixture(), w = f.addWindow(); w.restack(); const [id] = f.sources.keys(); let replace = true;
    w.update_border_layout = () => { if (replace) { replace = false; w.restack(); } };
    assert.equal(f.tick(id), false); assert.equal(f.sources.size, 1);
    const [next] = f.sources.keys(); assert.notEqual(next, id); assert.equal(f.tick(next), true);
});
test('reentrant hint replacement is not cleared by its old callback', () => {
    const f = fixture(), w = f.addWindow(); w.show_border(); const old = f.hintId(); let replace = true;
    w.border.show = () => { if (replace) { replace = false; w.show_border(); } };
    assert.equal(f.tick(old), false); const next = f.hintId(); assert.notEqual(next, old); assert.equal(f.tick(next), true);
});
test('inactive owners create neither hint nor restack sources', () => {
    const f = fixture(), w = f.addWindow(); f.stop(); w.restack(); w.show_border(); assert.equal(f.sources.size, 0);
});
test('turning the hint setting off terminates an existing hint', () => {
    const f = fixture(), w = f.addWindow(); w.show_border(); const id = f.hintId(); f.ext.settings.active_hint = () => false;
    assert.equal(f.tick(id), false);
});
test('regular window-I/O teardown calls UI cleanup before decoration cleanup', () => {
    const body = method(extension, 'stop_window_io'); const trace = [];
    const owner = { first_frames: { stop() { trace.push('frames'); } }, extension_timers: { stop() { trace.push('timers'); } }, stop_config_io() { trace.push('config'); }, windows: { values: () => [{
        stop_ui_work() { trace.push('ui'); }, cancel_decoration() { trace.push('decoration'); } }] } };
    new Function(`return ({ ${erase(body)} });`)().stop_window_io.call(owner);
    assert.deepEqual(trace, ['config', 'timers', 'frames', 'ui', 'decoration']);
});
test('window destruction revokes UI work before decoration cleanup', () => {
    assert.match(method(extension, 'on_destroy'), /window.destroying = true;\s*this.extension_timers.cancel\(window.meta\);\s*window.stop_ui_work\(\);\s*window.cancel_decoration\(\);/);
});
test('window-I/O generation accessor returns the stopped event owner generation', () => {
    const code = erase(method(extension, 'window_io_generation'));
    assert.ok(code); const api = new Function(`return ({ ${code} });`)();
    assert.equal(api.window_io_generation.call({ event_generation: 7 }), 7);
});

test('reentrant stop during layout prevents the next layer mutation', () => {
    const f = fixture(), w = f.addWindow(); w.restack(); const [id] = f.sources.keys();
    w.update_border_layout = () => f.stop();
    assert.equal(f.tick(id), false); assert.equal(f.layers.length, 0);
});

test('old hint remains revoked when its numeric ID is reused after restart', () => {
    const f = fixture(), w = f.addWindow(); w.show_border(); const oldId = f.hintId();
    const old = f.sources.get(oldId).callback; f.stop(); f.start(); f.reuse(oldId); w.show_border();
    const current = f.hintId(), ids = [...f.sources.keys()];
    assert.equal(old(), false); assert.deepEqual([...f.sources.keys()], ids); assert.equal(f.tick(current), true);
});
test('disable and restart during initial border.show cannot replace the new activation hint', () => {
    const f = fixture(), w = f.addWindow(); let change = true;
    w.border.show = () => { if (change) { change = false; f.stop(); f.start(); w.show_border(); } };
    w.show_border(); assert.equal(f.sources.size, 2); assert.equal(f.tick(f.hintId()), true);
});
