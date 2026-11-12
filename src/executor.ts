import type * as Ecs from './ecs.js';
import GLib from 'gi://GLib';

export interface Executor<T> {
    wake<S extends Ecs.System<T>>(system: S, event: T): void;
}

function report_error(error: unknown) {
    try {
        (globalThis as any).logError(error, 'pop-shell executor callback failed');
    } catch (_) {
        // Logging must not interrupt source cleanup or queue processing.
    }
}

/** Processes one FIFO event per mainloop dispatch. */
export class GLibExecutor<T> implements Executor<T> {
    #event_loop: SignalID | null = null;
    #events: Array<T> = [];

    wake<S extends Ecs.System<T>>(system: S, event: T): void {
        this.#events.unshift(event);
        if (this.#event_loop !== null) return;

        const signal = GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
            if (this.#event_loop !== signal) return false;
            if (this.#events.length > 0) {
                const next = this.#events.pop() as T;
                try {
                    system.run(next);
                } catch (error) {
                    report_error(error);
                }
            }
            if (this.#event_loop !== signal) return false;
            if (this.#events.length === 0) {
                this.#event_loop = null;
                return false;
            }
            return true;
        });
        this.#event_loop = signal;
    }

    stop() {
        const signal = this.#event_loop;
        this.#event_loop = null;
        this.#events = [];
        if (signal !== null) GLib.source_remove(signal);
    }
}

export class OnceExecutor<X, T extends Iterable<X>> {
    #iterable: T;
    #signal: SignalID | null = null;

    constructor(iterable: T) {
        this.#iterable = iterable;
    }

    start(delay: number, apply: (v: X) => boolean, then?: () => void) {
        this.stop();
        const iterator = this.#iterable[Symbol.iterator]();
        const signal = GLib.timeout_add(GLib.PRIORITY_DEFAULT, delay, () => {
            if (this.#signal !== signal) return false;
            try {
                const next = iterator.next();
                if (next.done) {
                    this.#signal = null;
                    if (then) {
                        const completion = GLib.timeout_add(GLib.PRIORITY_DEFAULT, delay, () => {
                            if (this.#signal !== completion) return false;
                            this.#signal = null;
                            try {
                                then();
                            } catch (error) {
                                report_error(error);
                            }
                            return false;
                        });
                        this.#signal = completion;
                    }
                    return false;
                }
                const keep = apply(next.value);
                if (this.#signal !== signal) return false;
                if (!keep) this.#signal = null;
                return keep;
            } catch (error) {
                if (this.#signal === signal) this.#signal = null;
                report_error(error);
                return false;
            }
        });
        this.#signal = signal;
    }

    stop() {
        const signal = this.#signal;
        this.#signal = null;
        if (signal !== null) GLib.source_remove(signal);
    }
}

export class ChannelExecutor<X> {
    #channel: Array<X> = [];
    #signal: SignalID | null = null;

    clear() {
        this.#channel = [];
    }

    get length(): number {
        return this.#channel.length;
    }

    send(v: X) {
        this.#channel.push(v);
    }

    start(delay: number, apply: (v: X) => boolean) {
        this.stop();
        const signal = GLib.timeout_add(GLib.PRIORITY_DEFAULT, delay, () => {
            if (this.#signal !== signal) return false;
            if (this.#channel.length === 0) return true;
            const event = this.#channel.shift() as X;
            try {
                const keep = apply(event);
                if (this.#signal !== signal) return false;
                if (!keep) this.#signal = null;
                return keep;
            } catch (error) {
                if (this.#signal === signal) this.#signal = null;
                report_error(error);
                return false;
            }
        });
        this.#signal = signal;
    }

    stop() {
        const signal = this.#signal;
        this.#signal = null;
        if (signal !== null) GLib.source_remove(signal);
    }
}
