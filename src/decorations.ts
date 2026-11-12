import Gio from 'gi://Gio';
import * as xprop from './xprop.js';

/** Kept by ShellWindow across suspend/resume, not by an individual request. */
export interface DecorationState {
    hidden: boolean;
}

/** A single per-window worker; latest desired state wins without parallel writes. */
export class DecorationController {
    private cancellable: any = new Gio.Cancellable();
    private disposed = false;
    private running = false;
    private desired: boolean | null = null;

    constructor(
        private xid: string,
        private state: DecorationState,
        private valid: () => boolean,
        private can_hide: () => boolean,
    ) {}

    update(show: boolean): void {
        if (!this.active()) return;
        this.desired = show;
        if (!this.running) void this.run();
    }

    dispose(): void {
        if (this.disposed) return;
        this.disposed = true;
        this.desired = null;
        this.cancellable.cancel();
    }

    private active(): boolean {
        return !this.disposed && this.valid();
    }

    private async run(): Promise<void> {
        this.running = true;
        try {
            while (this.desired !== null && this.active()) {
                let show = this.desired;
                this.desired = null;
                if (show && !this.state.hidden) continue;
                const info = await xprop.query_decoration(this.xid, this.cancellable);
                if (!this.active()) return;
                if (this.desired !== null) {
                    show = this.desired;
                    this.desired = null;
                }
                if (!info || !info.may_decorate || info.client_decorated) continue;
                if (show && !this.state.hidden) continue;
                if (!show && !this.can_hide()) continue;
                // A dispatched hide may reach X11 even if its completion is cancelled.
                // Remember ownership conservatively so a later show can restore it.
                if (!show) this.state.hidden = true;
                const ok = await xprop.set_hint(this.xid, xprop.MOTIF_HINTS,
                    show ? xprop.SHOW_FLAGS : xprop.HIDE_FLAGS, this.cancellable);
                if (!this.active()) return;
                if (ok && show) this.state.hidden = false;
            }
        } catch (why) {
            try { (globalThis as any).log(`pop-shell decoration update failed: ${why}`); } catch (_) { }
        } finally {
            this.running = false;
        }
    }
}
