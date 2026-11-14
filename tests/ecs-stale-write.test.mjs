import test from 'node:test';
import assert from 'node:assert/strict';
import { World, Storage, StaleEntityError } from '../target/ecs.js';

const stale = operation => assert.throws(operation, StaleEntityError);

test('stale insert cannot overwrite a newer component', () => {
    const storage = new Storage(); storage.insert([0, 2], 'current');
    stale(() => storage.insert([0, 1], 'old'));
    assert.equal(storage.get([0, 2]), 'current'); assert.equal(storage.get([0, 1]), null);
});

test('stale get_or rejects before invoking its initializer', () => {
    const storage = new Storage(); storage.insert([0, 2], 'current'); let calls = 0;
    stale(() => storage.get_or([0, 1], () => { calls++; return 'old'; }));
    assert.equal(calls, 0); assert.equal(storage.get([0, 2]), 'current');
});

test('remove retains the generation fence for later insert', () => {
    const storage = new Storage(); storage.insert([0, 2], 'current'); storage.remove([0, 2]);
    stale(() => storage.insert([0, 1], 'old')); assert.equal(storage.is_empty(), true);
});

test('remove retains the generation fence for later get_or', () => {
    const storage = new Storage(); storage.insert([0, 2], 'current'); storage.remove([0, 2]);
    let calls = 0; stale(() => storage.get_or([0, 1], () => { calls++; return 'old'; }));
    assert.equal(calls, 0); assert.equal(storage.is_empty(), true);
});

test('same generation can be replaced and reinserted after component removal', () => {
    const storage = new Storage(); storage.insert([0, 2], 'first'); storage.insert([0, 2], 'second');
    assert.equal(storage.remove([0, 2]), 'second'); storage.insert([0, 2], 'third');
    assert.equal(storage.get([0, 2]), 'third');
});

test('a newer standalone generation advances the fence only for its own slot', () => {
    const storage = new Storage(); storage.insert([0, 10], 'a'); storage.insert([1, 0], 'b');
    storage.insert([0, 11], 'next'); stale(() => storage.insert([0, 10], 'old'));
    assert.equal(storage.get([0, 11]), 'next'); assert.equal(storage.get([1, 0]), 'b');
});

test('World rejects writes immediately after entity deletion, without slot reuse', () => {
    const world = new World(); const storage = world.register_storage(); const entity = world.create_entity();
    world.delete_entity(entity); stale(() => storage.insert(entity, 'resurrected'));
    stale(() => storage.get_or(entity, () => { throw new Error('initializer must not run'); }));
    assert.equal(storage.is_empty(), true);
});

test('World rejects an old generation before a new component was ever inserted', () => {
    const world = new World(); const storage = world.register_storage(); const old = world.create_entity();
    world.delete_entity(old); const current = world.create_entity();
    stale(() => storage.insert(old, 'stale')); let calls = 0;
    stale(() => storage.get_or(old, () => { calls++; return 'stale'; })); assert.equal(calls, 0);
    storage.insert(current, 'current'); assert.equal(storage.get(current), 'current');
});

test('invented future generations cannot poison a registered storage', () => {
    const world = new World(); const storage = world.register_storage(); const current = world.create_entity();
    const future = [current[0], current[1] + 10];
    stale(() => storage.insert(future, 'future')); stale(() => storage.get_or(future, () => 'future'));
    storage.insert(current, 'valid'); assert.equal(storage.get(current), 'valid');
});

test('unallocated World slots are rejected without creating entities', () => {
    const world = new World(); const storage = world.register_storage();
    stale(() => storage.insert([10, 0], 'fake')); assert.equal(world.capacity, 0);
    const entity = world.create_entity(); storage.insert(entity, 'valid'); assert.equal(storage.get(entity), 'valid');
});

for (const value of [false, 0, '', null, undefined]) {
    test(`registered storage retains falsy component ${String(value)}`, () => {
        const world = new World(); const storage = world.register_storage(); const entity = world.create_entity();
        storage.insert(entity, value);
        assert.equal(storage.get_or(entity, () => { throw new Error('unexpected initializer'); }), value);
        assert.equal(storage.contains(entity), true); assert.equal(storage.remove(entity), value);
        storage.insert(entity, value); assert.equal(storage.contains(entity), true);
    });
}

test('get_or detects entity deletion inside its initializer', () => {
    const world = new World(); const storage = world.register_storage(); const entity = world.create_entity();
    stale(() => storage.get_or(entity, () => { world.delete_entity(entity); return 'stale'; }));
    assert.equal(storage.is_empty(), true);
});

test('get_or cannot overwrite the reused entity created by its initializer', () => {
    const world = new World(); const storage = world.register_storage(); const old = world.create_entity(); let current;
    stale(() => storage.get_or(old, () => {
        world.delete_entity(old); current = world.create_entity(); storage.insert(current, 'current'); return 'old';
    }));
    assert.equal(storage.get(current), 'current'); assert.equal(storage.get(old), null);
});

test('get_or rejects reuse even when the new entity has no component yet', () => {
    const world = new World(); const storage = world.register_storage(); const old = world.create_entity(); let current;
    stale(() => storage.get_or(old, () => {
        world.delete_entity(old); current = world.create_entity(); return 'old';
    }));
    assert.equal(storage.is_empty(), true); storage.insert(current, 'current');
    assert.equal(storage.get(current), 'current');
});

test('initializer cannot evade a standalone fence by removing its newer component', () => {
    const storage = new Storage();
    stale(() => storage.get_or([0, 1], () => {
        storage.insert([0, 2], 'new'); storage.remove([0, 2]); return 'old';
    }));
    assert.equal(storage.is_empty(), true); stale(() => storage.insert([0, 1], 'old'));
});

test('reentrant insertion of the same entity wins over the outer initializer', () => {
    const world = new World(); const storage = world.register_storage(); const entity = world.create_entity();
    assert.equal(storage.get_or(entity, () => { storage.insert(entity, false); return 'outer'; }), false);
    assert.equal(storage.get(entity), false);
});

test('nested get_or returns the actually stored component instead of overwriting it', () => {
    const storage = new Storage(); const entity = [0, 0];
    const result = storage.get_or(entity, () => { storage.get_or(entity, () => 'inner'); return 'outer'; });
    assert.equal(result, 'inner'); assert.equal(storage.get(entity), 'inner');
});

test('failed initializer does not advance the fence or destroy a previous generation', () => {
    const storage = new Storage(); storage.insert([0, 1], 'valid');
    assert.throws(() => storage.get_or([0, 2], () => { throw new Error('initializer failed'); }), /initializer failed/);
    assert.equal(storage.get_or([0, 1], () => 'wrong'), 'valid');
});

test('initializer mutation of the supplied tuple cannot redirect the write', () => {
    const world = new World(); const storage = world.register_storage();
    const first = world.create_entity(), second = world.create_entity(); const supplied = [...first];
    assert.equal(storage.get_or(supplied, () => {
        supplied[0] = second[0]; supplied[1] = second[1]; return 'first';
    }), 'first');
    assert.equal(storage.get(first), 'first'); assert.equal(storage.get(second), null);
});

test('unregistered storage retains snapshot reads but cannot write a deleted entity', () => {
    const world = new World(); const storage = world.register_storage(); const entity = world.create_entity();
    storage.insert(entity, 'retained'); world.unregister_storage(storage); world.delete_entity(entity);
    assert.equal(storage.get(entity), 'retained'); stale(() => storage.insert(entity, 'late'));
    stale(() => storage.get_or(entity, () => 'late')); assert.equal(storage.get(entity), 'retained');
});

test('read and removal checks still leave a newer component intact', () => {
    const storage = new Storage(); storage.insert([0, 2], 'current'); const old = [0, 1];
    assert.equal(storage.get(old), null); assert.equal(storage.contains(old), false);
    assert.equal(storage.with(old, () => { throw new Error('must not run'); }), null);
    assert.equal(storage.remove(old), null);
    assert.equal(storage.take_with(old, () => { throw new Error('must not run'); }), null);
    assert.equal(storage.get([0, 2]), 'current');
});

const invalid = [null, undefined, [], [0], [0, 0, 0], [-1, 0], [0.5, 0], [NaN, 0],
    [Infinity, 0], [2 ** 32, 0], [0, -1], [0, 0.5], [0, NaN], [0, Infinity],
    [0, Number.MAX_SAFE_INTEGER + 1], ['0', 0], ['__proto__', 0], [0, '0']];
test('malformed identifiers are rejected before calling a validator or initializer', () => {
    let validated = 0, initialized = 0;
    const storage = new Storage(() => { validated++; return true; });
    for (const entity of invalid) {
        stale(() => storage.insert(entity, 'invalid'));
        stale(() => storage.get_or(entity, () => { initialized++; return 'invalid'; }));
    }
    assert.equal(validated, 0); assert.equal(initialized, 0); assert.equal(storage.is_empty(), true);
});

test('rejected writes do not advance a generation fence', () => {
    let allowed = false; const storage = new Storage(() => allowed);
    stale(() => storage.insert([0, 10], 'rejected')); allowed = true;
    storage.insert([0, 0], 'valid'); assert.equal(storage.get([0, 0]), 'valid');
});
