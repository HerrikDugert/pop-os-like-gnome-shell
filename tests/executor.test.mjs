import test from 'node:test';
import assert from 'node:assert/strict';

let serial = 0;
const sources = new Map();
const errors = [];
function add(_priority, callback) {
    const id = ++serial;
    sources.set(id, callback);
    return id;
}
globalThis.__executorGLib = {
    PRIORITY_DEFAULT: 0,
    idle_add: add,
    timeout_add(priority, _delay, callback) { return add(priority, callback); },
    source_remove(id) {
        assert.equal(sources.delete(id), true, `attempted removal of expired source ${id}`);
        return true;
    },
};
globalThis.logError = error => errors.push(error);
const { GLibExecutor, OnceExecutor, ChannelExecutor } = await import('../target/executor.js');

function tick() {
    for (const [id, callback] of [...sources]) {
        if (!sources.has(id)) continue;
        if (!callback()) sources.delete(id);
    }
}
function reset() { sources.clear(); errors.length = 0; }

test('queue survives exceptions, processes falsy events in FIFO order, and restarts', () => {
    reset();
    const executor = new GLibExecutor();
    const seen = [];
    const system = { run(value) { seen.push(value); if (value === 'bad') throw new Error('expected'); } };
    for (const value of ['bad', 0, false, undefined]) executor.wake(system, value);
    for (let i = 0; i < 4; i++) tick();
    assert.deepEqual(seen, ['bad', 0, false, undefined]);
    assert.equal(errors.length, 1);
    assert.equal(sources.size, 0);
    executor.wake(system, 'again');
    tick();
    assert.equal(seen.at(-1), 'again');
    executor.stop();
});

test('queue stop discards events and permits reentrant restart', () => {
    reset();
    const executor = new GLibExecutor();
    const seen = [];
    const system = { run(value) {
        seen.push(value);
        if (value === 1) { executor.stop(); executor.wake(system, 3); }
    } };
    executor.wake(system, 1);
    executor.wake(system, 2);
    tick(); tick();
    assert.deepEqual(seen, [1, 3]);
    executor.wake(system, 4);
    executor.stop(); tick();
    assert.deepEqual(seen, [1, 3]);
});

test('once handles undefined elements and cancels pending completion', () => {
    reset();
    const executor = new OnceExecutor([undefined]);
    const seen = [];
    let done = 0;
    executor.start(1, value => { seen.push(value); return true; }, () => done++);
    tick(); tick();
    assert.deepEqual(seen, [undefined]);
    assert.equal(sources.size, 1);
    executor.stop(); tick();
    assert.equal(done, 0);
});

test('once naturally completes and stop does not remove an expired source', () => {
    reset();
    const executor = new OnceExecutor([]);
    let done = 0;
    executor.start(1, () => true, () => done++);
    tick(); tick();
    assert.equal(done, 1);
    assert.equal(sources.size, 0);
    executor.stop(); executor.stop();
});

test('once clears source on false or exception', () => {
    for (const apply of [() => false, () => { throw new Error('expected'); }]) {
        reset();
        const executor = new OnceExecutor([1]);
        executor.start(1, apply);
        tick();
        assert.equal(sources.size, 0);
        executor.stop();
    }
});

test('once restart cancels old completion and survives restart inside apply', () => {
    reset();
    const executor = new OnceExecutor([1]);
    const seen = [];
    executor.start(1, () => true, () => seen.push('old'));
    tick(); tick();
    executor.start(1, () => {
        executor.start(1, value => { seen.push(value); return false; });
        return false;
    });
    tick(); tick(); tick();
    assert.deepEqual(seen, [1]);
    executor.stop();
});

test('once catches iterator and completion exceptions', () => {
    reset();
    const broken = { [Symbol.iterator]() { return { next() { throw new Error('iterator'); } }; } };
    const executor = new OnceExecutor(broken);
    executor.start(1, () => true); tick(); executor.stop();
    const empty = new OnceExecutor([]);
    empty.start(1, () => true, () => { throw new Error('completion'); });
    tick(); tick(); empty.stop();
    assert.equal(errors.length, 2);
    assert.equal(sources.size, 0);
});

test('channel delivers undefined, preserves remaining events on stop, and clears', () => {
    reset();
    const executor = new ChannelExecutor();
    const seen = [];
    executor.send(undefined); executor.send(2);
    executor.start(1, value => { seen.push(value); return false; });
    tick(); executor.stop();
    assert.deepEqual(seen, [undefined]);
    assert.equal(executor.length, 1);
    executor.start(1, value => { seen.push(value); return true; });
    tick(); tick(); executor.stop();
    assert.deepEqual(seen, [undefined, 2]);
    executor.send(3); executor.clear();
    assert.equal(executor.length, 0);
});

test('channel catches errors and allows restart inside callback', () => {
    reset();
    const executor = new ChannelExecutor();
    executor.send(1);
    executor.start(1, () => { throw new Error('expected'); });
    tick(); executor.stop();
    assert.equal(errors.length, 1);
    const seen = [];
    executor.send(2); executor.send(3);
    executor.start(1, value => {
        seen.push(value);
        executor.start(1, next => { seen.push(next); return false; });
        return false;
    });
    tick(); tick(); executor.stop();
    assert.deepEqual(seen, [2, 3]);
    assert.equal(sources.size, 0);
});
