export async function resolve(specifier, context, nextResolve) {
    const names = { 'gi://Gio': '__xpropGio', 'gi://GLib': '__xpropGLib' };
    if (names[specifier]) return { url: `data:text/javascript,export default globalThis.${names[specifier]}`, shortCircuit: true };
    return nextResolve(specifier, context);
}
