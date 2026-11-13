import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path/posix';

let disk, dirs, options, serial, records;
const codes = { NOT_FOUND: 1, EXISTS: 2, WRONG_ETAG: 3, CANCELLED: 4 };
class IoError extends Error {
    constructor(code) { super(`mock I/O ${code}`); this.code = code; }
    matches(_domain, code) { return this.code === code; }
}
class Cancellable {
    cancelled = false;
    is_cancelled() { return this.cancelled; }
    cancel() { this.cancelled = true; }
}
function seed(name, text, etag = `v${++serial}`) { disk.set(name, { text, etag }); }
function schedule(source, cancel, callback, action) {
    queueMicrotask(() => {
        try {
            if (cancel?.is_cancelled()) throw new IoError(codes.CANCELLED);
            callback(source, { value: action() });
        } catch (error) { callback(source, { error }); }
    });
}
function finish(res) { if (res.error) throw res.error; return res.value; }
class Stream {
    constructor(name) { this.name = name; }
    written = new Uint8Array();
    write_bytes_async(payload, _priority, cancel, callback) {
        assert.ok(payload instanceof NativeBytes, 'async writes require native-owned bytes');
        schedule(this, cancel, callback, () => {
            if (options.writeError) throw new Error('write failed');
            const bytes = payload.get_data();
            const count = options.zeroWrite ? 0 : options.shortWrite ? Math.max(1, Math.floor(bytes.length / 2)) : bytes.length;
            const combined = new Uint8Array(this.written.length + count);
            combined.set(this.written); combined.set(bytes.subarray(0, count), this.written.length);
            this.written = combined;
            seed(this.name, new TextDecoder().decode(combined));
            return count;
        });
    }
    write_bytes_finish(res) { return finish(res); }
    close_async(_priority, cancel, callback) {
        assert.equal(cancel, null);
        schedule(this, cancel, callback, () => {
            records.closed.push(this.name);
            if (options.closeTempError && this.name.endsWith('.tmp')) throw new Error('close failed');
            return true;
        });
    }
    close_finish(res) { return finish(res); }
}
class File {
    constructor(name) {
        this.name = name;
        if (options.noMove) this.move_async = undefined;
    }
    get_parent() { return this.name === '/' ? null : new File(path.dirname(this.name)); }
    get_basename() { return path.basename(this.name); }
    get_child(name) { return new File(path.join(this.name, name)); }
    load_contents_async(cancel, callback) {
        if (options.holdRead?.(this, cancel, callback)) return;
        schedule(this, cancel, callback, () => {
            records.reads++;
            options.onRead?.(this.name, cancel);
            if (options.readError) throw new Error('read failed');
            const entry = disk.get(this.name);
            if (!entry) throw new IoError(codes.NOT_FOUND);
            const bytes = options.invalidUtf8 ? new Uint8Array([255]) : new TextEncoder().encode(entry.text);
            return [true, bytes, options.noEtag ? null : entry.etag];
        });
    }
    load_contents_finish(res) { return finish(res); }
    make_directory_async(_priority, cancel, callback) {
        schedule(this, cancel, callback, () => {
            if (dirs.has(this.name)) throw new IoError(codes.EXISTS);
            if (!dirs.has(path.dirname(this.name))) throw new IoError(codes.NOT_FOUND);
            dirs.add(this.name); return true;
        });
    }
    make_directory_finish(res) { return finish(res); }
    create_async(flags, _priority, cancel, callback) {
        assert.equal(flags, 1);
        schedule(this, cancel, callback, () => {
            if (disk.has(this.name)) throw new IoError(codes.EXISTS);
            if (!dirs.has(path.dirname(this.name))) throw new IoError(codes.NOT_FOUND);
            records.created.push(this.name); seed(this.name, ''); return new Stream(this.name);
        });
    }
    create_finish(res) { return finish(res); }
    replace_contents_bytes_async(payload, etag, backup, flags, cancel, callback) {
        assert.ok(payload instanceof NativeBytes, 'async replacement requires native-owned bytes');
        const bytes = payload.get_data();
        assert.equal(backup, false); assert.equal(flags, 1); assert.ok(etag);
        schedule(this, cancel, callback, () => {
            records.replaces++;
            options.onReplace?.(this.name);
            if (options.replaceError) throw new Error('replace failed');
            if (disk.get(this.name)?.etag !== etag) throw new IoError(codes.WRONG_ETAG);
            seed(this.name, new TextDecoder().decode(bytes));
            return [true, options.noNewEtag ? null : disk.get(this.name).etag];
        });
    }
    replace_contents_finish(res) { return finish(res); }
    move_async(destination, flags, _priority, cancel, progress, callback) {
        assert.equal(flags, 16); assert.equal(progress, null);
        schedule(this, cancel, callback, () => {
            options.beforeMove?.(destination.name);
            if (options.moveError) throw new Error('move unavailable');
            if (disk.has(destination.name)) throw new IoError(codes.EXISTS);
            assert.ok(disk.has(this.name));
            disk.set(destination.name, disk.get(this.name)); disk.delete(this.name);
            records.moves++; return true;
        });
    }
    move_finish(res) { return finish(res); }
    delete_async(_priority, cancel, callback) {
        assert.equal(cancel, null);
        schedule(this, cancel, callback, () => {
            records.deleted.push(this.name);
            options.onDelete?.(this.name);
            if (options.deleteError) throw new Error('cleanup failed');
            if (!disk.delete(this.name)) throw new IoError(codes.NOT_FOUND);
            return true;
        });
    }
    delete_finish(res) { return finish(res); }
}
globalThis.__configGio = {
    File: { new_for_path: name => new File(name) },
    FileCreateFlags: { PRIVATE: 1 }, FileCopyFlags: { NO_FALLBACK_FOR_MOVE: 16 },
    IOErrorEnum: codes, io_error_quark: () => 1,
};
class NativeBytes {
    constructor(data) { this.bytes = new Uint8Array(data); }
    get_data() { return this.bytes; }
}
globalThis.__configGLib = { get_user_config_dir: () => '/config', PRIORITY_DEFAULT: 0, uuid_string_random: () => `uuid-${++serial}`, Bytes: NativeBytes };
const messages = [];
globalThis.log = message => messages.push(message);
File.prototype.query_exists = function () { throw new Error('Unexpected synchronous filesystem I/O'); };
const { Config, DEFAULT_FLOAT_RULES } = await import('../target/config.js');
function reset(settings = {}) {
    disk = new Map(); dirs = new Set(['/', '/config']); options = settings; serial = 0; messages.length = 0;
    records = { created: [], closed: [], deleted: [], reads: 0, replaces: 0, moves: 0 };
}
const filename = '/config/pop-shell/config.json';
function existing(value = {}) {
    dirs.add('/config/pop-shell'); seed(filename, typeof value === 'string' ? value : JSON.stringify(value));
}
function saved() { return JSON.parse(disk.get(filename).text); }
function kept() { const config = new Config(); config.float = [{ class: 'MemoryOnly' }]; return config; }
function unchanged(config) { assert.deepEqual(config.float, [{ class: 'MemoryOnly' }]); }
function clean() {
    assert.deepEqual([...disk.keys()].filter(name => name !== filename), []);
    assert.deepEqual(messages, []);
}

test('save rebases on disk, preserves other fields and unknown keys, and applies only after completion', async () => {
    reset(); existing({ float: [{ class: 'DiskOnly' }], skiptaskbarhidden: [{ title: 'Hidden' }],
        log_on_focus: true, future: { title: 'Grüße — 日本語' } });
    const config = kept(); const pending = config.add_app_exception_async('New.[1]');
    unchanged(config);
    assert.deepEqual(await pending, { tag: 0, value: { applied: true } });
    assert.deepEqual(saved().float, [{ class: 'DiskOnly' }, { class: 'New.[1]', match: 'exact' }]);
    assert.deepEqual(config.float, saved().float);
    assert.deepEqual(config.skiptaskbarhidden, [{ title: 'Hidden' }]); assert.equal(config.log_on_focus, true);
    assert.deepEqual(saved().future, { title: 'Grüße — 日本語' });
    assert.deepEqual(Object.keys(JSON.parse(config.to_json())).sort(), ['float', 'log_on_focus', 'skiptaskbarhidden']);
    clean();
});

test('two queued intents preserve order and apply only the latest state', async () => {
    reset(); existing(); const config = new Config();
    const first = config.add_app_exception_async('First');
    const second = config.add_window_exception_async('Second', 'Title (literal)');
    assert.deepEqual(await first, { tag: 0, value: { applied: false } });
    assert.deepEqual(await second, { tag: 0, value: { applied: true } });
    assert.deepEqual(saved().float, [{ class: 'First', match: 'exact' },
        { class: 'Second', title: 'Title (literal)', match: 'exact' }]);
    assert.deepEqual(config.float, saved().float); clean();
});

test('duplicate additions preserve original file bytes without rewriting', async () => {
    reset(); const text = '{ "float": [{"class":"App", "match":"exact"}], "future": 3 }';
    existing(text); const config = kept();
    assert.equal((await config.add_app_exception_async('App')).tag, 0);
    assert.equal(disk.get(filename).text, text); assert.equal(records.replaces, 0);
    assert.deepEqual(config.float, [{ class: 'App', match: 'exact' }]); clean();
});

test('exact deletion removes all matching duplicates but preserves regex and order', async () => {
    reset(); existing({ float: [{ class: 'A', match: 'exact' }, { class: 'Keep' },
        { class: 'A', match: 'exact' }, { class: 'A' }, { class: 'A', title: 'Other', match: 'exact' }] });
    const config = new Config();
    assert.equal((await config.remove_user_exception_async('A', undefined, 'exact')).tag, 0);
    assert.deepEqual(saved().float, [{ class: 'Keep' }, { class: 'A' }, { class: 'A', title: 'Other', match: 'exact' }]);
    clean();
});

test('legacy deletion matches implicit and explicit regex only', async () => {
    reset(); existing({ float: [{ class: 'A' }, { class: 'A', match: 'regex' }, { class: 'A', match: 'exact' }] });
    const config = new Config(); await config.remove_user_exception_async('A', undefined);
    assert.deepEqual(saved().float, [{ class: 'A', match: 'exact' }]); clean();
});

test('system toggles are idempotent and never mutate default rules', async () => {
    reset(); existing(); const config = new Config(); const defaults = JSON.stringify(DEFAULT_FLOAT_RULES);
    await config.toggle_system_exception_async('Conky', undefined, true);
    await config.toggle_system_exception_async('Conky', undefined, true);
    assert.deepEqual(saved().float, [{ class: 'Conky', disabled: true }]); assert.equal(records.replaces, 1);
    await config.toggle_system_exception_async('Conky', undefined, false);
    assert.deepEqual(saved().float, []); assert.equal(records.replaces, 2);
    assert.equal(JSON.stringify(DEFAULT_FLOAT_RULES), defaults); clean();
});

test('a failed save does not poison subsequent queued operations', async () => {
    reset({ onReplace() { delete options.onReplace; throw new Error('one-shot write failure'); } });
    existing(); const config = kept();
    const first = config.add_app_exception_async('Failed'); const second = config.add_app_exception_async('Survives');
    assert.equal((await first).tag, 1);
    assert.deepEqual(await second, { tag: 0, value: { applied: true } });
    assert.deepEqual(saved().float, [{ class: 'Survives', match: 'exact' }]); clean();
});

test('malformed JSON and root schemas stay byte-for-byte unchanged', async () => {
    for (const text of ['{', 'null', '[]', '{"float":{}}', '{"skiptaskbarhidden":false}', '{"log_on_focus":"yes"}']) {
        reset(); existing(text); const config = kept();
        const result = await config.add_app_exception_async('New');
        assert.equal(result.tag, 1); unchanged(config);
        assert.equal(disk.get(filename).text, text); assert.equal(records.replaces, 0); clean();
    }
});

test('saving refuses invalid rules rather than silently erasing them', async () => {
    for (const rules of [[{}], [null], [{ class: 3 }], [{ class: 'A', match: 'glob' }]]) {
        reset(); existing({ float: rules }); const before = disk.get(filename).text; const config = kept();
        const result = await config.add_app_exception_async('New');
        assert.equal(result.tag, 1); assert.match(result.why, /invalid rules/);
        assert.equal(disk.get(filename).text, before); unchanged(config); clean();
    }
});

test('an ETag conflict retries the intent against external content without losing unknown keys', async () => {
    reset({ onReplace(name) { seed(name, '{"float":[{"class":"External"}],"future":7}'); delete options.onReplace; } });
    existing(); const config = kept();
    assert.equal((await config.add_app_exception_async('Local')).tag, 0);
    assert.deepEqual(saved().float, [{ class: 'External' }, { class: 'Local', match: 'exact' }]);
    assert.equal(saved().future, 7); assert.equal(records.replaces, 2); clean();
});

test('continuous ETag conflicts stop after three attempts without changing live state', async () => {
    reset({ onReplace(name) { seed(name, '{"future":99}'); } }); existing(); const config = kept();
    const result = await config.add_app_exception_async('Local');
    assert.equal(result.tag, 1); assert.equal(records.replaces, 3); unchanged(config);
    assert.deepEqual(saved(), { future: 99 }); clean();
});

test('a foreign lock remains owned by the foreign writer and the error is returned', async () => {
    reset(); existing(); seed(filename + '.lock', 'foreign'); const config = kept();
    const result = await config.add_app_exception_async('New');
    assert.equal(result.tag, 1); assert.match(result.why, /locked/); unchanged(config);
    assert.equal(disk.get(filename + '.lock').text, 'foreign'); assert.equal(records.replaces, 0);
});

for (const failure of ['readError', 'noEtag', 'invalidUtf8', 'replaceError']) {
    test(`failed save preserves disk and live state on ${failure}`, async () => {
        reset({ [failure]: true }); existing(); const before = disk.get(filename).text; const config = kept();
        const result = await config.add_app_exception_async('New');
        assert.equal(result.tag, 1); assert.equal(result.persistence, 'unknown');
        assert.equal(disk.get(filename).text, before); unchanged(config); clean();
    });
}

test('first creation persists complete data without adopting stale in-memory rules', async () => {
    reset(); const config = kept();
    assert.deepEqual(await config.add_window_exception_async('App', 'Grüße [1]'), { tag: 0, value: { applied: true } });
    assert.deepEqual(saved().float, [{ class: 'App', title: 'Grüße [1]', match: 'exact' }]);
    assert.equal(records.moves, 1); clean();
});

test('cancellation before start is explicitly not-started and does no filesystem I/O', async () => {
    reset(); const config = kept(); const cancel = new Cancellable(); cancel.cancel();
    const result = await config.add_app_exception_async('New', cancel);
    assert.equal(result.tag, 1); assert.equal(result.persistence, 'not-started'); unchanged(config);
    assert.equal(records.created.length, 0); assert.equal(records.reads, 0); assert.equal(disk.size, 0);
});

test('cancellation before replacement preserves data and releases the owned lock', async () => {
    const cancel = new Cancellable();
    reset({ onRead() { cancel.cancel(); } }); existing(); const config = kept(); const before = disk.get(filename).text;
    const result = await config.add_app_exception_async('New', cancel);
    assert.equal(result.tag, 1); unchanged(config); assert.equal(disk.get(filename).text, before); clean();
});

test('cancellation after persistence does not falsely report that nothing was saved', async () => {
    const cancel = new Cancellable();
    reset({ onDelete() { cancel.cancel(); } }); existing(); const config = kept();
    const result = await config.add_app_exception_async('Persisted', cancel);
    assert.deepEqual(result, { tag: 0, value: { applied: false } }); unchanged(config);
    assert.deepEqual(saved().float, [{ class: 'Persisted', match: 'exact' }]); clean();
});

test('invalidation suppresses late in-memory application, not an already persisted write', async () => {
    let config;
    reset({ onDelete() { config.invalidate_load(); } }); existing(); config = kept();
    const result = await config.add_app_exception_async('Persisted');
    assert.deepEqual(result, { tag: 0, value: { applied: false } }); unchanged(config);
    assert.deepEqual(saved().float, [{ class: 'Persisted', match: 'exact' }]); clean();
});

test('cleanup failure after writing reports unknown persistence and can be reconciled by reload', async () => {
    reset({ deleteError: true }); existing(); const config = kept();
    const result = await config.add_app_exception_async('Persisted');
    assert.equal(result.tag, 1); assert.equal(result.persistence, 'unknown'); unchanged(config);
    assert.deepEqual(saved().float, [{ class: 'Persisted', match: 'exact' }]);
    assert.equal(disk.has(filename + '.lock'), true);
    assert.deepEqual(await config.reload_async(), { tag: 0, value: true });
    assert.deepEqual(config.float, saved().float);
});

test('reload waits for queued writes and then loads their committed state', async () => {
    reset(); existing(); const config = kept();
    const write = config.add_app_exception_async('Saved'); const read = config.reload_async();
    assert.deepEqual(await write, { tag: 0, value: { applied: false } });
    assert.deepEqual(await read, { tag: 0, value: true });
    assert.deepEqual(config.float, [{ class: 'Saved', match: 'exact' }]); clean();
});

test('a new mutation supersedes an older in-flight reload', async () => {
    let held;
    reset({ holdRead(source, cancel, done) {
        held = { source, done }; delete options.holdRead; return true;
    } }); existing(); const config = kept(); const reload = config.reload_async();
    assert.ok(held);
    assert.equal((await config.add_app_exception_async('Saved')).tag, 0);
    held.done(held.source, { value: [true, new TextEncoder().encode('{}'), 'old-etag'] });
    assert.deepEqual(await reload, { tag: 0, value: false });
    assert.deepEqual(config.float, [{ class: 'Saved', match: 'exact' }]); clean();
});

test('newer direct state is not overwritten by an older write completion', async () => {
    let config;
    reset({ onDelete() { config.load_from_json('{"float":[{"class":"Direct"}]}'); } });
    existing(); config = kept();
    assert.deepEqual(await config.add_app_exception_async('Saved'), { tag: 0, value: { applied: false } });
    assert.deepEqual(config.float, [{ class: 'Direct' }]);
    assert.deepEqual(saved().float, [{ class: 'Saved', match: 'exact' }]); clean();
});

test('no-op mutations on an absent file do not create config.json', async () => {
    reset(); const config = new Config();
    assert.equal((await config.remove_user_exception_async('Absent', undefined)).tag, 0);
    assert.equal((await config.toggle_system_exception_async('NotASystemRule', undefined, true)).tag, 0);
    assert.equal((await config.add_app_exception_async('')).tag, 0);
    assert.equal(disk.has(filename), false); assert.equal(records.moves, 0); clean();
});

test('a successful earlier intent followed by a failure can be reconciled from disk', async () => {
    reset({ onReplace() { if (records.replaces === 2) throw new Error('second write failed'); } });
    existing(); const config = kept();
    const first = config.add_app_exception_async('First');
    const second = config.add_app_exception_async('Failed');
    assert.deepEqual(await first, { tag: 0, value: { applied: false } });
    assert.equal((await second).tag, 1); unchanged(config);
    assert.deepEqual(saved().float, [{ class: 'First', match: 'exact' }]);
    assert.deepEqual(await config.reload_async(), { tag: 0, value: true });
    assert.deepEqual(config.float, saved().float); clean();
});

test('separate Config instances respect the lock and retry against the latest file', async () => {
    reset(); existing(); const configs = [new Config(), new Config()];
    const names = ['First', 'Second'];
    const results = await Promise.all(configs.map((config, i) => config.add_app_exception_async(names[i])));
    assert.equal(results.filter(result => result.tag === 0).length, 1);
    const failed = results.findIndex(result => result.tag === 1);
    assert.match(results[failed].why, /locked/);
    assert.equal((await configs[failed].add_app_exception_async(names[failed])).tag, 0);
    assert.deepEqual(saved().float.map(rule => rule.class).sort(), [...names].sort()); clean();
});
