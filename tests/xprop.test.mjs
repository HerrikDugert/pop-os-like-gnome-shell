import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

let processes = [], jobs = [], options = {}, serial = 0;
const timers = new Map();
const output = (motif = '2, 0, 1, 0, 0', extents = null) =>
    `_MOTIF_WM_HINTS(CARDINAL) = ${motif}\n` +
    (extents === null ? '_GTK_FRAME_EXTENTS: not found.\n' : `_GTK_FRAME_EXTENTS(CARDINAL) = ${extents}\n`);
class Cancellable {
    cancelled = false; cancelling = false; callbacks = new Map();
    is_cancelled() { return this.cancelled; }
    connect(callback) {
        if (this.cancelled) { callback(); return 0; }
        const id = ++serial; this.callbacks.set(id, callback); return id;
    }
    disconnect(id) {
        assert.equal(this.cancelling, false, 'disconnect inside cancel callback');
        assert.equal(this.callbacks.delete(id), true);
    }
    cancel() {
        if (this.cancelled) return;
        this.cancelled = true; this.cancelling = true;
        try { for (const callback of this.callbacks.values()) callback(); }
        finally { this.cancelling = false; }
    }
}
class Process {
    kills = 0; callback = null; done = false;
    constructor(argv) { this.argv = argv; }
    force_exit() { this.kills++; }
    communicate_utf8_async(_input, token, callback) {
        if (options.startError) throw new Error('communication setup');
        this.token = token; this.callback = callback;
        token.connect(() => jobs.push(() => this.complete(null, new Error('cancelled'))));
        if (options.auto) jobs.push(() => this.complete(this.argv.includes('-set') ? '' : output()));
    }
    communicate_utf8_finish(result) {
        if (result.error) throw result.error;
        return [true, result.output, null];
    }
    get_successful() { return !options.exitFailure; }
    complete(text, error = null) {
        if (this.done) return;
        this.done = true; this.callback(this, { output: text, error });
    }
}
globalThis.__xpropGio = {
    Cancellable, SubprocessFlags: { STDOUT_PIPE: 1, STDERR_SILENCE: 2 },
    Subprocess: { new(argv) {
        if (options.spawnError) throw new Error('spawn');
        const child = new Process(argv); processes.push(child); return child;
    } },
};
globalThis.__xpropGLib = {
    PRIORITY_DEFAULT: 0,
    timeout_add(_priority, delay, callback) {
        assert.equal(delay, 1500);
        const id = ++serial; timers.set(id, callback); return id;
    },
    source_remove(id) { assert.equal(timers.delete(id), true, 'removing expired timer'); },
};
const xprop = await import('../target/xprop.js');
const { DecorationController } = await import('../target/decorations.js');
function reset(settings = {}) { processes = []; jobs = []; options = settings; timers.clear(); }
async function settle() {
    for (let i = 0; i < 20; i++) { while (jobs.length) jobs.shift()(); await Promise.resolve(); }
}
async function query(text, token = null) {
    const pending = xprop.query_decoration('0xABC', token);
    processes.at(-1).complete(text); return await pending;
}

test('one asynchronous query reads both properties and cleans timer and cancellation handler', async () => {
    reset(); const token = new Cancellable();
    assert.deepEqual(await query(output(), token), { may_decorate: true, client_decorated: false });
    assert.equal(processes.length, 1);
    assert.deepEqual(processes[0].argv, ['xprop', '-id', '0xABC', '_MOTIF_WM_HINTS', '_GTK_FRAME_EXTENTS']);
    assert.equal(timers.size, 0); assert.equal(token.callbacks.size, 0); assert.equal(token.cancelled, false);
});

test('decimal and hexadecimal cardinals are parsed numerically', async () => {
    reset(); assert.equal((await query(output('0x2, 0x0, 0x1, 0x0, 0x0'))).may_decorate, true);
    assert.equal((await query(output('2, 0, 10, 0, 0'))).may_decorate, false);
});

test('CSD extents including all zeroes prevent server-decoration writes', async () => {
    reset(); assert.equal((await query(output('2, 0, 1, 0, 0', '0, 0, 0, 0'))).client_decorated, true);
});

test('missing motif property retains historical fallback', async () => {
    reset(); const info = await query('_MOTIF_WM_HINTS: not found.\n_GTK_FRAME_EXTENTS: no such atom on any window.\n');
    assert.deepEqual(info, { may_decorate: true, client_decorated: false });
});

for (const bad of ['garbage', '_MOTIF_WM_HINTS = 2, 0, 1\n_GTK_FRAME_EXTENTS: not found.', output('2, 0, nope, 0, 0'), output('2, 0, 4294967296, 0, 0'), output('2, 0, 1, 0, 0', '1, 2')]) {
    test(`malformed property output is conservative: ${JSON.stringify(bad)}`, async () => {
        reset(); assert.equal(await query(bad), null); assert.equal(timers.size, 0);
    });
}

test('invalid XIDs and unsupported writes never spawn processes', async () => {
    reset();
    for (const id of ['-root', '0x1 -root', '', '123']) assert.equal(await xprop.query_decoration(id, null), null);
    assert.equal(await xprop.set_hint('0x1', 'OTHER', xprop.HIDE_FLAGS, null), false);
    assert.equal(await xprop.set_hint('0x1', xprop.MOTIF_HINTS, ['malicious'], null), false);
    assert.equal(processes.length, 0);
});

test('already cancelled request never starts', async () => {
    reset(); const token = new Cancellable(); token.cancel();
    assert.equal(await xprop.query_decoration('0x1', token), null); assert.equal(processes.length, 0);
});

test('cancellation kills own child and disconnects outside cancellation callback', async () => {
    reset(); const token = new Cancellable(); const pending = xprop.query_decoration('0x1', token);
    token.cancel(); await settle();
    assert.equal(await pending, null); assert.equal(processes[0].kills, 1);
    assert.equal(token.callbacks.size, 0); assert.equal(timers.size, 0);
});

test('timeout kills process but does not cancel caller token', async () => {
    reset(); const token = new Cancellable(); const pending = xprop.query_decoration('0x1', token);
    const [id, callback] = [...timers][0]; assert.equal(callback(), false); timers.delete(id);
    await settle(); assert.equal(await pending, null);
    assert.equal(processes[0].kills, 1); assert.equal(token.cancelled, false); assert.equal(token.callbacks.size, 0);
});

for (const failure of ['spawnError', 'startError', 'exitFailure']) {
    test(`process failure is contained: ${failure}`, async () => {
        reset({ [failure]: true }); const token = new Cancellable(); const pending = xprop.query_decoration('0x1', token);
        if (failure === 'exitFailure') processes[0].complete(output());
        await settle(); assert.equal(await pending, null); assert.equal(timers.size, 0); assert.equal(token.callbacks.size, 0);
    });
}

test('communication error kills process and resolves conservatively', async () => {
    reset(); const pending = xprop.query_decoration('0x1', null);
    processes[0].complete(null, new Error('read')); await settle();
    assert.equal(await pending, null); assert.equal(processes[0].kills, 1); assert.equal(timers.size, 0);
});

test('empty stdout is a successful write, not a failed command', async () => {
    reset(); const pending = xprop.set_hint('0x1', xprop.MOTIF_HINTS, xprop.HIDE_FLAGS, null);
    assert.deepEqual(processes[0].argv, ['xprop', '-id', '0x1', '-f', '_MOTIF_WM_HINTS', '32c', '-set', '_MOTIF_WM_HINTS', '0x2, 0x0, 0x0, 0x0, 0x0']);
    processes[0].complete(''); assert.equal(await pending, true); assert.equal(timers.size, 0);
});

function controller(hidden = false, canHide = true) {
    const state = { hidden }; let alive = true;
    const value = new DecorationController('0x1', state, () => alive, () => canHide);
    return { value, state, invalidate() { alive = false; } };
}
test('initial show requires no process when extension never hid title', async () => {
    reset(); const { value } = controller(); value.update(true); await settle(); assert.equal(processes.length, 0);
});

test('rapid updates during query coalesce to latest desired state', async () => {
    reset(); const { value, state } = controller(); value.update(false); value.update(true);
    assert.equal(processes.length, 1); processes[0].complete(output()); await settle();
    assert.equal(processes.length, 1); assert.equal(state.hidden, false);
});

test('writes are serialized and a later show restores a completed hide', async () => {
    reset(); const { value, state } = controller(); value.update(false);
    processes[0].complete(output()); await settle(); assert.equal(processes.length, 2);
    value.update(true); assert.equal(processes.length, 2);
    processes[1].complete(''); await settle(); assert.equal(processes.length, 3);
    processes[2].complete(output('2, 0, 0, 0, 0')); await settle();
    assert.equal(processes.length, 4); processes[3].complete(''); await settle();
    assert.equal(state.hidden, false); assert.equal(timers.size, 0);
});

test('client decorations, unsupported motif values, and blacklist skip writes', async () => {
    for (const [response, canHide] of [[output('2, 0, 1, 0, 0', '0, 0, 0, 0'), true], [output('2, 0, 10, 0, 0'), true], [output(), false]]) {
        reset(); const { value } = controller(false, canHide); value.update(false); processes[0].complete(response); await settle();
        assert.equal(processes.length, 1);
    }
});

test('disposed or invalidated windows never write after pending query', async () => {
    for (const dispose of [false, true]) {
        reset(); const item = controller(); item.value.update(false);
        if (dispose) item.value.dispose(); else item.invalidate();
        if (!dispose) processes[0].complete(output());
        await settle(); assert.equal(processes.length, 1); assert.equal(item.state.hidden, false);
    }
});

test('attempted hide ownership survives cancellation and can be restored after reenable', async () => {
    reset(); const item = controller(); item.value.update(false); processes[0].complete(output()); await settle();
    assert.equal(item.state.hidden, true); item.value.dispose(); item.value.dispose(); await settle();
    const next = new DecorationController('0x1', item.state, () => true, () => true);
    next.update(true); processes[2].complete(output('2, 0, 0, 0, 0')); await settle();
    processes[3].complete(''); await settle(); assert.equal(item.state.hidden, false);
});

const windowSource = readFileSync(new URL('../src/window.ts', import.meta.url), 'utf8');
const extensionSource = readFileSync(new URL('../src/extension.ts', import.meta.url), 'utf8');
const begin = windowSource.indexOf('    update_decoration(');
const end = windowSource.indexOf('    icon(', begin);
const methods = windowSource.slice(begin, end).replace('ext: Ext', 'ext').replaceAll(': void', '');
function windowFixture(wayland = false) {
    const Type = new Function('DecorationController', 'utils', `return class {
        decoration_state = { hidden: false }; decoration_controller = null;
        entity = [0, 0]; alive = true;
        xid() { return '0x1'; }
        actor_exists() { return this.alive; }
        ignore_decoration() { return false; }
        ${methods}
    }`)(DecorationController, { is_wayland: () => wayland });
    const win = new Type(); let active = true;
    const ext = { allows_window_io: () => active, windows: new Map([[win.entity, win]]), settings: { show_title: () => false } };
    return { win, ext, disable() { active = false; win.cancel_decoration(); } };
}

test('Wayland and inactive extension never launch xprop', async () => {
    reset(); const a = windowFixture(true); a.win.update_decoration(a.ext);
    const b = windowFixture(); b.disable(); b.win.update_decoration(b.ext);
    await settle(); assert.equal(processes.length, 0);
});

test('replaced window entity rejects stale decoration result', async () => {
    reset(); const { win, ext } = windowFixture(); win.update_decoration(ext);
    ext.windows.set(win.entity, {}); processes[0].complete(output()); await settle(); assert.equal(processes.length, 1);
});

test('initialization is after storage insertion and disable/destroy cancel requests', () => {
    assert.match(extensionSource, /this.windows.insert\(entity, win\);\s*win.update_decoration\(this\);/);
    assert.match(extensionSource, /window.destroying = true;\s*window.cancel_decoration\(\);/);
    assert.match(extensionSource, /ext.stop_events\(\);\s*ext.stop_exception_dialog\(\);\s*ext.stop_window_io\(\);/);
    assert.match(extensionSource, /ext.signals_attach\(\);\s*ext.refresh_window_decorations\(\);/);
    assert.match(extensionSource, /allows_window_io\(\): boolean \{\s*return this.events_enabled;/);
});
