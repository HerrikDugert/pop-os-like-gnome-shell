const mock = 'data:text/javascript,export default globalThis.__executorGLib';

export async function resolve(specifier, context, nextResolve) {
    if (specifier === 'gi://GLib') return { url: mock, shortCircuit: true };
    return nextResolve(specifier, context);
}
