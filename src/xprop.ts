import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

export const MOTIF_HINTS = '_MOTIF_WM_HINTS';
export const HIDE_FLAGS = ['0x2', '0x0', '0x0', '0x0', '0x0'];
export const SHOW_FLAGS = ['0x2', '0x0', '0x1', '0x0', '0x0'];
const TIMEOUT_MS = 1500;

export interface DecorationInfo {
    may_decorate: boolean;
    client_decorated: boolean;
}

function valid_xid(xid: string): boolean {
    return /^0x[0-9a-f]+$/i.test(xid);
}

/** One bounded subprocess; cancellation never cancels the caller's token. */
function command(argv: string[], cancellable: any): Promise<string | null> {
    return new Promise((resolve) => {
        if (cancellable?.is_cancelled()) { resolve(null); return; }
        const io = new Gio.Cancellable();
        let process: any = null;
        let timer: SignalID | null = null;
        let connection = 0;
        let stopped = false;
        let finished = false;
        const stop = () => {
            if (stopped || finished) return;
            stopped = true;
            try { process?.force_exit(); } catch (_) { }
            io.cancel();
        };
        const finish = (value: string | null) => {
            if (finished) return;
            finished = true;
            if (timer !== null) {
                const id = timer; timer = null;
                try { GLib.source_remove(id); } catch (_) { }
            }
            // Called from the communication callback, not from inside cancel().
            if (connection !== 0) {
                const id = connection; connection = 0;
                try { cancellable.disconnect(id); } catch (_) { }
            }
            resolve(value);
        };
        try {
            process = Gio.Subprocess.new(argv,
                Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_SILENCE);
            if (cancellable) connection = cancellable.connect(stop);
            timer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, TIMEOUT_MS, () => {
                timer = null;
                stop();
                return false;
            });
            process.communicate_utf8_async(null, io, (source: any, res: any) => {
                try {
                    const [, output] = source.communicate_utf8_finish(res);
                    finish(!stopped && !io.is_cancelled() && source.get_successful() ? output ?? '' : null);
                } catch (_) {
                    stop();
                    finish(null);
                }
            });
        } catch (_) {
            stop();
            finish(null);
        }
    });
}

function cardinals(line: string): number[] | null {
    const equals = line.indexOf('=');
    if (equals < 0) return null;
    const fields = line.slice(equals + 1).trim().split(/\s*,\s*/);
    if (!fields.length || fields.some(value => !/^(?:0x[0-9a-f]+|[0-9]+)$/i.test(value))) return null;
    const numbers = fields.map(value => Number(value));
    return numbers.every(value => Number.isSafeInteger(value) && value >= 0 && value <= 0xffffffff) ? numbers : null;
}

export async function query_decoration(xid: string, cancellable: any): Promise<DecorationInfo | null> {
    if (!valid_xid(xid)) return null;
    const output = await command(['xprop', '-id', xid, MOTIF_HINTS, '_GTK_FRAME_EXTENTS'], cancellable);
    if (output === null) return null;
    let motif: number[] | null = null;
    let extents: number[] | null = null;
    let seen_motif = false;
    let seen_extents = false;
    for (const line of output.split('\n')) {
        if (line.startsWith(MOTIF_HINTS)) {
            seen_motif = true;
            motif = cardinals(line);
            if (line.includes('=') && (!motif || motif.length !== 5)) return null;
            if (!line.includes('=') && !/not found|no such atom/i.test(line)) return null;
        } else if (line.startsWith('_GTK_FRAME_EXTENTS')) {
            seen_extents = true;
            extents = cardinals(line);
            if (line.includes('=') && (!extents || extents.length !== 4)) return null;
            if (!line.includes('=') && !/not found|no such atom/i.test(line)) return null;
        }
    }
    if (!seen_motif || !seen_extents) return null;
    return {
        // Preserve the previous decoration policy; only transport/parsing changes.
        may_decorate: motif === null || motif[2] === 0 || motif[2] === 1,
        client_decorated: extents !== null,
    };
}

export async function set_hint(xid: string, hint: string, value: string[], cancellable: any): Promise<boolean> {
    if (!valid_xid(xid) || hint !== MOTIF_HINTS ||
        (value.join(',') !== HIDE_FLAGS.join(',') && value.join(',') !== SHOW_FLAGS.join(','))) return false;
    return (await command(['xprop', '-id', xid, '-f', hint, '32c', '-set', hint, value.join(', ')], cancellable)) !== null;
}

export function get_xid(meta: Meta.Window): string | null {
    const description = meta.get_description();
    const match = description && description.match(/0x[0-9a-f]+/i);
    return match ? match[0] : null;
}
