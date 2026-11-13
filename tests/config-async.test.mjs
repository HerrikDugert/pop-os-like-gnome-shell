import test from 'node:test';
import assert from 'node:assert/strict';

let reads, writes, contents, syncReads;
const messages = [];
globalThis.log = message => messages.push(message);
globalThis.imports = { byteArray: { toString: bytes => new TextDecoder().decode(bytes) } };
globalThis.__configGLib = { get_user_config_dir: () => '/mock-config' };
globalThis.__configGio = {
    IOErrorEnum: { NOT_FOUND: 1 },
    io_error_quark: () => 1,
    FileCreateFlags: { NONE: 0 },
    File: { new_for_path(path) {
        assert.equal(path, '/mock-config/pop-shell/config.json');
        return {
            load_contents_async(cancel, done) { reads.push({ source: this, cancel, done }); },
            load_contents_finish(result) {
                if (result.error) throw result.error;
                return result.value;
            },
            query_exists: () => true,
            load_contents() { syncReads++; return [true, new TextEncoder().encode(contents)]; },
            replace_contents(text) { contents = text; writes++; return [true, 'saved-etag']; }
        };
    } }
};
const { Config } = await import('../target/config.js');
function reset() {
    reads = []; writes = 0; syncReads = 0; contents = '{}'; messages.length = 0;
}
function complete(index, text = '{}', options = {}) {
    const request = reads[index];
    assert.ok(request, `missing read ${index}`);
    const bytes = options.bytes ?? new TextEncoder().encode(text);
    request.done(request.source, {
        error: options.error,
        value: [true, bytes, options.etag ?? 'read-etag']
    });
}
function kept() {
    const config = new Config();
    config.float = [{ class: 'Keep' }];
    config.skiptaskbarhidden = [{ title: 'Keep hidden' }];
    config.log_on_focus = true;
    return config;
}
function unchanged(config) {
    assert.deepEqual(config.float, [{ class: 'Keep' }]);
    assert.deepEqual(config.skiptaskbarhidden, [{ title: 'Keep hidden' }]);
    assert.equal(config.log_on_focus, true);
}
function cancellable() {
    return { cancelled: false, is_cancelled() { return this.cancelled; }, cancel() { this.cancelled = true; } };
}

test('reload_async awaits real store loading and applies all fields', async () => {
    reset(); const config = kept();
    const pending = config.reload_async();
    unchanged(config); assert.equal(reads.length, 1);
    complete(0, JSON.stringify({ float: [{ class: 'New', match: 'exact' }],
        skiptaskbarhidden: [{ title: 'New hidden' }], log_on_focus: false }));
    assert.deepEqual(await pending, { tag: 0, value: true });
    assert.deepEqual(config.float, [{ class: 'New', match: 'exact' }]);
    assert.deepEqual(config.skiptaskbarhidden, [{ title: 'New hidden' }]);
    assert.equal(config.log_on_focus, false);
    assert.equal(writes, 0); assert.equal(syncReads, 0);
});

test('invalid JSON and schemas preserve last good state and return errors', async () => {
    reset();
    for (const text of ['{', 'null', '[]', '{"float":false}', '{"log_on_focus":1}']) {
        const config = kept(); const index = reads.length;
        const pending = config.reload_async(); complete(index, text);
        const result = await pending;
        assert.equal(result.tag, 1); assert.ok(result.why.length);
        unchanged(config);
    }
    assert.equal(writes, 0);
});

test('read errors preserve state and are returned to the caller', async () => {
    reset(); const config = kept(); const pending = config.reload_async();
    complete(0, '', { error: new Error('read denied') });
    const result = await pending;
    assert.equal(result.tag, 1); assert.match(result.why, /read denied/); unchanged(config);
});

test('invalid UTF-8 and missing ETags are not applied', async () => {
    reset();
    for (const options of [{ bytes: new Uint8Array([255]) }, { etag: '' }]) {
        const config = kept(); const index = reads.length;
        const pending = config.reload_async(); complete(index, '{}', options);
        assert.equal((await pending).tag, 1); unchanged(config);
    }
});

test('an older read cannot overwrite a newer successful read', async () => {
    reset(); const config = kept();
    const older = config.reload_async(); const newer = config.reload_async();
    complete(1, '{"float":[{"class":"Newest"}]}');
    assert.deepEqual(await newer, { tag: 0, value: true });
    complete(0, '{"float":[{"class":"Old"}]}');
    assert.deepEqual(await older, { tag: 0, value: false });
    assert.deepEqual(config.float, [{ class: 'Newest' }]);
});

test('a failed newer read still supersedes the older read', async () => {
    reset(); const config = kept();
    const older = config.reload_async(); const newer = config.reload_async();
    complete(1, '{'); assert.equal((await newer).tag, 1);
    complete(0); assert.deepEqual(await older, { tag: 0, value: false }); unchanged(config);
});

test('cancellation before start performs no read', async () => {
    reset(); const config = kept(); const cancel = cancellable(); cancel.cancel();
    assert.deepEqual(await config.reload_async(cancel), { tag: 0, value: false });
    assert.equal(reads.length, 0); unchanged(config);
});

test('cancellation in flight prevents a successful response from being applied', async () => {
    reset(); const config = kept(); const cancel = cancellable();
    const pending = config.reload_async(cancel); assert.strictEqual(reads[0].cancel, cancel);
    cancel.cancel(); complete(0);
    assert.deepEqual(await pending, { tag: 0, value: false }); unchanged(config);
});

test('a native cancellation error is discarded after token cancellation', async () => {
    reset(); const config = kept(); const cancel = cancellable();
    const pending = config.reload_async(cancel); cancel.cancel();
    complete(0, '', { error: new Error('operation cancelled') });
    assert.deepEqual(await pending, { tag: 0, value: false }); unchanged(config);
});

test('explicit invalidation protects against callbacks after deactivation', async () => {
    reset(); const config = kept(); const pending = config.reload_async();
    config.invalidate_load(); complete(0);
    assert.deepEqual(await pending, { tag: 0, value: false }); unchanged(config);
});

test('direct JSON application supersedes a pending read', async () => {
    reset(); const config = kept(); const pending = config.reload_async();
    assert.equal(config.load_from_json('{"float":[{"class":"Direct"}]}').tag, 0);
    complete(0); assert.deepEqual(await pending, { tag: 0, value: false });
    assert.deepEqual(config.float, [{ class: 'Direct' }]);
});

test('invalid direct JSON revokes an older read without losing valid state', async () => {
    reset(); const config = kept(); const pending = config.reload_async();
    assert.equal(config.load_from_json('{').tag, 1);
    complete(0); assert.deepEqual(await pending, { tag: 0, value: false });
    unchanged(config);
});

test('cancelled async mutation invalidates reads without serializing bookkeeping', async () => {
    reset(); const config = new Config(); const pending = config.reload_async();
    const cancel = cancellable(); cancel.cancel();
    const result = await config.add_app_exception_async('Local', cancel);
    assert.equal(result.tag, 1); assert.equal(result.persistence, 'not-started');
    complete(0); assert.deepEqual(await pending, { tag: 0, value: false });
    const expected = { float: [], skiptaskbarhidden: [], log_on_focus: false };
    assert.deepEqual(JSON.parse(config.to_json()), expected);
    assert.equal(contents, '{}'); assert.equal(writes, 0);
});

test('a missing file loads defaults in memory without creating or saving files', async () => {
    reset(); const config = kept(); const pending = config.reload_async();
    complete(0, '', { error: { matches: (domain, code) => domain === 1 && code === 1 } });
    assert.deepEqual(await pending, { tag: 0, value: true });
    assert.deepEqual(JSON.parse(config.to_json()), { float: [], skiptaskbarhidden: [], log_on_focus: false });
    assert.equal(writes, 0); assert.equal(syncReads, 0);
});

test('an obsolete read error is discarded, not reported as a current error', async () => {
    reset(); const config = kept(); const pending = config.reload_async();
    config.invalidate_load(); complete(0, '', { error: new Error('old error') });
    assert.deepEqual(await pending, { tag: 0, value: false }); unchanged(config);
});
