import type { TimeoutBackend } from './extension_timers.js';

export interface FrameActor {
    connect(signal: string, callback: () => void): number;
    disconnect(signal: number): void;
}

interface FrameRequest {
    actor: FrameActor;
    frame: number | null;
    destroy: number | null;
    timeout: SignalID | null;
    done: boolean;
}

/** Race first-frame against a fallback, with one completion and joint cleanup. */
export class FirstFrames {
    private requests: Map<unknown, FrameRequest> = new Map();

    constructor(private backend: TimeoutBackend, private active: () => boolean,
        private generation: () => number, private report: (why: unknown) => void = () => {}) {}

    get size(): number { return this.requests.size; }

    private error(why: unknown): void {
        try { this.report(why); } catch (_) { }
    }

    private cleanup(request: FrameRequest): void {
        request.done = true;
        const { frame, destroy, timeout } = request;
        request.frame = null;
        request.destroy = null;
        request.timeout = null;
        if (timeout !== null) {
            try { this.backend.remove(timeout); } catch (why) { this.error(why); }
        }
        for (const signal of [frame, destroy]) {
            if (signal !== null) {
                try { request.actor.disconnect(signal); } catch (why) { this.error(why); }
            }
        }
    }

    cancel(key: unknown): void {
        const request = this.requests.get(key);
        if (!request) return;
        this.requests.delete(key);
        this.cleanup(request);
    }

    stop(): void {
        const requests = Array.from(this.requests.values());
        this.requests.clear();
        for (const request of requests) this.cleanup(request);
    }

    arm(key: unknown, actor: FrameActor, priority: number, delay: number,
        callback: () => void, valid: () => boolean): void {
        const request: FrameRequest = { actor, frame: null, destroy: null, timeout: null, done: false };
        const owns = () => this.requests.get(key) === request;
        const discard = () => {
            if (owns()) this.requests.delete(key);
            this.cleanup(request);
        };
        try {
            const generation = this.generation();
            const stable = () => owns() && this.active() && generation === this.generation();
            const current = () => !request.done && stable() && valid() && stable() && !request.done;
            const finish = () => {
                if (request.done || !owns()) return;
                try {
                    if (!current()) { discard(); return; }
                    // Keep the completed token visible through cleanup to detect reentrant replacements.
                    this.cleanup(request);
                    if (!stable() || !valid() || !stable()) {
                        if (owns()) this.requests.delete(key);
                        return;
                    }
                    this.requests.delete(key);
                    callback();
                } catch (why) { discard(); this.error(why); }
            };
            const previous = this.requests.get(key);
            this.requests.set(key, request);
            if (previous) this.cleanup(previous);
            if (!current()) { discard(); return; }
            request.destroy = actor.connect('destroy', () => {
                if (owns()) this.cancel(key);
            });
            if (!current()) { discard(); return; }
            try { request.frame = actor.connect('first-frame', finish); }
            catch (why) { this.error(why); }
            if (!current()) { discard(); return; }
            request.timeout = this.backend.add(priority, delay, () => {
                request.timeout = null;
                finish();
                return false;
            });
            if (!current()) discard();
        } catch (why) { discard(); this.error(why); }
    }
}
