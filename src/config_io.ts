import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

export interface ConfigSnapshot {
    readonly text: string | null;
    readonly etag: string | null;
}

export class ConfigConflictError extends Error {}
export class ConfigLockError extends Error {}
export class ConfigCapabilityError extends Error {}

function matches(error: any, code: number): boolean {
    return typeof error?.matches === 'function' && error.matches(Gio.io_error_quark(), code);
}

function operation<T>(start: (done: (source: any, result: any) => void) => void,
    finish: (source: any, result: any) => T): Promise<T> {
    return new Promise((resolve, reject) => {
        try {
            start((source, result) => {
                try { resolve(finish(source, result)); } catch (error) { reject(error); }
            });
        } catch (error) { reject(error); }
    });
}

async function close(stream: any): Promise<void> {
    await operation(done => stream.close_async(GLib.PRIORITY_DEFAULT, null, done),
        (source, result) => source.close_finish(result));
}

async function write_all_bytes(stream: any, data: Uint8Array, cancellable: any): Promise<void> {
    let offset = 0;
    while (offset < data.length) {
        // GBytes owns a native copy. Never hand an ephemeral raw-array buffer to async I/O.
        const remaining = new GLib.Bytes(data.subarray(offset));
        const written: number = await operation(done => stream.write_bytes_async(remaining,
            GLib.PRIORITY_DEFAULT, cancellable, done), (source, res) => source.write_bytes_finish(res));
        if (!Number.isSafeInteger(written) || written <= 0 || written > data.length - offset) {
            throw new Error('Incomplete configuration write');
        }
        offset += written;
    }
}

/** Filesystem backend only. Config and UI adoption is a separate migration. */
export class AsyncConfigStore {
    private file: any;
    private tail: Promise<void> = Promise.resolve();

    constructor(path: string) {
        this.file = Gio.File.new_for_path(path);
    }

    async load(cancellable: any = null): Promise<ConfigSnapshot> {
        try {
            const result: any = await operation(done => this.file.load_contents_async(cancellable, done),
                (source, res) => source.load_contents_finish(res));
            const [ok, bytes, etag] = result;
            if (!ok) throw new Error('Could not read configuration');
            if (typeof etag !== 'string' || etag.length === 0) {
                throw new ConfigCapabilityError('Backend supplies no ETag; protected replacement is unavailable');
            }
            return { text: new (globalThis as any).TextDecoder('utf-8', { fatal: true }).decode(bytes), etag };
        } catch (error) {
            if (matches(error, Gio.IOErrorEnum.NOT_FOUND)) return { text: null, etag: null };
            throw error;
        }
    }

    /** Pure synchronous transform; retried on conflict. Returning unchanged null preserves absence. */
    update(transform: (current: string | null) => string | null, cancellable: any = null): Promise<ConfigSnapshot> {
        const execute = () => this.locked_update(transform, cancellable);
        const pending = this.tail.then(execute, execute);
        this.tail = pending.then(() => undefined, () => undefined);
        return pending;
    }

    private async directory(dir: any, cancellable: any): Promise<void> {
        try {
            await operation(done => dir.make_directory_async(GLib.PRIORITY_DEFAULT, cancellable, done),
                (source, res) => source.make_directory_finish(res));
        } catch (error) {
            if (matches(error, Gio.IOErrorEnum.EXISTS)) return;
            if (!matches(error, Gio.IOErrorEnum.NOT_FOUND)) throw error;
            const parent = dir.get_parent();
            if (!parent) throw error;
            await this.directory(parent, cancellable);
            await this.directory(dir, cancellable);
        }
    }

    private check_cancelled(cancellable: any) {
        if (cancellable?.is_cancelled()) throw new Error('Configuration operation cancelled');
    }

    private async locked_update(transform: (current: string | null) => string | null,
        cancellable: any): Promise<ConfigSnapshot> {
        this.check_cancelled(cancellable);
        const dir = this.file.get_parent();
        if (!dir) throw new Error('Configuration has no parent directory');
        await this.directory(dir, cancellable);
        const lock = dir.get_child(this.file.get_basename() + '.lock');
        let stream: any;
        try {
            stream = await operation(done => lock.create_async(Gio.FileCreateFlags.PRIVATE,
                GLib.PRIORITY_DEFAULT, cancellable, done), (source, res) => source.create_finish(res));
        } catch (error) {
            if (matches(error, Gio.IOErrorEnum.EXISTS)) {
                throw new ConfigLockError('Configuration is locked; retry after the other writer completes');
            }
            throw error;
        }
        try {
            await close(stream);
            for (let attempt = 0; attempt < 3; attempt++) {
                this.check_cancelled(cancellable);
                const before = await this.load(cancellable);
                const text = transform(before.text);
                if (text === before.text) return before;
                if (typeof text !== 'string') throw new Error('Configuration transform must return text');
                try { return await this.replace(text, before, dir, cancellable); }
                catch (error) {
                    if (!(error instanceof ConfigConflictError) || attempt === 2) throw error;
                }
            }
            throw new ConfigConflictError('Configuration kept changing');
        } finally {
            // No cancelled token for releasing our own lock.
            await operation(done => lock.delete_async(GLib.PRIORITY_DEFAULT, null, done),
                (source, res) => source.delete_finish(res));
        }
    }

    private async replace(text: string, before: ConfigSnapshot, dir: any,
        cancellable: any): Promise<ConfigSnapshot> {
        this.check_cancelled(cancellable);
        const bytes = new (globalThis as any).TextEncoder().encode(text);
        if (before.text !== null) {
            const payload = new GLib.Bytes(bytes);
            if (!before.etag) throw new ConfigCapabilityError('Refusing an unprotected replacement');
            try {
                const result: any = await operation(done => this.file.replace_contents_bytes_async(payload,
                    before.etag, false, Gio.FileCreateFlags.PRIVATE, cancellable, done),
                    (source, res) => source.replace_contents_finish(res));
                if (!result[0]) throw new Error('Configuration replacement failed');
                // A successful write may not provide a new ETag; reload instead of guessing.
                if (typeof result[1] !== 'string' || !result[1]) return await this.load(cancellable);
                return { text, etag: result[1] };
            } catch (error) {
                if (matches(error, Gio.IOErrorEnum.WRONG_ETAG)) throw new ConfigConflictError('Configuration was edited externally');
                throw error;
            }
        }

        const temporary = dir.get_child('.' + this.file.get_basename() + '.' + GLib.uuid_string_random() + '.tmp');
        // Older GIO bindings may not expose move_async. Never fall back to blocking I/O
        // or to an unconditional replace that could overwrite a concurrent first writer.
        if (typeof temporary.move_async !== 'function') {
            throw new ConfigCapabilityError('Atomic first creation needs an async native-move binding');
        }
        let created = false;
        try {
            const stream: any = await operation(done => temporary.create_async(Gio.FileCreateFlags.PRIVATE,
                GLib.PRIORITY_DEFAULT, cancellable, done), (source, res) => source.create_finish(res));
            created = true;
            try {
                await write_all_bytes(stream, bytes, cancellable);
            } finally { await close(stream); }
            try {
                await operation(done => temporary.move_async(this.file, Gio.FileCopyFlags.NO_FALLBACK_FOR_MOVE,
                    GLib.PRIORITY_DEFAULT, cancellable, null, done), (source, res) => {
                    if (!source.move_finish(res)) throw new Error('Configuration move failed');
                });
                created = false;
            } catch (error) {
                if (matches(error, Gio.IOErrorEnum.EXISTS)) throw new ConfigConflictError('Configuration was created concurrently');
                throw error;
            }
            return await this.load(cancellable);
        } finally {
            if (created) {
                await operation(done => temporary.delete_async(GLib.PRIORITY_DEFAULT, null, done),
                    (source, res) => source.delete_finish(res));
            }
        }
    }
}
