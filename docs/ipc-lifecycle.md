# Exceptions dialog IPC lifecycle

This package changes utils.ts and the exceptions-dialog paths in extension.ts together.

- The IPC handle owns one read loop, two streams, and one subprocess.
- Normal process exit does not cancel the reader; it drains messages until EOF.
- EOF closes streams. The handle remains owned until the process exits.
- Explicit dispose cancels reading and force-terminates the owned helper if necessary.
- A pending read always calls its finish method before the streams are closed asynchronously.
- Cancellation caused by dispose is not reported as an unexpected read failure.
- Close operations use no cancelled Cancellable and are requested once per stream.
- Start, read, consumer, wait, close and notification errors are contained and reported where possible.
- Repeated opening while the dialog is active is ignored (no duplicate dialog).
- A generation token guards received and already queued MODIFIED/SELECT actions.
- Regular disable stops events, invalidates the dialog generation, disposes its handle,
  and removes the selection timer. The existing lock-screen early-return path is unchanged.
- The selection timer also checks source identity so an obsolete callback cannot erase a newer timer.
- No global timeout is imposed on a user-facing dialog. force_exit targets the helper process,
  not an entire process tree.

Tests use simulated GIO/GLib and extracted dialog methods with fake UI dependencies.
They do not constitute a real GIO, GTK or GNOME Shell integration test.

Build both projects, then run the IPC tests separately with their own loader:

```sh
npx --no-install tsc --project tsconfig.json
npx --no-install tsc --project src/floating_exceptions/tsconfig.json
node --experimental-loader ./tests/ipc-loader.mjs --test tests/ipc.test.mjs
```

The other test groups keep using their existing loaders.
