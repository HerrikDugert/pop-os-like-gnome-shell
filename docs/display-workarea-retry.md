# Display timer A: owned workarea retry

Base: 236d320 plus the locally verified first-frame-lifecycle.patch (403 cases).
This package intentionally covers the 500 ms readiness retry and its event-queue
continuation only. It does NOT migrate the 2 s display-settling timer or the
OnceExecutor used for fork migration. Those remain unsafe legacy work to review
separately, not implicitly covered by this patch's green tests.

The retry uses the existing ExtensionTimers owner under a dedicated key. An
independent workareas_request token remains valid after native source expiry only
until its queued continuation is consumed or superseded. This is necessary because
the manager's native-source request has already ended by that point; reusing its
current() predicate in the event queue would incorrectly reject legitimate work.

Both stages verify the activation generation, active extension, exact AutoTiler
and forest identity, unlocked session and monitor availability. Incoming valid
updates revoke older retries/continuations. Explicit calls while inactive, locked,
without a tiler or without monitors cannot leave their old retry active. The
existing ignore-once workspace path deliberately retains its pending retry.

Regular stop_window_io already cancels managed native sources, and now also clears
the logical queued-retry token. No new owner or fixture stubs are needed. Replacing
a retry never removes a numeric source ID that has already expired or been reused.

The synchronous readiness rules, existing displays_updating gate and ready-layout
paths are retained. The retry continues to forward workareas_only unchanged. A
fresh retry re-evaluates current geometry rather than executing a frozen migration.
This does not claim to solve lock recovery across an unobserved lock/unlock cycle.

28 new cases extract the production method and use the existing timer manager.
The manager source used for preparation matches Git blob
140390d57b24a509f897174875ac84f0bcc6226f. Type annotations were mechanically erased
for the preparation model. All 28 cases pass; with the previous controller, normal
retry/legacy scheduling controls pass but 23 ownership/contract cases fail.

Patch application and whitespace were checked against known contexts, including
line-offset variation. No full current checkout or real TypeScript build was run
in preparation. Local acceptance: both TypeScript projects and 431 total tests
(the previous 403 plus 28) pass; git diff --check is clean.

Next separate patch must handle display-settling, the entire migration executor
(including completion), obsolete geometry snapshots and reassignment cleanup.
Drag timers and native GNOME/GTK integration also remain pending. No installation
approval, commit or push is performed by this package.
