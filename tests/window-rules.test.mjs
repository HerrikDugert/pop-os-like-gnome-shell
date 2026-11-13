import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { resetMemory, existing, replaceCount } from './config-memory-gio.mjs';
const messages = [];
globalThis.log = message => messages.push(message);
const { Config, rule_mode } = await import('../target/config.js');
test.beforeEach(() => { resetMemory(); existing(); messages.length = 0; });

for (const title of ['Project [test]', 'Document (', 'a.b', 'a*b', '^start$', 'path\\file', 'line\nnext']) {
    test(`selected title is literal: ${JSON.stringify(title)}`, async () => {
        const config = new Config();
        assert.equal((await config.add_window_exception_async('LiteralApp', title)).tag, 0);
        assert.deepEqual(config.float, [{ class: 'LiteralApp', title, match: 'exact' }]);
        assert.equal(config.window_shall_float('LiteralApp', title), true);
        assert.equal(config.window_shall_float('LiteralApp', `prefix ${title}`), false);
        assert.equal(config.window_shall_float('LiteralApp', `${title} suffix`), false);
    });
}

test('new application rules are exact, case-sensitive and deduplicated', async () => {
    const config = new Config(); const before = replaceCount();
    assert.equal((await config.add_app_exception_async('Literal.App')).tag, 0); assert.equal((await config.add_app_exception_async('Literal.App')).tag, 0);
    assert.equal(config.float.length, 1);
    assert.equal(replaceCount(), before + 1);
    assert.equal(config.window_shall_float('Literal.App', 'anything'), true);
    for (const app of ['literal.app', 'LiteralXApp', 'prefixLiteral.App']) {
        assert.equal(config.window_shall_float(app, 'anything'), false);
    }
});

test('legacy and explicit regex rules retain case-insensitive substring semantics', () => {
    for (const mode of [undefined, 'regex']) {
        const config = Config.from_json(JSON.stringify({ float: [{ class: 'Regex.App', match: mode }] }));
        assert.equal(rule_mode(config.float[0]), 'regex');
        assert.equal(config.window_shall_float('prefixregexXapp', ''), true);
    }
});

test('serialization and reload preserve exact and legacy modes', async () => {
    const config = new Config();
    config.float = [{ class: '^Legacy' }];
    existing(config.to_json());
    assert.equal((await config.add_window_exception_async('LiteralApp', 'Title [')).tag, 0);
    const loaded = new Config(); assert.deepEqual(await loaded.reload_async(), { tag: 0, value: true });
    assert.deepEqual(loaded.float, config.float);
    assert.equal(loaded.float[0].match, undefined);
    assert.equal(loaded.float[1].match, 'exact');
    assert.equal(loaded.window_shall_float('LiteralApp', 'Title ['), true);
});

test('duplicates are distinguished by mode and exact deletion preserves regex', async () => {
    const config = new Config(); config.float = [{ class: 'LiteralApp', title: 'Title' }];
    existing(config.to_json());
    assert.equal((await config.add_window_exception_async('LiteralApp', 'Title')).tag, 0);
    assert.equal((await config.add_window_exception_async('LiteralApp', 'Title')).tag, 0);
    assert.equal(config.float.length, 2);
    assert.equal((await config.remove_user_exception_async('LiteralApp', 'Title', 'exact')).tag, 0);
    assert.deepEqual(config.float, [{ class: 'LiteralApp', title: 'Title' }]);
});

test('legacy deletion removes implicit and explicit regex but not exact', async () => {
    const config = new Config();
    config.float = [{ class: 'LiteralApp' }, { class: 'LiteralApp', match: 'regex' }, { class: 'LiteralApp', match: 'exact' }];
    existing(config.to_json());
    assert.equal((await config.remove_user_exception_async('LiteralApp', undefined)).tag, 0);
    assert.deepEqual(config.float, [{ class: 'LiteralApp', match: 'exact' }]);
});

test('system toggles neither remove exact rules nor mistake them for regex overrides', async () => {
    const config = new Config();
    config.float = [{ class: 'Conky', match: 'exact' }];
    existing(config.to_json());
    assert.equal((await config.toggle_system_exception_async('Conky', undefined, true)).tag, 0);
    assert.equal(config.rule_disabled({ class: 'Conky' }), true);
    assert.equal(config.rule_disabled({ class: 'Conky', match: 'exact' }), false);
    assert.equal(config.float.length, 2);
    assert.equal((await config.toggle_system_exception_async('Conky', undefined, false)).tag, 0);
    assert.deepEqual(config.float, [{ class: 'Conky', match: 'exact' }]);
});

test('unknown match modes are rejected instead of becoming regex', () => {
    const config = Config.from_json(JSON.stringify({ float: [{ class: 'Bad', match: 'glob' }, { title: 'OK', match: 'exact' }] }));
    assert.deepEqual(config.float, [{ title: 'OK', match: 'exact' }]);
});

test('exact empty title matches only an empty title', async () => {
    const config = new Config(); assert.equal((await config.add_window_exception_async('LiteralApp', '')).tag, 0);
    assert.equal(config.window_shall_float('LiteralApp', ''), true);
    assert.equal(config.window_shall_float('LiteralApp', 'Other'), false);
});

test('skip-taskbar rules share exact and legacy matching and handle missing titles', () => {
    const config = new Config();
    config.skiptaskbarhidden = [{ class: 'Literal.App', title: '[Title]', match: 'exact' }];
    const window = (app, title, skip = true) => ({ get_wm_class: () => app, get_title: () => title, is_skip_taskbar: () => skip });
    assert.equal(config.skiptaskbar_shall_hide(window('Literal.App', '[Title]')), true);
    assert.equal(config.skiptaskbar_shall_hide(window('LiteralXApp', '[Title]')), false);
    assert.equal(config.skiptaskbar_shall_hide(window('Literal.App', null)), false);
    assert.equal(config.skiptaskbar_shall_hide(window('Literal.App', '[Title]', false)), false);
    config.skiptaskbarhidden = [{ title: '^legacy' }];
    assert.equal(config.skiptaskbar_shall_hide(window(null, 'LEGACY title')), true);
});

test('invalid regex is ignored without breaking subsequent exact rules', () => {
    messages.length = 0;
    const config = new Config(); config.float = [{ class: '(' }, { class: 'LiteralApp', match: 'exact' }];
    assert.equal(config.window_shall_float('LiteralApp', ''), true);
    assert.ok(messages.length >= 1);
});

const ui = readFileSync(new URL('../src/floating_exceptions/src/main.ts', import.meta.url), 'utf8');
test('dialog displays rule modes and its delete callback preserves the selected mode', () => {
    const begin = ui.indexOf('    add_rule(', ui.indexOf('export class MainView'));
    const end = ui.indexOf('\n}\n\nexport class ExceptionsView', begin);
    let method = ui.slice(begin, end);
    method = method.replace('wmclass: string | undefined', 'wmclass').replace('wmtitle: string | undefined', 'wmtitle').replace('match: config.MatchMode', 'match');
    for (const mode of ['exact', 'regex']) {
        const labels = []; let click; const events = [];
        const widget = () => new Proxy({}, { get: () => () => {} });
        const Gtk = {
            Label: { new(text) { labels.push(text); return widget(); } },
            Button: { new_from_icon_name() { return { set_valign() {}, connect(_event, callback) { click = callback; } }; } },
            Box: { new: widget }, IconSize: { BUTTON: 1 }, Align: { CENTER: 1 }, Orientation: { HORIZONTAL: 1 },
        };
        const view = new Function('Gtk', 'Pango', `return ({ ${method} });`)(Gtk, { EllipsizeMode: { END: 1 } });
        view.list = { add() {} }; view.callback = event => events.push(event);
        view.add_rule('LiteralApp', 'Title [', mode); click();
        assert.match(labels[0], mode === 'exact' ? /^\[Exact\]/ : /^\[Regex\]/);
        assert.deepEqual(events, [{ tag: 3, wmclass: 'LiteralApp', wmtitle: 'Title [', match: mode }]);
    }
});

test('dialog forwards mode from loaded rule through deletion handler', () => {
    assert.match(ui, /this.main_view.add_rule\(wmclass, wmtitle, config.rule_mode\(value\)\)/);
    assert.match(ui, /this.config.remove_user_exception_async\(event.wmclass, event.wmtitle, event.match, token\)/);
});
