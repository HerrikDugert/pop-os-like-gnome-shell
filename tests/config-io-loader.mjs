export async function resolve(specifier, context, nextResolve) {
    const mock = { 'gi://Gio': '__configStoreGio', 'gi://GLib': '__configStoreGLib' }[specifier];
    if (mock) return { url: `data:text/javascript,export default globalThis.${mock}`, shortCircuit: true };
    return nextResolve(specifier, context);
}
