import test from 'node:test';
import assert from 'node:assert/strict';
import { World, Storage, entity_eq } from '../target/ecs.js';

test('entity equality includes generation', () => {
    assert.equal(entity_eq([7, 0], [7, 1]), false);
    assert.equal(entity_eq([7, 1], [7, 1]), true);
});

test('slot zero is reused without mutating old IDs', () => {
    const world = new World();
    const old = world.create_entity();
    world.delete_entity(old);
    const current = world.create_entity();
    assert.deepEqual(old, [0, 0]);
    assert.deepEqual(current, [0, 1]);
    assert.notEqual(old, current);
    assert.equal(world.capacity, 1);
    assert.equal(world.length, 1);
    assert.deepEqual([...world.entities()], [current]);
});

test('duplicate and stale deletions do not free a live slot', () => {
    const world = new World();
    const storage = world.register_storage();
    const old = world.create_entity();
    world.delete_entity(old);
    world.delete_entity(old);
    assert.equal(world.free, 1);
    const current = world.create_entity();
    storage.insert(current, 'live');
    world.add_tag(current, 'live');
    world.delete_entity(old);
    world.delete_tag(old, 'live');
    world.add_tag(old, 'stale');
    assert.equal(world.free, 0);
    assert.equal(storage.get(current), 'live');
    assert.equal(storage.get(old), null);
    assert.equal(world.contains_tag(current, 'live'), true);
    assert.equal(world.contains_tag(current, 'stale'), false);
    assert.equal(world.contains_tag(old, 'live'), false);
});

for (const value of [false, 0, '', null, undefined]) {
    test(`storage preserves and removes ${String(value)}`, () => {
        const storage = new Storage();
        const entity = [0, 0];
        storage.insert(entity, value);
        assert.equal(storage.contains(entity), true);
        assert.equal(storage.get_or(entity, () => { throw new Error('unexpected initialization'); }), value);
        assert.equal(storage.with(entity, v => Object.is(v, value)), true);
        assert.equal(storage.take_with(entity, v => Object.is(v, value)), true);
        assert.equal(storage.contains(entity), false);
        storage.insert(entity, value);
        assert.equal(storage.remove(entity), value);
        assert.equal(storage.is_empty(), true);
    });
}

test('unregistering the first or an unknown storage is safe', () => {
    const world = new World();
    const first = world.register_storage();
    const second = world.register_storage();
    const entity = world.create_entity();
    first.insert(entity, 'retained');
    second.insert(entity, 'removed');
    world.unregister_storage(first);
    world.unregister_storage(new Storage());
    world.delete_entity(entity);
    assert.equal(first.get(entity), 'retained');
    assert.equal(second.get(entity), null);
});
