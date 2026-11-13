import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const source = readFileSync(new URL('../src/extension.ts', import.meta.url), 'utf8');
const begin = source.indexOf('    private async reload_config_for_shell(');
const end = source.indexOf('    private async save_window_exception(', begin);
// The source-aware fixture below permits extracting just this helper if the next method differs.
const fallback = source.indexOf('    exception_add(', begin);
const helperEnd = end > begin ? end : fallback;
assert.ok(begin >= 0 && helperEnd > begin);
let helper = source.slice(begin, helperEnd).replace('private async ', 'async ')
    .replace('valid: () => boolean = () => true', 'valid = () => true')
    .replace('owner: Set<any> | null', 'owner').replace(': Promise<void>', '');
const stopStart = source.indexOf('    stop_exception_dialog() {');
const stopEnd = source.indexOf('    exception_dialog() {', stopStart);
const stop = source.slice(stopStart, stopEnd);
function fixture() {
    const requests = [];
    class Token { cancelled = false; cancel() { this.cancelled = true; } is_cancelled() { return this.cancelled; } }
    const Type = new Function('Gio', 'GLib', `return class {
        events_enabled = true; config_generation = 0; config_requests = new Set();
        exception_generation = 0; exception_reload_tokens = new Set();
        exception_ipc = null; exception_select_timer = null; exception_selecting = false;
        reapplied = 0; errors = [];
        tiling_config_reapply() { this.reapplied++; }
        config_error(message) { this.errors.push(message); }
        ${helper}
        ${stop}
    };`)({ Cancellable: Token }, {});
    const owner = new Type();
    owner.conf = { reload_async(token) { return new Promise((resolve, reject) => requests.push({ token, resolve, reject })); } };
    return { owner, requests };
}
test('replacing the IPC dialog cancels its native reload before Config can apply it', async () => {
    const f = fixture();
    const pending = f.owner.reload_config_for_shell(() => f.owner.exception_generation === 0, f.owner.exception_reload_tokens);
    assert.equal(f.owner.exception_reload_tokens.size, 1);
    f.owner.stop_exception_dialog(); assert.equal(f.requests[0].token.cancelled, true);
    f.requests[0].resolve({ tag: 0, value: false }); await pending;
    assert.equal(f.owner.reapplied, 0); assert.equal(f.owner.config_requests.size, 0);
    assert.equal(f.owner.exception_reload_tokens.size, 0);
});
test('a revoked IPC owner cannot start a reload', async () => {
    const f = fixture(); await f.owner.reload_config_for_shell(() => false, f.owner.exception_reload_tokens);
    assert.equal(f.requests.length, 0); assert.equal(f.owner.config_requests.size, 0);
});
test('late IPC read failures after owner cancellation have no visible effect', async () => {
    const f = fixture();
    const pending = f.owner.reload_config_for_shell(() => f.owner.exception_generation === 0, f.owner.exception_reload_tokens);
    f.owner.stop_exception_dialog(); f.requests[0].reject(new Error('late')); await pending;
    assert.deepEqual(f.owner.errors, []); assert.equal(f.owner.config_requests.size, 0);
});
test('IPC-owner teardown does not cancel unrelated Shell requests', async () => {
    const f = fixture();
    const owned = f.owner.reload_config_for_shell(() => f.owner.exception_generation === 0, f.owner.exception_reload_tokens);
    const separate = f.owner.reload_config_for_shell();
    f.owner.stop_exception_dialog();
    assert.equal(f.requests[0].token.cancelled, true); assert.equal(f.requests[1].token.cancelled, false);
    f.requests[0].resolve({ tag: 0, value: false }); await owned;
    f.requests[1].resolve({ tag: 0, value: true }); await separate;
    assert.equal(f.owner.reapplied, 1); assert.equal(f.owner.config_requests.size, 0);
});
