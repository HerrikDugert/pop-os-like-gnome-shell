export interface TimeoutBackend {
    add(priority: number, delay: number, callback: () => boolean): SignalID;
    remove(source: SignalID): void;
}

interface TimeoutRequest {
    source: SignalID | null;
}

/** One replaceable timeout per key, owned by an activation rather than an ID. */
export class ExtensionTimers {
    private requests: Map<unknown, TimeoutRequest> = new Map();

    constructor(private backend: TimeoutBackend, private active: () => boolean,
        private generation: () => number, private report: (why: unknown) => void = () => {}) {}

    get size(): number { return this.requests.size; }

    private error(why: unknown): void {
        try { this.report(why); } catch (_) { }
    }

    private remove(request: TimeoutRequest): void {
        const source = request.source;
        request.source = null;
        if (source !== null) {
            try { this.backend.remove(source); }
            catch (why) { this.error(why); }
        }
    }

    cancel(key: unknown): void {
        const request = this.requests.get(key);
        if (!request) return;
        this.requests.delete(key);
        this.remove(request);
    }

    stop(): void {
        const requests = Array.from(this.requests.values());
        this.requests.clear();
        for (const request of requests) this.remove(request);
    }

    schedule(key: unknown, priority: number, delay: number, callback: (current: () => boolean) => boolean,
        valid: () => boolean = () => true): void {
        const request: TimeoutRequest = { source: null };
        const owns = () => this.requests.get(key) === request;
        const release = () => {
            if (owns()) this.requests.delete(key);
            request.source = null;
        };
        try {
            const generation = this.generation();
            const stable = () => owns() && this.active() && generation === this.generation();
            const current = () => stable() && valid() && stable();
            const previous = this.requests.get(key);
            this.requests.set(key, request);
            if (previous) this.remove(previous);
            if (!current()) { release(); return; }
            request.source = this.backend.add(priority, delay, () => {
                if (!owns()) return false;
                try {
                    if (!current()) { release(); return false; }
                    const keep = callback(current) && current();
                    if (!keep) release();
                    return keep;
                } catch (why) {
                    release();
                    this.error(why);
                    return false;
                }
            });
            if (!current()) {
                const source = request.source;
                release();
                request.source = source;
                this.remove(request);
            }
        } catch (why) {
            const source = request.source;
            release();
            request.source = source;
            this.remove(request);
            this.error(why);
        }
    }
}
