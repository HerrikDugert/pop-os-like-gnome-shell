# Asynchronous Config mutations

Prerequisites: config-json-apply.patch, config-async-load.patch and the dialog's
config_io.ts symlink. This package does not switch existing mutation callers.

Config exposes add_app_exception_async, add_window_exception_async,
toggle_system_exception_async, and remove_user_exception_async. They accept an
optional Gio.Cancellable (after the match mode for removal).

Each operation rebases its intent on the current JSON under AsyncConfigStore's
cooperating-writer lock and ETag checks. The transform is pure and can be retried.
An absent-file no-op returns unchanged null and never creates config.json. Null
cannot erase an existing file. Unknown root fields survive changed writes, and
unchanged files retain their original bytes. Writers reject invalid rules instead
of silently filtering them out of the persisted document; legacy read filtering
is unchanged.

A per-Config backend serializes updates. A reload requested after a save waits
for queued saves before reading. Intent generations prevent obsolete completion
from overwriting newer local state. Bookkeeping remains in WeakMaps, outside
JSON.stringify(this).

Result contract:
- tag 0: the backend operation completed, including no-op updates. value.applied
  says whether its resulting state was adopted in memory. applied=false is NOT
  evidence that no disk change occurred.
- tag 1, persistence='not-started': backend update was not submitted.
- tag 1, persistence='unknown': it may have persisted before failure. Do not claim
  that the file is unchanged; reconcile with reload_async() when lifecycle allows.
  For example cleanup failure can occur after persistence and leave a lock behind.

A supplied Cancellable prevents queued operations from running when cancelled,
subject to backend completion races. invalidate_load() only invalidates reads and
late state application; it neither cancels writes nor rolls back persisted data.
Callers must own and cancel their write tokens and suppress callbacks after closing.
After concurrent intents, an earlier successful save can be unapplied if a newer
intent fails. Reload can reconcile this case; no speculative memory rollback runs.

Lock contention is returned to the caller, without automatic deletion of foreign
or crash-stale locks. Retrying reapplies the intent to the latest file. Arbitrary
editors and legacy synchronous writers do not participate in this locking protocol.

The existing synchronous methods retain their behavior and share pure rule helpers
with the async methods. Shell/dialog mutation callers still require migration,
including awaited success reporting, recovery, and cancellable ownership.

Node tests use GI mocks and mechanically stripped TS in the assistant environment;
TypeScript builds and native GIO must be tested locally. The updated native smoke
test uses a fresh temporary directory, not the user's configuration. It tests the
backend's null no-op as well as creation, replacement, Unicode and locking, not
the Config wrapper's native GNOME integration.
