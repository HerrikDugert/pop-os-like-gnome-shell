import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../src/floating_exceptions/src/main.ts', import.meta.url), 'utf8');
let appCode = source.slice(source.indexOf('class App {'), source.indexOf('function list_header_func'));
appCode = appCode.replaceAll('private ', '').replace('action: (token: any) => Promise<void>', 'action').replaceAll('Array.from<any>', 'Array.from');
for (const type of [': ToggleException | RemoveException', ': Promise<void> | null', ': Promise<void>',
    ': MainView', ': ExceptionsView', ': config.Config', ': Event', ': string', ': void', ': any']) {
    appCode = appCode.replaceAll(type, '');
}
async function flush() { for (let i = 0; i < 10; i++) await Promise.resolve(); }
function deferred() {
    let resolve, reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
}
function fixture() {
    const reads = [], writes = [], protocol = [], tokens = [], logs = [];
    let quits = 0;
    class Widget {
        signals = {}; visible = true; sensitive = true; text = ''; children = [];
        connect(signal, callback) { this.signals[signal] = callback; }
        add(child) { this.children.push(child); }
        hide() { this.visible = false; }
        show() { this.visible = true; }
        show_all() { this.visible = true; }
        set_sensitive(value) { this.sensitive = value; }
        set_text(value) { this.text = value; }
        set_border_width() {} set_line_wrap() {} set_max_width_chars() {} set_selectable() {}
        set_visible_child(child) { this.selected = child; }
        get_header_bar() { return this; } get_content_area() { return this; }
        set_show_close_button() {} set_title() {} pack_start() {} set_wmclass() {} set_default_size() {}
    }
    class View {
        widget = new Widget(); rows = [];
        clear_rules() { this.rows = []; }
        add_rule(...args) { this.rows.push(args); }
    }
    class Token {
        cancelled = false;
        constructor() { tokens.push(this); }
        cancel() { this.cancelled = true; }
        is_cancelled() { return this.cancelled; }
    }
    const request = (list, args) => { const d = deferred(); list.push({ ...d, args }); return d.promise; };
    class Config {
        float = [{ class: 'User', match: 'exact' }]; invalidated = 0;
        reload_async(...args) { return request(reads, args); }
        toggle_system_exception_async(...args) { return request(writes, ['toggle', ...args]); }
        remove_user_exception_async(...args) { return request(writes, ['remove', ...args]); }
        invalidate_load() { this.invalidated++; }
        rule_disabled() { return false; }
        reload() { throw new Error('sync read'); }
        toggle_system_exception() { throw new Error('sync write'); }
        remove_user_exception() { throw new Error('sync write'); }
    }
    const Gtk = {
        Stack: { new: () => new Widget() }, Dialog: Widget,
        Button: { new_from_icon_name: () => new Widget(), new_with_label: () => new Widget() },
        Label: { new: () => new Widget() }, Box: { new: () => new Widget() },
        Window: { set_default_icon_name() {} }, IconSize: { BUTTON: 0 }, Orientation: { VERTICAL: 0 },
        main_quit() { quits++; }
    };
    const config = { Config, DEFAULT_FLOAT_RULES: [{ class: 'System' }], rule_mode: value => value.match ?? 'regex' };
    const Type = new Function('Gtk', 'Gio', 'MainView', 'ExceptionsView', 'config', 'ViewNum', 'WM_CLASS_ID', 'println', 'log',
        appCode + '\nreturn App;')(Gtk, { Cancellable: Token }, View, View, config,
        { MainView: 0, Exceptions: 1 }, 'test', message => protocol.push(message), message => logs.push(message));
    const app = new Type();
    const ready = async () => { reads[0].resolve({ tag: 0, value: true }); await flush(); };
    return { app, reads, writes, protocol, tokens, logs, ready, quits: () => quits };
}
const remove = { tag: 3, wmclass: 'User', wmtitle: undefined, match: 'exact' };
const toggle = { tag: 2, wmclass: 'System', wmtitle: undefined, enable: false };
const completed = { tag: 0, value: { applied: true } };

test('initial loading is asynchronous and disables edits until valid data arrives', async () => {
    const f = fixture(); assert.equal(f.reads.length, 1); assert.equal(f.app.stack.sensitive, false);
    f.app.handle_event(remove); assert.equal(f.writes.length, 0);
    await f.ready(); assert.equal(f.app.stack.sensitive, true);
    assert.deepEqual(f.app.main_view.rows, [['User', undefined, 'exact']]);
});

test('load errors keep edits disabled while permitting explicit retry', async () => {
    const f = fixture(); f.reads[0].resolve({ tag: 1, why: 'bad JSON' }); await flush();
    assert.equal(f.app.stack.sensitive, false); assert.equal(f.app.retry.sensitive, true);
    assert.match(f.app.error_label.text, /bad JSON/);
    f.app.retry.signals.clicked(); assert.equal(f.reads.length, 2);
    f.reads[1].resolve({ tag: 0, value: true }); await flush(); assert.equal(f.app.stack.sensitive, true);
});

test('deletion forwards match mode, keeps rows pending, and notifies only after completion', async () => {
    const f = fixture(); await f.ready(); f.app.handle_event(remove);
    assert.deepEqual(f.writes[0].args.slice(0, 4), ['remove', 'User', undefined, 'exact']);
    assert.strictEqual(f.writes[0].args[4], f.tokens[1]);
    assert.equal(f.app.main_view.rows.length, 1); assert.deepEqual(f.protocol, []);
    assert.equal(f.app.stack.sensitive, false);
    f.app.config.float = []; f.writes[0].resolve(completed); await flush();
    assert.deepEqual(f.protocol, ['MODIFIED']); assert.equal(f.app.main_view.rows.length, 0);
    assert.equal(f.app.stack.sensitive, true);
});

test('system toggles use the asynchronous mutation and inverse disabled flag', async () => {
    const f = fixture(); await f.ready(); f.app.handle_event(toggle);
    assert.deepEqual(f.writes[0].args.slice(0, 4), ['toggle', 'System', undefined, true]);
    f.writes[0].resolve(completed); await flush(); assert.deepEqual(f.protocol, ['MODIFIED']);
});

test('repeated mutation and select events are ignored while a save is pending', async () => {
    const f = fixture(); await f.ready(); f.app.handle_event(remove);
    f.app.handle_event(toggle); f.app.handle_event({ tag: 0 }); f.app.load_config();
    assert.equal(f.writes.length, 1); assert.equal(f.reads.length, 1); assert.deepEqual(f.protocol, []);
    f.writes[0].resolve(completed); await flush();
});

test('a not-started failure retains rows and never emits MODIFIED', async () => {
    const f = fixture(); await f.ready(); f.app.handle_event(remove);
    f.writes[0].resolve({ tag: 1, why: 'cancelled', persistence: 'not-started' }); await flush();
    assert.deepEqual(f.protocol, []); assert.equal(f.app.main_view.rows.length, 1);
    assert.match(f.app.error_label.text, /did not start/); assert.equal(f.app.stack.sensitive, true);
});

test('uncertain persistence emits RELOAD, reconciles, and retains the error message', async () => {
    const f = fixture(); await f.ready(); f.app.handle_event(remove);
    f.writes[0].resolve({ tag: 1, why: 'cleanup failed', persistence: 'unknown' }); await flush();
    assert.deepEqual(f.protocol, ['RELOAD']); assert.equal(f.reads.length, 2);
    f.app.config.float = []; f.reads[1].resolve({ tag: 0, value: true }); await flush();
    assert.equal(f.app.main_view.rows.length, 0); assert.match(f.app.error_label.text, /may already have been saved/);
    assert.equal(f.app.error_box.visible, true); assert.equal(f.app.stack.sensitive, true);
});

test('failed recovery leaves editing disabled and retry available', async () => {
    const f = fixture(); await f.ready(); f.app.handle_event(remove);
    f.writes[0].resolve({ tag: 1, why: 'uncertain', persistence: 'unknown' }); await flush();
    f.reads[1].resolve({ tag: 1, why: 'read denied' }); await flush();
    assert.equal(f.app.stack.sensitive, false); assert.equal(f.app.retry.sensitive, true);
    assert.match(f.app.error_label.text, /read denied/);
});

test('a completed but unapplied save reloads before rendering its result', async () => {
    const f = fixture(); await f.ready(); f.app.handle_event(remove);
    f.writes[0].resolve({ tag: 0, value: { applied: false } }); await flush();
    assert.deepEqual(f.protocol, ['MODIFIED']); assert.equal(f.app.stack.sensitive, false);
    f.app.config.float = []; f.reads[1].resolve({ tag: 0, value: true }); await flush();
    assert.equal(f.app.main_view.rows.length, 0); assert.equal(f.app.stack.sensitive, true);
});

test('close during load cancels and waits for cleanup before quitting', async () => {
    const f = fixture(); const result = f.app.window.signals['delete-event']();
    assert.equal(result, true); assert.equal(f.tokens[0].cancelled, true); assert.equal(f.quits(), 0);
    assert.equal(f.app.config.invalidated, 1); assert.equal(f.app.window.visible, false);
    f.reads[0].resolve({ tag: 0, value: false }); await flush();
    assert.equal(f.quits(), 1); assert.deepEqual(f.protocol, []);
});

test('close during save waits for completion and still notifies a confirmed save', async () => {
    const f = fixture(); await f.ready(); f.app.handle_event(remove); f.app.close();
    assert.equal(f.tokens[1].cancelled, true); assert.equal(f.quits(), 0);
    f.writes[0].resolve({ tag: 0, value: { applied: false } }); await flush();
    assert.equal(f.quits(), 1); assert.deepEqual(f.protocol, ['MODIFIED']);
    assert.equal(f.app.main_view.rows.length, 1); assert.equal(f.app.window.visible, false);
});

test('unknown persistence during close requests a reload without touching disposed UI', async () => {
    const f = fixture(); await f.ready(); f.app.handle_event(remove); f.app.close();
    f.writes[0].resolve({ tag: 1, why: 'uncertain', persistence: 'unknown' }); await flush();
    assert.deepEqual(f.protocol, ['RELOAD']); assert.equal(f.reads.length, 1); assert.equal(f.quits(), 1);
});

test('SELECT is emitted only when ready and shutdown leaves no active operation', async () => {
    const f = fixture(); await f.ready(); f.app.handle_event({ tag: 0 });
    assert.deepEqual(f.protocol, ['SELECT']); assert.equal(f.quits(), 1); assert.equal(f.app.pending, null);
});

test('unexpected save rejection is contained and requests reconciliation', async () => {
    const f = fixture(); await f.ready(); f.app.handle_event(remove);
    f.writes[0].reject(new Error('unexpected failure')); await flush();
    assert.deepEqual(f.protocol, ['RELOAD']); assert.equal(f.app.stack.sensitive, false);
    assert.match(f.app.error_label.text, /may already have changed/);
    assert.equal(f.app.active, null); assert.equal(f.app.pending, null);
});

test('repeated close is idempotent and stale callbacks cannot submit writes', async () => {
    const f = fixture(); f.app.close(); f.app.close(); f.app.handle_event(remove); f.app.load_config();
    assert.equal(f.app.config.invalidated, 1); assert.equal(f.writes.length, 0); assert.equal(f.reads.length, 1);
    f.reads[0].resolve({ tag: 0, value: true }); await flush(); assert.equal(f.quits(), 1);
});

test('deletion row dispatch does not destroy the row before persistence', () => {
    const start = source.indexOf('    add_rule(', source.indexOf('export class MainView'));
    const end = source.indexOf('export class ExceptionsView', start);
    assert.doesNotMatch(source.slice(start, end), /widget.destroy\(\)/);
});

test('system switches use delayed backend-state acknowledgement', () => {
    const start = source.indexOf('    add_rule(', source.indexOf('export class ExceptionsView'));
    const end = source.indexOf('class App {', start);
    let method = source.slice(start, end).replace(/\n}\s*$/, '').trim();
    method = method.replaceAll(': string | undefined', '').replaceAll(': boolean', '').replaceAll(': any', '');
    let handler; const states = [], events = [];
    const widget = new Proxy({}, { get: () => () => {} });
    const button = { set_valign() {}, set_active() {}, set_state(value) { states.push(value); },
        connect(signal, callback) { assert.equal(signal, 'state-set'); handler = callback; } };
    const Gtk = { Label: { new: () => widget }, Switch: { new: () => button }, Box: { new: () => widget },
        Align: { CENTER: 0 }, Orientation: { HORIZONTAL: 0 } };
    const view = new Function('Gtk', 'Pango', `return { ${method} };`)(Gtk, { EllipsizeMode: { END: 0 } });
    view.exceptions = { add() {} }; view.callback = event => events.push(event);
    view.add_rule('System', undefined, true); assert.deepEqual(states, [true]);
    assert.equal(handler(button, false), true); assert.deepEqual(states, [true]);
    assert.deepEqual(events, [{ tag: 2, wmclass: 'System', wmtitle: undefined, enable: false }]);
});
