import test from 'node:test';
import assert from 'node:assert/strict';

import { resetMemory, existing, readText, replaceCount, setFailure } from './config-memory-gio.mjs';
const state = {
    get contents() { return readText(); },
    set contents(value) { existing(value); },
    get writes() { return replaceCount(); },
    set readError(value) { setFailure('readError', value); },
    set readOK(value) { setFailure('readFalse', !value); },
    set writeError(value) { setFailure('replaceError', value); },
    set writeOK(value) { setFailure('replaceFalse', !value); },
};
const messages = [];
globalThis.log = text => messages.push(text);
const { Config, DEFAULT_FLOAT_RULES } = await import('../target/config.js');
function reset() {
    resetMemory(); existing(); messages.length = 0;
}

test('reload_async copies all persisted configuration fields', async () => {
    reset();
    state.contents = JSON.stringify({ float: [{ class: 'custom' }], skiptaskbarhidden: [{ title: 'hidden' }], log_on_focus: true });
    const config = new Config(); assert.deepEqual(await config.reload_async(), { tag: 0, value: true });
    assert.deepEqual(config.float, [{ class: 'custom' }]);
    assert.deepEqual(config.skiptaskbarhidden, [{ title: 'hidden' }]);
    assert.equal(config.log_on_focus, true);
});

test('failed async reload preserves last good state for malformed JSON and schema', async () => {
    for (const contents of ['{', 'null', '[]', '42', '{"float":{}}', '{"skiptaskbarhidden":false}', '{"log_on_focus":"yes"}']) {
        reset();
        const config = new Config();
        config.float = [{ class: 'keep' }];
        config.skiptaskbarhidden = [{ title: 'keep' }];
        config.log_on_focus = true;
        state.contents = contents; const result = await config.reload_async();
        assert.equal(result.tag, 1); assert.ok(result.why.length);
        assert.deepEqual(config.float, [{ class: 'keep' }]);
        assert.deepEqual(config.skiptaskbarhidden, [{ title: 'keep' }]);
        assert.equal(config.log_on_focus, true);
        assert.equal(messages.length, 0);
    }
});

test('async read exceptions and unsuccessful reads preserve configuration', async () => {
    for (const failure of ['readError', 'readOK']) {
        reset(); state[failure] = failure === 'readError';
        const config = new Config(); config.float = [{ class: 'keep' }];
        const result = await config.reload_async(); assert.equal(result.tag, 1); assert.ok(result.why.length);
        assert.deepEqual(config.float, [{ class: 'keep' }]);
        assert.equal(messages.length, 0);
    }
});

test('empty valid configuration resets previous fields to defaults', async () => {
    reset();
    const config = new Config(); config.float = [{ class: 'old' }];
    config.skiptaskbarhidden = [{ class: 'old' }]; config.log_on_focus = true;
    assert.deepEqual(await config.reload_async(), { tag: 0, value: true });
    assert.deepEqual(config.float, []);
    assert.deepEqual(config.skiptaskbarhidden, []);
    assert.equal(config.log_on_focus, false);
});

test('validation removes empty and invalid rules while preserving regex rules', () => {
    reset();
    const rules = [{}, { disabled: true }, { class: '' }, { title: '' }, [], null, { class: 3 }, { class: 'ok', disabled: 'yes' }, { class: '^App.*$', title: 'Doc' }, { title: 'Only title' }];
    const config = Config.from_json(JSON.stringify({ float: rules, skiptaskbarhidden: rules }));
    const expected = [{ class: '^App.*$', title: 'Doc' }, { title: 'Only title' }];
    assert.deepEqual(config.float, expected);
    assert.deepEqual(config.skiptaskbarhidden, expected);
    assert.equal(config.window_shall_float('Application', 'Doc'), true);
});

test('directly assigned empty rules never become match-all rules', () => {
    reset(); const config = new Config();
    config.float = [{}]; config.skiptaskbarhidden = [{}];
    assert.equal(config.window_shall_float('UnrelatedApp', 'UnrelatedTitle'), false);
    assert.equal(config.skiptaskbar_shall_hide({ get_wm_class: () => 'UnrelatedApp', get_title: () => 'UnrelatedTitle', is_skip_taskbar: () => true }), false);
});

test('system exception toggles do not mutate defaults and are idempotent', async () => {
    reset(); const snapshot = JSON.stringify(DEFAULT_FLOAT_RULES);
    const config = new Config();
    assert.equal((await config.toggle_system_exception_async('Conky', undefined, true)).tag, 0);
    assert.equal((await config.toggle_system_exception_async('Conky', undefined, true)).tag, 0);
    assert.deepEqual(config.float, [{ class: 'Conky', disabled: true }]);
    assert.equal(state.writes, 1);
    assert.equal(config.window_shall_float('Conky', ''), false);
    assert.equal(JSON.stringify(DEFAULT_FLOAT_RULES), snapshot);
    assert.notEqual(config.float[0], DEFAULT_FLOAT_RULES.find(rule => rule.class === 'Conky'));
    assert.equal((await config.toggle_system_exception_async('Conky', undefined, false)).tag, 0);
    assert.deepEqual(config.float, []);
    assert.equal(config.window_shall_float('Conky', ''), true);
    assert.equal((await config.toggle_system_exception_async('Conky', undefined, false)).tag, 0);
    assert.equal(state.writes, 2);
    assert.equal(JSON.stringify(DEFAULT_FLOAT_RULES), snapshot);
});

test('legacy duplicate overrides are all removed on reenable', async () => {
    reset(); const config = new Config();
    config.float = [{ class: 'Conky', disabled: true }, { class: 'Keep' }, { class: 'Conky', disabled: true }];
    state.contents = config.to_json();
    assert.equal((await config.toggle_system_exception_async('Conky', undefined, false)).tag, 0);
    assert.deepEqual(config.float, [{ class: 'Keep' }]);
    assert.equal(config.window_shall_float('Conky', ''), true);
});

test('unknown system exceptions do not remove user rules or write', async () => {
    reset(); const config = new Config(); config.float = [{ class: 'Custom' }];
    state.contents = config.to_json();
    assert.equal((await config.toggle_system_exception_async('Custom', undefined, true)).tag, 0);
    assert.equal((await config.toggle_system_exception_async('Custom', undefined, false)).tag, 0);
    assert.deepEqual(config.float, [{ class: 'Custom' }]);
    assert.equal(state.writes, 0);
});

test('user rule removal deletes all exact duplicates and preserves order', async () => {
    reset(); const config = new Config();
    config.float = [{ class: 'A' }, { class: 'Keep1' }, { class: 'A' }, { class: 'Keep2' }, { class: 'A' }, { class: 'A', title: 'Specific' }];
    state.contents = config.to_json();
    assert.equal((await config.remove_user_exception_async('A', undefined)).tag, 0);
    assert.deepEqual(config.float, [{ class: 'Keep1' }, { class: 'Keep2' }, { class: 'A', title: 'Specific' }]);
    assert.equal(state.writes, 1);
    assert.equal((await config.remove_user_exception_async('Missing', undefined)).tag, 0);
    assert.equal(state.writes, 1);
});

test('async saving reports thrown errors and unsuccessful results without false success', async () => {
    reset(); const config = new Config();
    state.writeError = true;
    let result = await config.add_app_exception_async('Saved');
    assert.equal(result.tag, 1); assert.equal(result.persistence, 'unknown');
    assert.deepEqual(config.float, []); assert.equal(state.contents, '{}');
    state.writeError = false; state.writeOK = false;
    result = await config.add_app_exception_async('Saved');
    assert.equal(result.tag, 1); assert.equal(result.persistence, 'unknown');
    assert.deepEqual(config.float, []); assert.equal(state.contents, '{}');
    state.writeOK = true;
    assert.deepEqual(await config.add_app_exception_async('Saved'), { tag: 0, value: { applied: true } });
    assert.equal(state.writes, 3);
    assert.deepEqual(JSON.parse(state.contents), {
        float: [{ class: 'Saved', match: 'exact' }], skiptaskbarhidden: [], log_on_focus: false
    });
    assert.deepEqual(JSON.parse(new Config().to_json()), { float: [], skiptaskbarhidden: [], log_on_focus: false });
});

test('removed synchronous Config APIs cannot be called again', () => {
    for (const method of ['reload', 'sync_to_disk', 'add_app_exception', 'add_window_exception',
        'toggle_system_exception', 'remove_user_exception']) assert.equal(typeof Config.prototype[method], 'undefined', method);
    for (const method of ['from_config', 'gio_file', 'read', 'write']) assert.equal(typeof Config[method], 'undefined', method);
});

test('public from_json retains its Config fallback API and logs errors', () => {
    reset();
    assert.ok(Config.from_json('{') instanceof Config);
    assert.equal(messages.length, 1);
});

function without_filesystem(action) {
    const original = globalThis.__configGio.File.new_for_path;
    let accesses = 0;
    globalThis.__configGio.File.new_for_path = () => {
        accesses++;
        throw new Error('Unexpected filesystem access');
    };
    try {
        action();
        assert.equal(accesses, 0);
    } finally {
        globalThis.__configGio.File.new_for_path = original;
    }
}

test('load_from_json applies all fields without filesystem I/O', () => {
    reset();
    without_filesystem(() => {
        const config = new Config();
        const result = config.load_from_json(JSON.stringify({
            float: [{ class: 'App.[1]', match: 'exact' }],
            skiptaskbarhidden: [{ title: 'Hidden' }],
            log_on_focus: true
        }));
        assert.deepEqual(result, { tag: 0, value: null });
        assert.deepEqual(config.float, [{ class: 'App.[1]', match: 'exact' }]);
        assert.deepEqual(config.skiptaskbarhidden, [{ title: 'Hidden' }]);
        assert.equal(config.log_on_focus, true);
        assert.equal(config.window_shall_float('App.[1]', 'Document'), true);
        assert.equal(config.window_shall_float('AppX1', 'Document'), false);
        assert.equal(state.writes, 0);
        assert.equal(messages.length, 0);
    });
});

test('load_from_json returns errors without changing last good state', () => {
    reset();
    without_filesystem(() => {
        for (const json of ['{', 'null', '[]', '42', '{"float":{}}',
            '{"skiptaskbarhidden":false}', '{"log_on_focus":"yes"}']) {
            const config = new Config();
            config.float = [{ class: 'Keep' }];
            config.skiptaskbarhidden = [{ title: 'Keep hidden' }];
            config.log_on_focus = true;
            const floats = config.float;
            const hidden = config.skiptaskbarhidden;
            const result = config.load_from_json(json);
            assert.equal(result.tag, 1);
            assert.equal(typeof result.why, 'string');
            assert.ok(result.why.length > 0);
            assert.strictEqual(config.float, floats);
            assert.strictEqual(config.skiptaskbarhidden, hidden);
            assert.deepEqual(config.float, [{ class: 'Keep' }]);
            assert.deepEqual(config.skiptaskbarhidden, [{ title: 'Keep hidden' }]);
            assert.equal(config.log_on_focus, true);
        }
        assert.equal(state.writes, 0);
        assert.equal(messages.length, 0);
    });
});

test('load_from_json resets omitted fields to defaults on valid input', () => {
    reset();
    without_filesystem(() => {
        const config = new Config();
        config.float = [{ class: 'Old' }];
        config.skiptaskbarhidden = [{ title: 'Old' }];
        config.log_on_focus = true;
        assert.equal(config.load_from_json('{}').tag, 0);
        assert.deepEqual(config.float, []);
        assert.deepEqual(config.skiptaskbarhidden, []);
        assert.equal(config.log_on_focus, false);
        assert.equal(state.writes, 0);
    });
});

test('load_from_json keeps existing rule validation and regex semantics', () => {
    reset();
    without_filesystem(() => {
        const config = new Config();
        assert.equal(config.load_from_json(JSON.stringify({
            float: [{}, null, { class: 3 }, { class: '^Legacy.*' }]
        })).tag, 0);
        assert.deepEqual(config.float, [{ class: '^Legacy.*' }]);
        assert.equal(config.window_shall_float('LegacyApp', 'Document'), true);
        assert.equal(state.writes, 0);
    });
});
