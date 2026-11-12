# Async config I/O foundation (not adopted by Config yet)

This patch adds a standalone filesystem backend. It deliberately does NOT change
Config.reload(), mutation methods, extension startup, or the GTK dialog yet.
Those synchronous production paths stay active until a second migration package.
Do not describe this foundation alone as a runtime performance fix.

AsyncConfigStore.load() reads UTF-8 text and an ETag without creating anything.
AsyncConfigStore.update(transform) queues updates per instance. The transform is
synchronous and must be pure; it can be repeated after a conflict, up to three times.
JSON schema validation belongs in the Config adapter, before any replacement.

Concurrency:
- Cooperating writers use an exclusive private sibling .lock file around read/transform/write.
- A busy lock returns ConfigLockError immediately. It is not removed by a non-owner.
- Stale locks after crashes are reported, not automatically deleted. Recovery UX is still pending.
- ETags additionally detect common non-cooperating external edits; ETags are not a universal
  atomic transaction against arbitrary editors. All participating app writers must migrate together.
- Existing files use asynchronous ETag-checked replace; backends without usable ETags are refused.
- First creation writes and closes a private temporary file in the same directory, then uses a
  native async move without overwrite and without copy/delete fallback.
- If a concurrent creator wins, the transform is retried against their new contents.
- No synchronous filesystem fallback is used.

Compatibility limitation to resolve before production adoption:
Some older GIO language bindings do not expose move_async. First creation then fails with
ConfigCapabilityError, without writing a partial config or falling back to unprotected replace.
The repository's GNOME 45-51 range must be considered during the caller-migration package.
Existing-file operations do not require move_async. Native backend capability can also differ
by filesystem. The new backend is NOT active in production, so existing first-run behavior
is not changed by this foundation patch.

Cancellation is cooperative. It cannot undo a filesystem operation already committed.
An error during cleanup can occur AFTER data was written. Callers must report the failure
and reread rather than claiming that the file necessarily stayed unchanged.
Close and cleanup operations do not reuse a cancelled token. Cleanup failures are surfaced.

27 Node tests simulate GIO and filesystem state. Type-erased execution is not a tsc build
or real-GIO verification. A separate GJS smoke test operates on a newly allocated temporary
directory, not on the user's config. Run locally after compiling:

```sh
npx --no-install tsc --project tsconfig.json
node --experimental-loader ./tests/config-io-loader.mjs --test tests/config-io.test.mjs
gjs -m tests/config-io-gjs.mjs
```

The native smoke test uses a few synchronous operations only for test setup/cleanup;
the production backend uses async filesystem methods throughout.

Next migration: Config API and both callers; await initial validated load before tiling;
apply reload revision/generation checks; propagate save failures into dialog state; handle
busy/stale locks and older-binding first creation; wire cancellation into disable/re-enable;
update existing API tests without weakening their assertions.
