export async function resolve(specifier, context, nextResolve) {
    if (specifier === 'gi://GLib' || specifier === 'gi://Gio') {
        const key = specifier === 'gi://GLib' ? '__configGLib' : '__configGio';
        return { url: `data:text/javascript,export default globalThis.${key}`, shortCircuit: true };
    }
    return nextResolve(specifier, context);
}
