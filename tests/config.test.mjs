import test from 'node:test';
import assert from 'node:assert/strict';

const state = { contents: '{}', readError: false, readOK: true, writeError: false, writeOK: true, writes: 0 };
const messages = [];
globalThis.log = text => messages.push(text);
globalThis.imports = { byteArray: { toString: value => new TextDecoder().decode(value) } };
globalThis.__configGLib = { get_user_config_dir: () => '/mock-config' };
globalThis.__configGio = {
    FileCreateFlags: { NONE: 0 },
    File: { new_for_path: () => ({
        query_exists: () => true,
        load_contents() {
            if (state.readError) throw new Error('read denied');
            return [state.readOK, new TextEncoder().encode(state.contents)];
        },
        replace_contents(data) {
            if (state.writeError) throw new Error('write denied');
            if (!state.writeOK) return [false, null];
            state.contents = data; state.writes++;
            return [true, 'etag'];
        },
    }) },
};
const { Config, DEFAULT_FLOAT_RULES } = await import('../target/config.js');
function reset() {
    Object.assign(state, { contents: '{}', readError: false, readOK: true, writeError: false, writeOK: true, writes: 0 });
    messages.length = 0;
}

test('reload copies all persisted configuration fields', () => {
    reset();
    state.contents = JSON.stringify({ float: [{ class: 'custom' }], skiptaskbarhidden: [{ title: 'hidden' }], log_on_focus: true });
    const config = new Config(); config.reload();
    assert.deepEqual(config.float, [{ class: 'custom' }]);
    assert.deepEqual(config.skiptaskbarhidden, [{ title: 'hidden' }]);
    assert.equal(config.log_on_focus, true);
});

test('failed reload preserves last good state for malformed JSON and schema', () => {
    for (const contents of ['{', 'null', '[]', '42', '{"float":{}}', '{"skiptaskbarhidden":false}', '{"log_on_focus":"yes"}']) {
        reset();
        const config = new Config();
        config.float = [{ class: 'keep' }];
        config.skiptaskbarhidden = [{ title: 'keep' }];
        config.log_on_focus = true;
        state.contents = contents; config.reload();
        assert.deepEqual(config.float, [{ class: 'keep' }]);
        assert.deepEqual(config.skiptaskbarhidden, [{ title: 'keep' }]);
        assert.equal(config.log_on_focus, true);
        assert.equal(messages.length, 1);
    }
});

test('read exceptions and unsuccessful reads preserve configuration', () => {
    for (const failure of ['readError', 'readOK']) {
        reset(); state[failure] = failure === 'readError';
        const config = new Config(); config.float = [{ class: 'keep' }]; config.reload();
        assert.deepEqual(config.float, [{ class: 'keep' }]);
        assert.equal(messages.length, 1);
    }
});

test('empty valid configuration resets previous fields to defaults', () => {
    reset();
    const config = new Config(); config.float = [{ class: 'old' }];
    config.skiptaskbarhidden = [{ class: 'old' }]; config.log_on_focus = true;
    config.reload();
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

test('system exception toggles do not mutate defaults and are idempotent', () => {
    reset(); const snapshot = JSON.stringify(DEFAULT_FLOAT_RULES);
    const config = new Config();
    config.toggle_system_exception('Conky', undefined, true);
    config.toggle_system_exception('Conky', undefined, true);
    assert.deepEqual(config.float, [{ class: 'Conky', disabled: true }]);
    assert.equal(state.writes, 1);
    assert.equal(config.window_shall_float('Conky', ''), false);
    assert.equal(JSON.stringify(DEFAULT_FLOAT_RULES), snapshot);
    assert.notEqual(config.float[0], DEFAULT_FLOAT_RULES.find(rule => rule.class === 'Conky'));
    config.toggle_system_exception('Conky', undefined, false);
    assert.deepEqual(config.float, []);
    assert.equal(config.window_shall_float('Conky', ''), true);
    config.toggle_system_exception('Conky', undefined, false);
    assert.equal(state.writes, 2);
    assert.equal(JSON.stringify(DEFAULT_FLOAT_RULES), snapshot);
});

test('legacy duplicate overrides are all removed on reenable', () => {
    reset(); const config = new Config();
    config.float = [{ class: 'Conky', disabled: true }, { class: 'Keep' }, { class: 'Conky', disabled: true }];
    config.toggle_system_exception('Conky', undefined, false);
    assert.deepEqual(config.float, [{ class: 'Keep' }]);
    assert.equal(config.window_shall_float('Conky', ''), true);
});

test('unknown system exceptions do not remove user rules or write', () => {
    reset(); const config = new Config(); config.float = [{ class: 'Custom' }];
    config.toggle_system_exception('Custom', undefined, true);
    config.toggle_system_exception('Custom', undefined, false);
    assert.deepEqual(config.float, [{ class: 'Custom' }]);
    assert.equal(state.writes, 0);
});

test('user rule removal deletes all exact duplicates and preserves order', () => {
    reset(); const config = new Config();
    config.float = [{ class: 'A' }, { class: 'Keep1' }, { class: 'A' }, { class: 'Keep2' }, { class: 'A' }, { class: 'A', title: 'Specific' }];
    config.remove_user_exception('A', undefined);
    assert.deepEqual(config.float, [{ class: 'Keep1' }, { class: 'Keep2' }, { class: 'A', title: 'Specific' }]);
    assert.equal(state.writes, 1);
    config.remove_user_exception('Missing', undefined);
    assert.equal(state.writes, 1);
});

test('saving reports failures and returns success only on successful write', () => {
    reset(); const config = new Config();
    state.writeError = true;
    assert.equal(config.sync_to_disk(), false);
    assert.match(messages.at(-1), /failed to save config/);
    state.writeError = false; state.writeOK = false;
    assert.equal(config.sync_to_disk(), false);
    state.writeOK = true;
    assert.equal(config.sync_to_disk(), true);
    assert.equal(state.writes, 1);
    assert.deepEqual(JSON.parse(state.contents), { float: [], skiptaskbarhidden: [], log_on_focus: false });
});

test('public from_json retains its Config fallback API and logs errors', () => {
    reset();
    assert.ok(Config.from_json('{') instanceof Config);
    assert.equal(messages.length, 1);
});
