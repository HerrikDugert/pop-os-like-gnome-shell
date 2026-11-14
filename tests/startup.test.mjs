import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../src/extension.ts', import.meta.url), 'utf8');
const begin = source.indexOf('let ext: Ext | null = null;');
const end = source.indexOf('const handler = windowAttentionHandler;', begin);
assert.ok(begin >= 0 && end > begin);
let code = source.slice(begin, end)
    .replace(/declare global \{[\s\S]*?\}\s*/, '')
    .replace('export default class', 'class')
    .replace('private async ', 'async ').replace('private finish_enable', 'finish_enable');
for (const annotation of [': Ext | null', ': Indicator | null', ': Promise<void>',
    ': Ext', ': number', ': any', ': void']) code = code.replaceAll(annotation, '');

function fixture(options = {}) {
    const trace = [], reads = [], tokens = [], messages = [], instances = [];
    const global = {};
    const session = { isLocked: false };
    const record = name => () => trace.push(name);
    class Token {
        cancelled = false;
        cancels = 0;
        constructor() { tokens.push(this); }
        cancel() { this.cancelled = true; this.cancels++; }
        is_cancelled() { return this.cancelled; }
    }
    class FakeExt {
        constructor() {
            instances.push(this);
            this.was_locked = false;
            this.auto_tiler = null;
            this.overlay = {};
            this.current_style = 0;
            this.events_enabled = true;
            this.invalidations = 0;
            this.callbacks = [];
            this.conf = {
                invalidate_load: () => { this.invalidations++; },
                reload_async: token => new Promise((resolve, reject) => reads.push({ token, resolve, reject }))
            };
            this.settings = {
                show_skiptaskbar: () => Boolean(options.skip),
                tile_by_default: () => options.tile !== false
            };
            this.dbus = { start: record('dbus.start'), destroy: record('dbus.destroy') };
            this.keybindings = {
                global: 'global', window_focus: 'focus',
                enable(name) { trace.push('keys.enable.' + name); return this; },
                disable(name) { trace.push('keys.disable.' + name); return this; }
            };
        }
        register_fn(callback) { this.callbacks.push(callback); }
        start_events() { this.events_enabled = true; trace.push('events.start'); }
        stop_events() { this.events_enabled = false; this.callbacks = []; trace.push('events.stop'); }
        injections_add() { trace.push('injections.add'); }
        injections_remove() { trace.push('injections.remove'); }
        signals_attach() { trace.push('signals.attach'); if (options.failSignals) throw new Error('signal setup failed'); }
        signals_remove() { trace.push('signals.remove'); }
        refresh_window_decorations() { trace.push('decorations.refresh'); }
        stop_window_io() { trace.push('io.stop'); }
        stop_exception_dialog() { trace.push('dialog.stop'); }
        exit_modes() { trace.push('modes.exit'); }
        hide_all_borders() { trace.push('borders.hide'); }
        snap_windows() { trace.push('windows.snap'); }
        unregister_storage(storage) { assert.ok(storage); trace.push('storage.unregister'); }
        auto_tile_on() { trace.push('tiling.on'); this.auto_tiler = { attached: {}, destroy: record('tiling.destroy') }; }
    }
    class Indicator {
        constructor() { this.button = {}; trace.push('indicator.create'); }
        destroy() { trace.push('indicator.destroy'); }
    }
    const log = Object.fromEntries(['info', 'warn', 'error', 'log'].map(level => [level, text => messages.push({ level, text })]));
    const layout = { addChrome: record('chrome.add'), removeChrome: record('chrome.remove') };
    const api = new Function('Ext', 'Extension', 'Gio', 'log', 'globalThis', 'sessionMode',
        '_show_skip_taskbar_windows', '_hide_skip_taskbar_windows', 'load_theme',
        'disable_window_attention_handler', 'enable_window_attention_handler',
        'layoutManager', 'PanelSettings', 'panel', code + `
        return { Extension: PopShellExtension,
            state: () => ({ initialized, activating, chrome_added, pending: startup_cancellable !== null }) };
    `)(FakeExt, class {}, { Cancellable: Token }, log, global, session,
        record('skip.show'), record('skip.hide'), record('theme.load'),
        record('attention.disable'), record('attention.enable'), layout, { Indicator },
        { addToStatusArea: record('panel.add') });
    const extension = new api.Extension();
    const finish = async (index = 0, result = { tag: 0, value: true }) => {
        reads[index].resolve(result); await Promise.resolve(); await Promise.resolve();
    };
    return { extension, trace, reads, tokens, messages, instances, global, session,
        finish, state: api.state };
}
const count = (f, name) => f.trace.filter(value => value === name).length;

function inactive(f) {
    for (const name of ['events.start', 'dbus.start', 'signals.attach', 'keys.enable.global', 'chrome.add', 'tiling.on']) {
        assert.equal(count(f, name), 0, name);
    }
    assert.equal(f.state().initialized, false);
}

test('enable returns synchronously and keeps activation gated while loading', () => {
    const f = fixture();
    assert.equal(f.extension.enable(), undefined);
    assert.equal(f.reads.length, 1); inactive(f);
    assert.equal(f.instances[0].events_enabled, false);
});

test('only an applied config activates resources and tiling, in order', async () => {
    const f = fixture(); f.extension.enable(); await f.finish();
    assert.equal(f.state().initialized, true); assert.equal(f.state().pending, false);
    assert.equal(count(f, 'tiling.on'), 1);
    assert.ok(f.trace.indexOf('events.start') < f.trace.indexOf('signals.attach'));
    assert.ok(f.trace.indexOf('signals.attach') < f.trace.indexOf('tiling.on'));
    assert.ok(f.trace.indexOf('signals.attach') < f.trace.indexOf('decorations.refresh'));
    for (const callback of f.instances[0].callbacks) callback();
    assert.equal(count(f, 'theme.load'), 1); assert.equal(count(f, 'windows.snap'), 1);
});

test('valid configuration does not enable tiling when the setting is off', async () => {
    const f = fixture({ tile: false }); f.extension.enable(); await f.finish();
    assert.equal(f.state().initialized, true); assert.equal(count(f, 'tiling.on'), 0);
});

test('read or validation failure leaves activation paused and reports the error', async () => {
    const f = fixture(); f.extension.enable(); await f.finish(0, { tag: 1, why: 'invalid configuration' });
    inactive(f); assert.equal(f.state().pending, false);
    assert.ok(f.messages.some(entry => entry.level === 'error' && entry.text.includes('invalid configuration')));
});

test('superseded config result is not a successful startup', async () => {
    const f = fixture(); f.extension.enable(); await f.finish(0, { tag: 0, value: false });
    inactive(f); assert.equal(f.state().pending, false);
});

test('unexpected loader rejection is caught without starting resources', async () => {
    const f = fixture(); f.extension.enable(); f.reads[0].reject(new Error('loader failed'));
    await Promise.resolve(); await Promise.resolve(); inactive(f);
    assert.ok(f.messages.some(entry => entry.level === 'error' && entry.text.includes('loader failed')));
});

test('disable while loading cancels native I/O and invalidates the read', async () => {
    const f = fixture(); f.extension.enable();
    const ext = f.instances[0]; const before = ext.invalidations;
    f.extension.disable();
    assert.equal(f.tokens[0].cancels, 1); assert.ok(ext.invalidations > before);
    assert.equal(f.global.popShellExtension, undefined);
    await f.finish(); inactive(f);
    assert.equal(count(f, 'chrome.remove'), 0); assert.equal(count(f, 'signals.remove'), 0);
});

test('a late rejected load after disable cannot log through disposed extension state', async () => {
    const f = fixture(); f.extension.enable(); f.extension.disable();
    const before = f.messages.length;
    f.reads[0].reject(new Error('late cancellation'));
    await Promise.resolve(); await Promise.resolve();
    assert.equal(f.messages.length, before); inactive(f);
});

test('reenable ignores the old successful response and starts only the new activation', async () => {
    const f = fixture(); f.extension.enable(); f.extension.disable(); f.extension.enable();
    assert.equal(f.instances.length, 1); assert.equal(f.reads.length, 2);
    await f.finish(0); inactive(f);
    await f.finish(1); assert.equal(count(f, 'tiling.on'), 1); assert.equal(count(f, 'signals.attach'), 1);
});

test('a repeated enable during loading cancels the older startup', async () => {
    const f = fixture(); f.extension.enable(); f.extension.enable();
    assert.equal(f.tokens[0].cancels, 1);
    await f.finish(0); inactive(f); await f.finish(1);
    assert.equal(count(f, 'dbus.start'), 1);
});

test('regular disable tears down an activated extension', async () => {
    const f = fixture(); f.extension.enable(); await f.finish(); f.extension.disable();
    assert.equal(f.state().initialized, false); assert.equal(f.state().chrome_added, false);
    for (const name of ['signals.remove', 'dbus.destroy', 'chrome.remove', 'indicator.destroy', 'tiling.destroy', 'storage.unregister']) {
        assert.equal(count(f, name), 1, name);
    }
    assert.ok(f.trace.indexOf('storage.unregister') < f.trace.indexOf('tiling.destroy'));
    assert.ok(f.trace.indexOf('io.stop') < f.trace.indexOf('signals.remove'));
});

test('lock and unlock retain an already activated extension without duplicate setup', async () => {
    const f = fixture({ skip: true }); f.extension.enable(); await f.finish();
    f.session.isLocked = true; f.extension.disable();
    assert.equal(f.state().initialized, true); assert.equal(f.instances[0].was_locked, true);
    assert.equal(count(f, 'signals.remove'), 0);
    f.session.isLocked = false; f.extension.enable();
    assert.equal(f.reads.length, 1); assert.equal(count(f, 'signals.attach'), 1);
    assert.equal(count(f, 'tiling.on'), 1); assert.equal(f.instances[0].was_locked, false);
});

test('lock during pending startup cancels it instead of retaining uninitialized resources', async () => {
    const f = fixture(); f.extension.enable(); f.session.isLocked = true; f.extension.disable();
    await f.finish(); inactive(f); assert.equal(f.tokens[0].cancels, 1);
    f.session.isLocked = false; f.extension.enable(); await f.finish(1);
    assert.equal(count(f, 'tiling.on'), 1);
});

test('a response arriving after lock but before disable cannot activate', async () => {
    const f = fixture(); f.extension.enable(); f.session.isLocked = true;
    await f.finish(); inactive(f); assert.equal(f.state().pending, false);
    assert.equal(f.tokens[0].cancels, 1);
});

test('partial activation failure rolls back without removing unattached chrome', async () => {
    const f = fixture({ failSignals: true }); f.extension.enable(); await f.finish();
    assert.equal(f.state().initialized, false); assert.equal(f.state().activating, false);
    assert.equal(count(f, 'dbus.destroy'), 1); assert.equal(count(f, 'signals.remove'), 1);
    assert.equal(count(f, 'chrome.remove'), 0); assert.equal(count(f, 'tiling.on'), 0);
    assert.equal(f.global.popShellExtension, undefined);
});

test('startup no longer reads config synchronously in the Ext constructor', () => {
    const begin = source.indexOf('    constructor() {', source.indexOf('export class Ext'));
    const end = source.indexOf('    // System interface', begin);
    const constructor = source.slice(begin, end);
    assert.doesNotMatch(constructor, /this\.conf\.reload\(/);
    assert.doesNotMatch(constructor, /this\.register_fn\(/);
});

test('reenable discovers windows created during the load without duplicating tracked windows', () => {
    const begin = source.indexOf('    queue_untracked_windows() {');
    const end = source.indexOf('    signals_remove() {', begin);
    assert.ok(begin >= 0 && end > begin);
    const methods = source.slice(begin, end).replace('let id: number;', 'let id;');
    const known = { get_stable_sequence: () => 1 };
    const added = { get_stable_sequence: () => 2 };
    const vanished = { get_stable_sequence() { throw new Error('window gone'); } };
    const pending = [];
    const tracker = new Function('display', 'Meta', `return { ${methods} };`)(
        { get_tab_list: () => [known, added, vanished] }, { TabList: { NORMAL: 0 } });
    tracker.ids = { *find(predicate) { if (predicate(1)) yield [0, 1]; } };
    tracker.register = event => pending.push(event);
    tracker.queue_untracked_windows();
    assert.deepEqual(pending, [{ tag: 3, window: added }]);
});

test('discovery of missed windows follows signal attachment on reenable', () => {
    const begin = source.indexOf('    signals_attach() {');
    const end = source.indexOf('    queue_untracked_windows() {', begin);
    const attach = source.slice(begin, end);
    assert.match(attach, /else \{\s*this\.queue_untracked_windows\(\);/);
    assert.ok(attach.indexOf("'window_created'") < attach.indexOf('this.queue_untracked_windows();'));
});
