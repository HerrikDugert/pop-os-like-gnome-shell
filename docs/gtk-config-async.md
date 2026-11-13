# GTK floating exceptions: asynchronous I/O

Apply after all preceding Config and Shell caller packages. The existing dialog
config_io.ts symlink is required. Build and deploy Shell and GTK files together:
this package adds the RELOAD protocol message for uncertain persistence.

GTK loads with Config.reload_async(). Editing and selection are disabled until
valid data has arrived. Save operations use the asynchronous mutation APIs and
serialize user interaction by disabling controls during an operation. Deletion
rows are removed only on rerender after completion. System switches use state-set
and delayed backend-state acknowledgement. Dynamic errors use plain label text.

Failures are displayed inline with an explicit reload button. Unknown persistence
triggers reconciliation and is not described as an unchanged file. Unapplied but
completed saves also reconcile. Failure to reload leaves editing disabled.

Protocol:
- MODIFIED means a Config mutation completed (including a successful no-op).
- RELOAD asks the Shell to refresh after an uncertain result; it is not a claim
  of successful persistence.
- SELECT retains the existing selection behavior when no operation is pending.
Notifications are sent after the mutation result, even during graceful closing,
so a committed change is not hidden merely because the window was closed.

Closing cancels the owned Cancellable and invalidates Config loading. GTK's loop
stays alive until the operation's cancellation and backend cleanup have settled.
Late completion does not touch closed widgets. Abrupt process killing, including
forced IPC disposal, cannot guarantee cleanup and can still leave a crash-stale
lock. This package never deletes foreign locks; recovery policy remains open.

Shell handles MODIFIED and RELOAD with its async reload helper. Reload tokens are
owned by the specific IPC dialog generation. Replacing/closing that owner cancels
its tokens before Config can apply a stale response. Normal EOF retains the final
notification's generation until a later dialog or regular extension teardown.

The subsequent config-sync-cleanup.patch removes the legacy synchronous Config
methods and ports their regression tests to async I/O. This package migrates the
GTK reader/writers and remaining active Shell IPC reader. Lock recovery policy,
final review and native GNOME/GTK integration testing remain separate work.

Local Node tests model GTK, Config and GIO using actual application method source.
They do not constitute a native GTK/GNOME integration test. Run both TypeScript
projects and all listed regressions locally. Do not install before the agreed
integration-testing stage.
