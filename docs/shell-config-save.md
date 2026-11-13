# Shell exception saving: caller migration

Prerequisites: JSON-apply, async-load, extension-start (including window discovery),
async-save patches, and the dialog config_io.ts symlink already applied.

This package migrates the Shell selection modal's app/window exception actions.
They await Config's async mutation result before tiling reapplication or reopening
the exceptions application. The close callback no longer starts a synchronous
reload while a selected save is still running. Duplicate modal callbacks are ignored.

Each operation owns a Gio.Cancellable in Ext.config_requests. Regular I/O teardown
invalidates the owner generation and Config state application, cancels all pending
requests, and clears ownership. A late save or reload cannot affect a later activation.
Already-persisted changes cannot be rolled back by cancellation.

Save failures are shown using Main.notifyError. Unknown persistence explicitly
states that the file may already have changed and attempts an async reconciliation.
A successful but unapplied save also reconciles before reopening the exception UI.
Failed reconciliation never claims the original operation was not saved.

Scope: the separate GTK application still uses its previous synchronous mutations.
The IPC MODIFIED reader also remains unchanged and is the next migration target.
Do not treat cooperating-writer locking as complete until those writers are migrated.
Do not install or perform native Shell integration testing before the agreed end stage.

Tests evaluate the actual modified methods with mocked Config, Shell, modal and GIO
objects. They are not a native GNOME Shell or TypeScript compilation test.
