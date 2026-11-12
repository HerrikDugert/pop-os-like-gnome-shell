import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../src/extension.ts', import.meta.url), 'utf8');
const begin = source.indexOf('    start_events() {');
const end = source.indexOf('    /** Registers a generic callback', begin);
assert.ok(begin >= 0 && end > begin);
const methods = source.slice(begin, end).replace('register(event: ExtEvent): void', 'register(event)');
class Base {
    constructor() { this.pending = []; }
    register(event) { this.pending.push(event); }
}
const Lifecycle = new Function('Base', `return class extends Base {
    events_enabled = true;
    event_executor = { stop: () => { this.stops++; this.pending = []; } };
    stops = 0;
    ${methods}
}`)(Base);

test('disable clears pending events and rejects late registrations', () => {
    const instance = new Lifecycle();
    instance.register('before');
    instance.stop_events();
    instance.register('late');
    assert.deepEqual(instance.pending, []);
    assert.equal(instance.stops, 1);
});

test('reenable accepts new events without restoring discarded work', () => {
    const instance = new Lifecycle();
    instance.register('old');
    instance.stop_events();
    instance.start_events();
    instance.register('new');
    assert.deepEqual(instance.pending, ['new']);
});

test('repeated stop and start preserve the gate state', () => {
    const instance = new Lifecycle();
    instance.stop_events(); instance.stop_events();
    instance.register(0);
    assert.deepEqual(instance.pending, []);
    instance.start_events(); instance.start_events();
    instance.register(false);
    assert.deepEqual(instance.pending, [false]);
});

test('regular disable stops events before teardown but lock branch returns first', () => {
    const body = source.slice(source.indexOf('    disable() {', source.indexOf('export default class PopShellExtension')));
    assert.match(body, /if \(sessionMode.isLocked\) \{\s*ext.was_locked = true;\s*return;\s*\}\s*ext.stop_events\(\);/);
    assert.ok(body.indexOf('ext.stop_events();') < body.indexOf('ext.signals_remove();'));
});

test('enable resumes events before DBus and lock-resume return', () => {
    const body = source.slice(source.indexOf('export default class PopShellExtension'), source.indexOf('const handler = windowAttentionHandler'));
    assert.ok(body.indexOf('ext.start_events();') < body.indexOf('ext.dbus.start();'));
    assert.ok(body.indexOf('ext.start_events();') < body.indexOf('if (ext.was_locked)'));
});

test('constructor retains the executor passed to System', () => {
    assert.match(source, /const executor = new Executor.GLibExecutor<ExtEvent>\(\);\s*super\(executor\);\s*this.event_executor = executor;/);
});

test('signal teardown clears the stopped movement queue', () => {
    const body = source.slice(source.indexOf('    signals_remove() {'), source.indexOf('    size_changed_block() {'));
    assert.match(body, /this.tiler.queue.stop\(\);\s*this.tiler.queue.clear\(\);/);
});
