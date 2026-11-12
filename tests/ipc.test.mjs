import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

let jobs = [], child, options, records, messages;
let serial = 0;
const timers = new Map();
const schedule = callback => jobs.push(callback);
function flush() {
    let remaining = 100;
    while (jobs.length) { assert.ok(remaining-- > 0, 'callback loop'); jobs.shift()(); }
}
function reset(settings = {}) {
    jobs = []; options = settings; messages = []; timers.clear();
    records = { closes: 0, kills: 0, finishes: 0, reads: 0, launcherCloses: 0 };
}
globalThis.log = message => messages.push(String(message));
globalThis.__ipcGLib = {
    PRIORITY_DEFAULT: 0, PRIORITY_LOW: 300,
    timeout_add(_priority, _delay, callback) { const id = ++serial; timers.set(id, callback); return id; },
    source_remove(id) { assert.equal(timers.delete(id), true); },
};
globalThis.__ipcGObject = {};
globalThis.__ipcMeta = {};
class Cancellable {
    cancelled = false;
    callbacks = [];
    cancel() {
        if (this.cancelled) return;
        this.cancelled = true;
        for (const callback of this.callbacks) callback();
    }
}
class Stream {
    busy = false;
    queued = [];
    pending = null;
    scheduled = false;
    close_async(_priority, _cancel, callback) {
        assert.equal(this.busy, false, 'close while read pending');
        records.closes++;
        schedule(() => callback(this, {}));
    }
    close_finish() { if (options.closeError) throw new Error('close failed'); return true; }
    emit(value) { this.queued.push(value); this.pump(); }
    pump() {
        if (!this.pending || this.scheduled || this.queued.length === 0) return;
        this.scheduled = true;
        const pending = this.pending;
        const value = this.queued.shift();
        schedule(() => pending.callback(this, { value, cancel: pending.cancel }));
    }
    read_line_async(_priority, cancel, callback) {
        if (options.readStartError) throw new Error('read start failed');
        assert.equal(this.busy, false, 'parallel read');
        this.busy = true; this.pending = { callback, cancel }; records.reads++;
        cancel.callbacks.push(() => {
            if (this.busy && !this.scheduled) this.emit(new Error('cancelled'));
        });
        this.pump();
    }
    read_line_finish_utf8(result) {
        this.busy = false; this.pending = null; this.scheduled = false; records.finishes++;
        if (result.cancel.cancelled) throw new Error('cancelled');
        if (result.value instanceof Error) throw result.value;
        return [result.value, result.value?.length ?? 0];
    }
}
class Child {
    input = new Stream(); output = new Stream(); ended = false; wait = null;
    get_stdin_pipe() { return this.input; }
    get_stdout_pipe() { return this.output; }
    wait_async(_cancel, callback) {
        if (options.waitStartError) throw new Error('wait setup failed');
        this.wait = callback;
    }
    wait_finish() { if (options.waitError) throw new Error('wait failed'); }
    get_successful() { return !options.exitFailure; }
    exit() { this.ended = true; schedule(() => this.wait?.(this, {})); }
    force_exit() { records.kills++; this.exit(); }
}
globalThis.__ipcGio = {
    Cancellable,
    SubprocessFlags: { STDIN_PIPE: 1, STDOUT_PIPE: 2 },
    SubprocessLauncher: class {
        spawnv(argv) {
            records.argv = argv;
            if (options.spawnError) throw new Error('spawn failed');
            child = new Child(); return child;
        }
        close() { records.launcherCloses++; }
    },
    DataOutputStream: class { constructor({ base_stream }) {
        if (options.outputWrapperError) throw new Error('output wrapper failed');
        return base_stream;
    } },
    DataInputStream: class { constructor({ base_stream }) {
        if (options.inputWrapperError) throw new Error('input wrapper failed');
        return base_stream;
    } },
};
const { async_process_ipc } = await import('../target/utils.js');

test('normal process exit drains final messages and EOF without cancelling early', () => {
    reset(); const ipc = async_process_ipc(['gjs', '--module', '/path with spaces/main.js']);
    const seen = []; let closed = 0;
    ipc.read_lines(line => { seen.push(line); return true; }, () => closed++);
    child.exit(); flush();
    assert.equal(ipc.cancellable.cancelled, false);
    child.output.emit('MODIFIED'); flush(); child.output.emit('SELECT'); flush();
    child.output.emit(null); flush();
    assert.deepEqual(seen, ['MODIFIED', 'SELECT']);
    assert.equal(closed, 1); assert.equal(records.closes, 2); assert.equal(records.kills, 0);
    assert.equal(ipc.disposed, true);
    assert.deepEqual(records.argv, ['gjs', '--module', '/path with spaces/main.js']);
});

test('failure exit also drains output, reports status, and leaves reader running', () => {
    reset({ exitFailure: true }); const ipc = async_process_ipc(['helper']); const seen = [];
    ipc.read_lines(line => { seen.push(line); return true; });
    child.exit(); flush(); child.output.emit('MODIFIED'); flush(); child.output.emit(null); flush();
    assert.deepEqual(seen, ['MODIFIED']);
    assert.ok(messages.some(message => message.includes('unsuccessfully')));
    assert.equal(records.kills, 0);
});

test('dispose cancels pending read, closes after finish, and kills only once', () => {
    reset(); const ipc = async_process_ipc(['helper']); const seen = []; let closed = 0;
    ipc.read_lines(line => { seen.push(line); return true; }, () => closed++);
    ipc.dispose(); ipc.dispose();
    assert.equal(records.closes, 0);
    flush();
    assert.deepEqual(seen, []); assert.equal(records.kills, 1); assert.equal(records.closes, 2);
    assert.equal(records.finishes, 1); assert.equal(closed, 1); assert.equal(messages.length, 0);
});

test('already queued data is ignored after disposal and finish is still called', () => {
    reset(); const ipc = async_process_ipc(['helper']); let called = false;
    ipc.read_lines(() => { called = true; return true; });
    child.output.emit('SELECT'); ipc.dispose(); flush();
    assert.equal(called, false); assert.equal(records.finishes, 1); assert.equal(records.closes, 2);
});

test('EOF closes both streams and does not schedule further reads', () => {
    reset(); const ipc = async_process_ipc(['helper']); let closed = 0;
    ipc.read_lines(() => true, () => closed++);
    child.output.emit(null); flush();
    assert.equal(records.reads, 1); assert.equal(records.closes, 2); assert.equal(closed, 0);
    child.exit(); flush(); assert.equal(records.kills, 0); assert.equal(closed, 1);
});

test('blank lines are delivered, not confused with EOF', () => {
    reset(); const ipc = async_process_ipc(['helper']); const seen = [];
    ipc.read_lines(line => { seen.push(line); return true; });
    child.output.emit(''); flush(); assert.deepEqual(seen, ['']);
    ipc.dispose(); flush();
});

test('false from line callback ends protocol and cleans up exactly once', () => {
    reset(); const ipc = async_process_ipc(['helper']); let count = 0;
    ipc.read_lines(() => { count++; return false; });
    child.output.emit('SELECT'); flush(); ipc.dispose(); flush();
    assert.equal(count, 1); assert.equal(records.reads, 1); assert.equal(records.closes, 2); assert.equal(records.kills, 1);
});

test('only one read loop is permitted and disposed handle cannot restart', () => {
    reset(); const ipc = async_process_ipc(['helper']);
    ipc.read_lines(() => true); ipc.read_lines(() => true);
    assert.equal(records.reads, 1);
    ipc.dispose(); flush(); ipc.read_lines(() => true); assert.equal(records.reads, 1);
});

for (const failure of ['spawnError', 'outputWrapperError', 'inputWrapperError', 'waitStartError']) {
    test(`startup failure cleans acquired resources: ${failure}`, () => {
        reset({ [failure]: true });
        assert.equal(async_process_ipc(['helper']), null); flush();
        assert.equal(records.launcherCloses, 1);
        assert.equal(records.kills, failure === 'spawnError' ? 0 : 1);
        assert.equal(records.closes, failure === 'spawnError' ? 0 : 2);
        assert.ok(messages.length > 0);
    });
}

for (const failure of ['readStartError', 'waitError', 'closeError']) {
    test(`asynchronous lifecycle failure is contained: ${failure}`, () => {
        reset({ [failure]: true }); const ipc = async_process_ipc(['helper']);
        ipc.read_lines(() => true);
        if (failure === 'waitError') child.exit();
        if (failure === 'closeError') ipc.dispose();
        flush();
        assert.equal(ipc.disposed, true); assert.equal(records.closes, 2);
        assert.ok(messages.length > 0);
    });
}

test('read and consumer exceptions terminate and close resources', () => {
    for (const consumerError of [false, true]) {
        reset(); const ipc = async_process_ipc(['helper']);
        ipc.read_lines(() => { if (consumerError) throw new Error('consumer'); return true; });
        child.output.emit(consumerError ? 'line' : new Error('read failed')); flush();
        assert.equal(ipc.disposed, true); assert.equal(records.closes, 2); assert.ok(messages.length > 0);
    }
});

test('closed callback exceptions and unavailable logger do not escape cleanup', () => {
    reset(); const ipc = async_process_ipc(['helper']); const logger = globalThis.log;
    globalThis.log = () => { throw new Error('logger unavailable'); };
    try {
        ipc.read_lines(() => true, () => { throw new Error('closed'); });
        ipc.dispose(); flush(); assert.equal(records.closes, 2);
    } finally { globalThis.log = logger; }
});

const extension = readFileSync(new URL('../src/extension.ts', import.meta.url), 'utf8');
const begin = extension.indexOf('    stop_exception_dialog() {');
const end = extension.indexOf('    exit_modes() {', begin);
assert.ok(begin >= 0 && end > begin);
const methods = extension.slice(begin, end)
    .replace('(line: string)', '(line)')
    .replace('generation: number =', 'generation =');
function fixture() {
    const handles = []; const queued = []; let shows = 0;
    const utils = { async_process_ipc() {
        const handle = { disposed: false, calls: 0,
            read_lines(line, closed) { this.line = line; this.closed = closed; },
            dispose() { this.calls++; this.disposed = true; this.closed?.(); },
        };
        handles.push(handle); return handle;
    } };
    const Type = new Function('utils', 'GLib', 'overview', 'get_current_path', `return class {
        events_enabled = true;
        exception_generation = 0;
        exception_ipc = null;
        exception_select_timer = null;
        exception_selecting = false;
        conf = { reload: () => { this.reloaded++; } };
        reloaded = 0;
        tiling_config_reapply() {}
        register_fn(callback) { queued.push(callback); }
        ${methods}
    }`.replace('queued.push(callback)', 'this.queued.push(callback)'))(utils, globalThis.__ipcGLib, { show() { shows++; } }, () => '/mock');
    const instance = new Type(); instance.queued = queued;
    return { instance, handles, queued, shows: () => shows };
}

test('dialog ignores repeated open and handles valid MODIFIED', () => {
    reset(); const { instance, handles, queued } = fixture();
    instance.exception_dialog(); instance.exception_dialog(); assert.equal(handles.length, 1);
    assert.equal(handles[0].line('MODIFIED'), true); queued.shift()(); assert.equal(instance.reloaded, 1);
});

test('disable and reenable invalidate queued and late responses from old dialog', () => {
    reset(); const { instance, handles, queued } = fixture();
    instance.exception_dialog(); const old = handles[0]; old.line('MODIFIED');
    instance.events_enabled = false; instance.stop_exception_dialog(); instance.events_enabled = true;
    instance.exception_dialog();
    queued.shift()(); assert.equal(instance.reloaded, 0);
    assert.equal(old.line('SELECT'), false); assert.equal(queued.length, 0);
    old.closed(); assert.equal(instance.exception_ipc, handles[1]);
});

test('SELECT survives normal protocol close and creates one tracked selection timer', () => {
    reset(); const { instance, handles, queued, shows } = fixture();
    instance.exception_dialog(); assert.equal(handles[0].line('SELECT'), false);
    handles[0].disposed = true; handles[0].closed(); queued.shift()();
    assert.equal(timers.size, 1);
    const [id, callback] = [...timers][0]; assert.equal(callback(), false); timers.delete(id);
    assert.equal(shows(), 1); assert.equal(instance.exception_select_timer, null);
});

test('disable removes selection timer; an already dispatched stale callback does nothing', () => {
    reset(); const { instance, shows } = fixture(); instance.exception_select();
    const stale = [...timers.values()][0];
    instance.events_enabled = false; instance.stop_exception_dialog(); instance.events_enabled = true;
    assert.equal(timers.size, 0); stale();
    assert.equal(shows(), 0); assert.equal(instance.exception_selecting, false);
});

test('replacing selection timer removes previous source; repeated cleanup is safe', () => {
    reset(); const { instance } = fixture(); instance.exception_select(); instance.exception_select();
    assert.equal(timers.size, 1); instance.stop_exception_dialog(); instance.stop_exception_dialog();
    assert.equal(timers.size, 0);
});

test('disabled extension does not spawn or schedule selection', () => {
    reset(); const { instance, handles } = fixture(); instance.events_enabled = false;
    instance.exception_dialog(); instance.exception_select();
    assert.equal(handles.length, 0); assert.equal(timers.size, 0);
});

test('regular disable disposes IPC after stopping events; lock early return remains', () => {
    const body = extension.slice(extension.indexOf('    disable() {', extension.indexOf('export default class PopShellExtension')));
    assert.match(body, /if \(sessionMode.isLocked\) \{\s*ext.was_locked = true;\s*return;\s*\}\s*ext.stop_events\(\);\s*ext.stop_exception_dialog\(\);/);
});

test('stale selection callback cannot erase a newer timer', () => {
    reset(); const { instance } = fixture(); instance.exception_select();
    const stale = [...timers.values()][0];
    instance.stop_exception_dialog(); instance.exception_select();
    const current = instance.exception_select_timer;
    stale();
    assert.equal(instance.exception_select_timer, current);
    assert.equal(timers.size, 1);
    instance.stop_exception_dialog(); assert.equal(timers.size, 0);
});

test('queued selection from a previous dialog generation does not open overview', () => {
    reset(); const { instance, handles, queued, shows } = fixture();
    instance.exception_dialog(); handles[0].line('SELECT');
    handles[0].disposed = true; handles[0].closed();
    instance.exception_dialog(); queued.shift()();
    assert.equal(timers.size, 0); assert.equal(shows(), 0);
});

test('EOF before process exit retains lifecycle ownership until exit or explicit disposal', () => {
    reset(); const ipc = async_process_ipc(['helper']); let closed = 0;
    ipc.read_lines(() => true, () => closed++);
    child.output.emit(null); flush();
    assert.equal(closed, 0);
    ipc.dispose(); flush();
    assert.equal(records.kills, 1); assert.equal(closed, 1); assert.equal(records.closes, 2);
});
