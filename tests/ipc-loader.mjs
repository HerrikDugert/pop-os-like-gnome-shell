export async function resolve(specifier, context, nextResolve) {
    const gi = { 'gi://Gio': '__ipcGio', 'gi://GLib': '__ipcGLib', 'gi://GObject': '__ipcGObject', 'gi://Meta': '__ipcMeta' };
    if (gi[specifier]) return { url: `data:text/javascript,export default globalThis.${gi[specifier]}`, shortCircuit: true };
    if (context.parentURL?.endsWith('/target/utils.js')) {
        if (specifier === './result.js') return { url: 'data:text/javascript,export const Ok=x=>x; export const Err=x=>x;', shortCircuit: true };
        if (specifier === './error.js') return { url: 'data:text/javascript,export const Error=globalThis.Error;', shortCircuit: true };
        if (specifier === './log.js') return { url: 'data:text/javascript,export const error=x=>globalThis.log(x);', shortCircuit: true };
    }
    return nextResolve(specifier, context);
}
