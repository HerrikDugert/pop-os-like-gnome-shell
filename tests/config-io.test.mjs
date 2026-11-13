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
        schedule(this, cancel, callback, () => {
            records.reads++;
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
            if (options.deleteError) throw new Error('cleanup failed');
            if (!disk.delete(this.name)) throw new IoError(codes.NOT_FOUND);
            return true;
        });
    }
    delete_finish(res) { return finish(res); }
}
globalThis.__configStoreGio = {
    File: { new_for_path: name => new File(name) },
    FileCreateFlags: { PRIVATE: 1 }, FileCopyFlags: { NO_FALLBACK_FOR_MOVE: 16 },
    IOErrorEnum: codes, io_error_quark: () => 1,
};
class NativeBytes {
    constructor(data) { this.bytes = new Uint8Array(data); }
    get_data() { return this.bytes; }
}
globalThis.__configStoreGLib = { PRIORITY_DEFAULT: 0, uuid_string_random: () => `uuid-${++serial}`, Bytes: NativeBytes };
const { AsyncConfigStore, ConfigConflictError, ConfigLockError, ConfigCapabilityError } = await import('../target/config_io.js');
function reset(settings = {}) {
    disk = new Map(); dirs = new Set(['/', '/config']); options = settings; serial = 0;
    records = { created: [], closed: [], deleted: [], reads: 0, replaces: 0, moves: 0 };
}
const filename = '/config/pop-shell/config.json';
const store = () => new AsyncConfigStore(filename);
function existing(text = '{"count":0}') { dirs.add('/config/pop-shell'); seed(filename, text); }
function clean() { assert.deepEqual([...disk.keys()].filter(name => name !== filename), []); }
const increment = text => JSON.stringify({ ...JSON.parse(text ?? '{}'), count: (JSON.parse(text ?? '{}').count ?? 0) + 1 });

test('load is asynchronous and returns text with its ETag', async () => {
    reset(); existing(); let done = false;
    const pending = store().load().then(value => { done = true; return value; });
    assert.equal(done, false);
    const snapshot = await pending;
    assert.equal(snapshot.text, '{"count":0}'); assert.ok(snapshot.etag);
    assert.equal(records.created.length, 0);
});

test('loading a missing file does not create directories or files', async () => {
    reset(); assert.deepEqual(await store().load(), { text: null, etag: null });
    assert.equal(disk.size, 0); assert.equal(dirs.has('/config/pop-shell'), false);
});

test('existing configuration is replaced with the expected ETag', async () => {
    reset(); existing(); const snapshot = await store().update(increment);
    assert.equal(snapshot.text, '{"count":1}'); assert.equal(disk.get(filename).text, snapshot.text);
    assert.equal(records.replaces, 1); clean();
});

test('two queued updates on one store preserve order', async () => {
    reset(); existing(); const file = store();
    const snapshots = await Promise.all([file.update(increment), file.update(increment)]);
    assert.equal(snapshots[0].text, '{"count":1}'); assert.equal(snapshots[1].text, '{"count":2}'); clean();
});

test('an unchanged transform avoids rewriting the file', async () => {
    reset(); existing(); const before = disk.get(filename).etag;
    await store().update(text => text);
    assert.equal(records.replaces, 0); assert.equal(disk.get(filename).etag, before); clean();
});

test('first creation uses a complete private temporary file and non-overwriting native move', async () => {
    reset(); const result = await store().update(increment);
    assert.equal(result.text, '{"count":1}'); assert.equal(records.moves, 1);
    assert.ok(records.created.some(name => name.endsWith('.tmp')));
    assert.ok(records.closed.some(name => name.endsWith('.tmp'))); clean();
});

test('concurrent first creation is reread and transformed, not overwritten blindly', async () => {
    reset({ beforeMove(name) { seed(name, '{"count":10,"external":true}'); delete options.beforeMove; } });
    const result = await store().update(increment);
    assert.deepEqual(JSON.parse(result.text), { count: 11, external: true }); clean();
});

test('external ETag conflict rereads latest content before retry', async () => {
    reset({ onReplace(name) { seed(name, '{"count":10,"external":true}'); delete options.onReplace; } }); existing();
    const result = await store().update(increment);
    assert.deepEqual(JSON.parse(result.text), { count: 11, external: true }); assert.equal(records.replaces, 2); clean();
});

test('continuously changing configuration stops after three attempts', async () => {
    reset({ onReplace(name) { seed(name, '{"count":99}'); } }); existing();
    await assert.rejects(store().update(increment), ConfigConflictError);
    assert.equal(records.replaces, 3); assert.equal(disk.get(filename).text, '{"count":99}'); clean();
});

test('separate stores respect the same exclusive lock and can retry later', async () => {
    reset(); existing(); const first = store(), second = store();
    const results = await Promise.allSettled([first.update(increment), second.update(increment)]);
    assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
    assert.ok(results.find(result => result.status === 'rejected').reason instanceof ConfigLockError);
    await second.update(increment); assert.equal(disk.get(filename).text, '{"count":2}'); clean();
});

test('pre-existing lock is not removed by a writer that does not own it', async () => {
    reset(); existing(); seed(filename + '.lock', 'other writer');
    await assert.rejects(store().update(increment), ConfigLockError);
    assert.equal(disk.get(filename + '.lock').text, 'other writer'); assert.equal(records.deleted.length, 0);
});

test('a failed update does not poison the queue', async () => {
    reset(); existing(); const file = store();
    await assert.rejects(file.update(() => { throw new Error('invalid config'); }), /invalid config/);
    assert.equal((await file.update(increment)).text, '{"count":1}'); clean();
});

test('malformed JSON stays unchanged when the transformer rejects it', async () => {
    reset(); existing('{'); await assert.rejects(store().update(increment));
    assert.equal(disk.get(filename).text, '{'); assert.equal(records.replaces, 0); clean();
});

test('cancellation before start does no filesystem writes', async () => {
    reset(); existing(); const cancel = new Cancellable(); cancel.cancel();
    await assert.rejects(store().update(increment, cancel), /cancelled/);
    assert.equal(records.created.length, 0); assert.equal(records.replaces, 0);
});

test('cancellation during transform releases owned lock without writing', async () => {
    reset(); existing(); const cancel = new Cancellable();
    await assert.rejects(store().update(text => { cancel.cancel(); return increment(text); }, cancel));
    assert.equal(disk.get(filename).text, '{"count":0}'); clean();
});

for (const failure of ['readError', 'noEtag', 'invalidUtf8', 'replaceError']) {
    test(`existing data is preserved on ${failure}`, async () => {
        reset({ [failure]: true }); existing();
        await assert.rejects(store().update(increment));
        assert.equal(disk.get(filename).text, '{"count":0}'); clean();
    });
}

for (const failure of ['writeError', 'zeroWrite', 'closeTempError', 'moveError', 'noMove']) {
    test(`first creation fails safely on ${failure}`, async () => {
        reset({ [failure]: true });
        await assert.rejects(store().update(increment));
        assert.equal(disk.has(filename), false); assert.equal(disk.size, 0);
    });
}

test('new ETag missing from replace result causes a fresh load', async () => {
    reset({ noNewEtag: true }); existing();
    const snapshot = await store().update(increment);
    assert.equal(snapshot.text, '{"count":1}'); assert.ok(snapshot.etag); assert.equal(records.reads, 2); clean();
});

test('missing asynchronous native-move support is an explicit capability error', async () => {
    reset({ noMove: true }); await assert.rejects(store().update(increment), ConfigCapabilityError);
    assert.equal(disk.size, 0);
});

test('cleanup failure is reported rather than claiming a clean success', async () => {
    reset({ deleteError: true }); existing();
    await assert.rejects(store().update(increment), /cleanup failed/);
    assert.equal(disk.get(filename).text, '{"count":1}');
    assert.equal(disk.has(filename + '.lock'), true);
});

test('partial native-byte writes advance the offset without duplicating content', async () => {
    reset({ shortWrite: true });
    const text = JSON.stringify({ title: 'Grüße — 日本語', count: 1 });
    const snapshot = await store().update(() => text);
    assert.equal(snapshot.text, text); assert.equal(disk.get(filename).text, text); clean();
});

test('Unicode survives both first creation and ETag-protected replacement', async () => {
    reset(); const file = store();
    const first = JSON.stringify({ title: 'Grüße — 日本語' });
    const second = JSON.stringify({ title: 'Änderung 🐧', count: 2 });
    assert.equal((await file.update(() => first)).text, first);
    assert.equal((await file.update(() => second)).text, second);
    assert.equal((await file.load()).text, second); clean();
});

test('unchanged null keeps an absent configuration absent', async () => {
    reset(); const snapshot = await store().update(current => current);
    assert.deepEqual(snapshot, { text: null, etag: null });
    assert.equal(disk.has(filename), false); assert.equal(records.moves, 0); clean();
});

test('null cannot erase an existing configuration', async () => {
    reset(); existing();
    await assert.rejects(store().update(() => null), /must return text/);
    assert.equal(disk.get(filename).text, '{"count":0}'); assert.equal(records.replaces, 0); clean();
});
