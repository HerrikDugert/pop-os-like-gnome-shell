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
            return [!options.readFalse, bytes, options.noEtag ? null : entry.etag];
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
            if (options.replaceFalse) return [false, null];
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

export const filename = '/config/pop-shell/config.json';
export function resetMemory(settings = {}) {
    disk = new Map(); dirs = new Set(['/', '/config']); options = settings; serial = 0;
    records = { created: [], closed: [], deleted: [], reads: 0, replaces: 0, moves: 0 };
}
export function existing(text = '{}') {
    dirs.add('/config/pop-shell'); seed(filename, typeof text === 'string' ? text : JSON.stringify(text));
}
export function readText() { return disk.get(filename)?.text ?? null; }
export function replaceCount() { return records.replaces; }
export function setFailure(name, value) { options[name] = value; }
for (const method of ['query_exists', 'load_contents', 'replace_contents', 'create', 'make_directory']) {
    File.prototype[method] = function () { throw new Error(`Forbidden synchronous I/O: ${method}`); };
}
