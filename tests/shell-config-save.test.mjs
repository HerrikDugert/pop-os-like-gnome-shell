import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../src/extension.ts', import.meta.url), 'utf8');
const begin = source.indexOf('    stop_config_io() {');
const end = source.indexOf('    stop_exception_dialog() {', begin);
assert.ok(begin >= 0 && end > begin);
let methods = source.slice(begin, end).replaceAll('private ', '');
methods = methods.replace('valid: () => boolean = () => true', 'valid = () => true')
    .replace('owner: Set<any> | null', 'owner');
for (const type of [': Promise<void>', ': Window.ShellWindow', ': boolean', ': number', ': string', ': void']) {
    methods = methods.replaceAll(type, '');
}
const stopBegin = source.indexOf('    stop_window_io() {');
const stopEnd = source.indexOf('    // Extension methods', stopBegin);
assert.ok(stopBegin >= 0 && stopEnd > stopBegin);
methods += source.slice(stopBegin, stopEnd);

function deferred() {
    let resolve, reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
}
async function flush() { for (let i = 0; i < 6; i++) await Promise.resolve(); }
function fixture() {
    const writes = [], reads = [], notifications = [], dialogs = [], errors = [], tokens = [];
    class Token {
        cancelled = false;
        constructor() { tokens.push(this); }
        cancel() { this.cancelled = true; }
        is_cancelled() { return this.cancelled; }
    }
    class Dialog {
        constructor(...callbacks) { this.callbacks = callbacks; dialogs.push(this); }
        open() { this.opened = true; }
    }
    const Main = { notifyError(title, body) { notifications.push({ title, body }); } };
    const Type = new Function('Gio', 'Main', 'log', 'add_exception', `return class {
        events_enabled = true;
        config_generation = 0;
        config_requests = new Set();
        extension_timers = { stop() {} };
        first_frames = { stop() {} };
        exception_selecting = true;
        reopened = 0;
        reapplied = 0;
        windows = { values: () => [] };
        exception_dialog() { this.reopened++; }
        tiling_config_reapply() { this.reapplied++; }
        ${methods}
    }` )({ Cancellable: Token }, Main, { log: text => errors.push(text) }, { AddExceptionDialog: Dialog });
    const owner = new Type();
    const request = (list, args) => { const pending = deferred(); list.push({ ...pending, args }); return pending.promise; };
    owner.conf = {
        invalidate_load() { owner.invalidated = (owner.invalidated ?? 0) + 1; },
        add_app_exception_async(...args) { return request(writes, ['app', ...args]); },
        add_window_exception_async(...args) { return request(writes, ['window', ...args]); },
        reload_async(...args) { return request(reads, args); },
        add_app_exception() { throw new Error('sync write'); },
        add_window_exception() { throw new Error('sync write'); },
        reload() { throw new Error('sync read'); }
    };
    const win = { meta: { get_wm_class: () => 'App' }, name: () => 'Fallback', title: () => 'Title [1]' };
    return { owner, win, writes, reads, notifications, dialogs, errors, tokens, Main };
}
const saved = applied => ({ tag: 0, value: { applied } });
const loaded = { tag: 0, value: true };

test('app exception waits for persistence before reapplying or reopening', async () => {
    const f = fixture(); const pending = f.owner.save_window_exception(f.win, true, 0);
    assert.equal(f.writes.length, 1); assert.equal(f.owner.config_requests.size, 1);
    assert.equal(f.writes[0].args[0], 'app'); assert.equal(f.writes[0].args[1], 'App');
    assert.equal(f.owner.reapplied, 0); assert.equal(f.owner.reopened, 0);
    f.writes[0].resolve(saved(true)); await pending;
    assert.equal(f.owner.reapplied, 1); assert.equal(f.owner.reopened, 1);
    assert.equal(f.owner.config_requests.size, 0);
});

test('window exception forwards the literal title and its owned cancellation token', async () => {
    const f = fixture(); const pending = f.owner.save_window_exception(f.win, false, 0);
    assert.deepEqual(f.writes[0].args.slice(0, 3), ['window', 'App', 'Title [1]']);
    assert.strictEqual(f.writes[0].args[3], f.tokens[0]);
    f.writes[0].resolve(saved(true)); await pending;
});

test('application class fallback is retained for an empty class', async () => {
    const f = fixture(); f.win.meta.get_wm_class = () => '';
    const pending = f.owner.save_window_exception(f.win, true, 0);
    assert.equal(f.writes[0].args[1], 'Fallback');
    f.writes[0].resolve(saved(true)); await pending;
});

test('pre-start save failure notifies without claiming success or reopening', async () => {
    const f = fixture(); const pending = f.owner.save_window_exception(f.win, true, 0);
    f.writes[0].resolve({ tag: 1, why: 'cancelled before start', persistence: 'not-started' }); await pending;
    assert.equal(f.notifications.length, 1); assert.equal(f.reads.length, 0);
    assert.equal(f.owner.reopened, 0); assert.equal(f.owner.reapplied, 0);
    assert.equal(f.owner.config_requests.size, 0);
});

test('uncertain persistence is reported and reconciled, not presented as an unchanged file', async () => {
    const f = fixture(); const pending = f.owner.save_window_exception(f.win, true, 0);
    f.writes[0].resolve({ tag: 1, why: 'cleanup failed', persistence: 'unknown' }); await flush();
    assert.match(f.notifications[0].body, /may already have been saved/);
    assert.equal(f.reads.length, 1); f.reads[0].resolve(loaded); await pending;
    assert.equal(f.owner.reapplied, 1); assert.equal(f.owner.reopened, 0);
    assert.equal(f.owner.config_requests.size, 0);
});

test('an unapplied completed save reloads before reopening the exception UI', async () => {
    const f = fixture(); const pending = f.owner.save_window_exception(f.win, true, 0);
    f.writes[0].resolve(saved(false)); await flush();
    assert.equal(f.owner.reopened, 0); assert.equal(f.reads.length, 1);
    f.reads[0].resolve(loaded); await pending;
    assert.equal(f.owner.reapplied, 1); assert.equal(f.owner.reopened, 1);
});

test('reload failure after a completed save reports that distinction', async () => {
    const f = fixture(); const pending = f.owner.save_window_exception(f.win, true, 0);
    f.writes[0].resolve(saved(false)); await flush();
    f.reads[0].resolve({ tag: 1, why: 'read denied' }); await pending;
    assert.match(f.notifications[0].body, /save completed/); assert.equal(f.owner.reopened, 0);
});

test('regular I/O teardown cancels all owned tokens and invalidates configuration', async () => {
    const f = fixture(); const pending = f.owner.save_window_exception(f.win, true, 0);
    const refresh = f.owner.reload_config_for_shell();
    f.owner.events_enabled = false; f.owner.stop_window_io();
    assert.ok(f.tokens.every(token => token.cancelled)); assert.equal(f.owner.invalidated, 1);
    assert.equal(f.owner.config_requests.size, 0);
    f.writes[0].resolve(saved(true)); f.reads[0].resolve(loaded); await Promise.all([pending, refresh]);
    assert.equal(f.owner.reopened, 0); assert.equal(f.owner.reapplied, 0); assert.equal(f.notifications.length, 0);
});

test('reenable cannot revive callbacks from the previous activation', async () => {
    const f = fixture(); const pending = f.owner.save_window_exception(f.win, true, 0);
    f.owner.events_enabled = false; f.owner.stop_window_io(); f.owner.events_enabled = true;
    f.writes[0].resolve(saved(true)); await pending;
    assert.equal(f.owner.reopened, 0); assert.equal(f.owner.reapplied, 0);
    assert.equal(f.owner.config_requests.size, 0);
});

test('late rejection after disable is contained without notifications', async () => {
    const f = fixture(); const pending = f.owner.save_window_exception(f.win, true, 0);
    f.owner.events_enabled = false; f.owner.stop_window_io();
    f.writes[0].reject(new Error('late error')); await pending;
    assert.equal(f.notifications.length, 0); assert.equal(f.owner.config_requests.size, 0);
});

test('modal close after a button action does not race the in-flight save with a reload', async () => {
    const f = fixture(); f.owner.exception_add(f.win); const callbacks = f.dialogs[0].callbacks;
    callbacks[1](); callbacks[3]();
    assert.equal(f.writes.length, 1); assert.equal(f.reads.length, 0);
    f.writes[0].resolve(saved(true)); await flush(); assert.equal(f.owner.reopened, 1);
});

test('duplicate modal actions submit only one change', async () => {
    const f = fixture(); f.owner.exception_add(f.win); const callbacks = f.dialogs[0].callbacks;
    callbacks[2](); callbacks[1](); callbacks[2]();
    assert.equal(f.writes.length, 1); f.writes[0].resolve(saved(true)); await flush();
});

test('cancel reopens the exception UI without a write or redundant reload', () => {
    const f = fixture(); f.owner.exception_add(f.win); const callbacks = f.dialogs[0].callbacks;
    callbacks[0](); callbacks[3](); assert.equal(f.owner.reopened, 1);
    assert.equal(f.writes.length, 0); assert.equal(f.reads.length, 0);
});

test('old modal actions cannot submit work after disable and reenable', () => {
    const f = fixture(); f.owner.exception_add(f.win); const callbacks = f.dialogs[0].callbacks;
    f.owner.events_enabled = false; f.owner.stop_window_io(); f.owner.events_enabled = true;
    callbacks[1](); callbacks[3](); assert.equal(f.writes.length, 0); assert.equal(f.reads.length, 0);
});

test('close without a selected action asynchronously reloads before reapplying', async () => {
    const f = fixture(); f.owner.exception_add(f.win); f.dialogs[0].callbacks[3]();
    assert.equal(f.reads.length, 1); assert.equal(f.owner.reapplied, 0);
    f.reads[0].resolve(loaded); await flush(); assert.equal(f.owner.reapplied, 1);
});

test('superseded reload does not reapply stale configuration', async () => {
    const f = fixture(); const pending = f.owner.reload_config_for_shell();
    f.reads[0].resolve({ tag: 0, value: false }); await pending;
    assert.equal(f.owner.reapplied, 0); assert.equal(f.owner.config_requests.size, 0);
});

test('reload errors are shown and tokens are released', async () => {
    const f = fixture(); const pending = f.owner.reload_config_for_shell();
    f.reads[0].reject(new Error('read failure')); await pending;
    assert.equal(f.notifications.length, 1); assert.equal(f.owner.config_requests.size, 0);
});

test('destroyed or unidentified windows fail safely without saving', async () => {
    for (const getClass of [() => null, () => { throw new Error('destroyed'); }]) {
        const f = fixture(); f.win.meta.get_wm_class = getClass;
        await f.owner.save_window_exception(f.win, false, 0);
        assert.equal(f.writes.length, 0); assert.equal(f.notifications.length, 1);
        assert.equal(f.owner.config_requests.size, 0);
    }
});

test('notification failures fall back to logging without escaping', async () => {
    const f = fixture(); f.Main.notifyError = () => { throw new Error('notification failed'); };
    const pending = f.owner.save_window_exception(f.win, true, 0);
    f.writes[0].resolve({ tag: 1, why: 'failed', persistence: 'not-started' }); await pending;
    assert.equal(f.errors.length, 1); assert.equal(f.owner.config_requests.size, 0);
});

test('disabled owner starts neither a modal nor a save nor a reload', async () => {
    const f = fixture(); f.owner.events_enabled = false;
    f.owner.exception_add(f.win);
    await f.owner.save_window_exception(f.win, true, 0); await f.owner.reload_config_for_shell();
    assert.equal(f.dialogs.length, 0); assert.equal(f.writes.length, 0); assert.equal(f.reads.length, 0);
});
