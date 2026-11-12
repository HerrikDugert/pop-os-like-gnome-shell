import type { Executor } from './executor.js';

/** A slot index paired with its generation. Never mutate an issued ID. */
export type Entity = [number, number];

export function entity_eq(a: Entity, b: Entity): boolean {
    return a[0] === b[0] && a[1] === b[1];
}

export function entity_new(pos: number, gen: number): Entity {
    return [pos, gen];
}

export class Storage<T> {
    private store: Array<[number, T] | null> = [];

    *_iter(): IterableIterator<[number, [number, T]]> {
        for (let idx = 0; idx < this.store.length; idx++) {
            const slot = this.store[idx];
            if (slot) yield [idx, slot];
        }
    }

    *iter(): IterableIterator<[Entity, T]> {
        for (const [idx, [gen, value]] of this._iter()) {
            yield [entity_new(idx, gen), value];
        }
    }

    *find(func: (value: T) => boolean): IterableIterator<Entity> {
        for (const [idx, [gen, value]] of this._iter()) {
            if (func(value)) yield entity_new(idx, gen);
        }
    }

    *values(): IterableIterator<T> {
        for (const [, [, value]] of this._iter()) yield value;
    }

    contains(entity: Entity): boolean {
        const slot = this.store[entity[0]];
        return slot != null && slot[0] === entity[1];
    }

    get(entity: Entity): T | null {
        const slot = this.store[entity[0]];
        return slot != null && slot[0] === entity[1] ? slot[1] : null;
    }

    get_or(entity: Entity, init: () => T): T {
        const slot = this.store[entity[0]];
        if (slot != null && slot[0] === entity[1]) return slot[1];
        const value = init();
        this.insert(entity, value);
        return value;
    }

    insert(entity: Entity, component: T) {
        this.store[entity[0]] = [entity[1], component];
    }

    is_empty(): boolean {
        for (const slot of this.store) if (slot) return false;
        return true;
    }

    remove(entity: Entity): T | null {
        const slot = this.store[entity[0]];
        if (slot == null || slot[0] !== entity[1]) return null;
        this.store[entity[0]] = null;
        return slot[1];
    }

    take_with<X>(entity: Entity, func: (component: T) => X): X | null {
        if (!this.contains(entity)) return null;
        return func(this.remove(entity) as T);
    }

    with<X>(entity: Entity, func: (component: T) => X): X | null {
        const slot = this.store[entity[0]];
        return slot != null && slot[0] === entity[1] ? func(slot[1]) : null;
    }
}

export class World {
    private entities_: Array<Entity> = [];
    private storages: Array<Storage<any>> = [];
    private tags_: Array<Set<any>> = [];
    private free_slots: Array<number> = [];
    private free_indices: Set<number> = new Set();

    get capacity(): number {
        return this.entities_.length;
    }

    get free(): number {
        return this.free_slots.length;
    }

    get length(): number {
        return this.capacity - this.free;
    }

    private is_alive(entity: Entity): boolean {
        const current = this.entities_[entity[0]];
        return current !== undefined && entity_eq(current, entity) && !this.free_indices.has(entity[0]);
    }

    tags(entity: Entity): any {
        if (!this.is_alive(entity)) throw new Error('Invalid or stale entity');
        return this.tags_[entity[0]];
    }

    *entities(): IterableIterator<Entity> {
        for (const entity of this.entities_) {
            if (!this.free_indices.has(entity[0])) yield entity;
        }
    }

    create_entity(): Entity {
        const slot = this.free_slots.pop();
        if (slot !== undefined) {
            const entity = entity_new(slot, this.entities_[slot][1] + 1);
            this.entities_[slot] = entity;
            this.free_indices.delete(slot);
            return entity;
        }
        const entity = entity_new(this.capacity, 0);
        this.entities_.push(entity);
        this.tags_.push(new Set());
        return entity;
    }

    delete_entity(entity: Entity) {
        if (!this.is_alive(entity)) return;
        this.tags_[entity[0]].clear();
        for (const storage of this.storages) storage.remove(entity);
        this.free_indices.add(entity[0]);
        this.free_slots.push(entity[0]);
    }

    add_tag(entity: Entity, tag: any) {
        if (this.is_alive(entity)) this.tags_[entity[0]].add(tag);
    }

    contains_tag(entity: Entity, tag: any): boolean {
        return this.is_alive(entity) && this.tags_[entity[0]].has(tag);
    }

    delete_tag(entity: Entity, tag: any) {
        if (this.is_alive(entity)) this.tags_[entity[0]].delete(tag);
    }

    register_storage<T>(): Storage<T> {
        const storage = new Storage<T>();
        this.storages.push(storage);
        return storage;
    }

    unregister_storage(storage: Storage<any>) {
        const index = this.storages.indexOf(storage);
        if (index !== -1) {
            this.storages[index] = this.storages[this.storages.length - 1];
            this.storages.pop();
        }
    }
}

export class System<T> extends World {
    #executor: Executor<T>;

    constructor(executor: Executor<T>) {
        super();
        this.#executor = executor;
    }

    register(event: T): void {
        this.#executor.wake(this, event);
    }

    run(_event: T): void {}
}
