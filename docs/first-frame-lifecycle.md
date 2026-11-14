# First-frame/fallback ownership

Target: gnome-51-support at 236d320a990eb45c62218efe27fd4d8ed19102f6.
Prerequisite baseline: both TypeScript builds and 364 previously verified tests.

FirstFrames owns a request per Meta.Window. Its actor first-frame signal, actor
 destruction signal and 250 ms fallback form one logical operation. Completing one
path cleans the other resources before running the action. A dispatched old
signal or timeout cannot finish or erase a newer request, including after ID reuse.

The owner activation generation, current ShellWindow/component, actor identity,
AutoTiler identity, minimized state and tilability are checked before tiling.
Regular stop_window_io cancels the pending requests. Actor destruction cancels the
job via its own signal handler; the existing on_destroy cleanup order is unchanged.
A first-frame signal unsupported by the actor is reported, but the guarded fallback
remains available if the destruction handler could be installed. Failure to install
the destruction handler fails closed and cleans up.

Cleanup revokes callbacks before native disconnection/removal. Reentrant cleanup,
replacement and stop/restart cannot restore an old request's right to run. A
completed token stays visible through cleanup so even a replacement that completes
reentrantly prevents the older operation from subsequently acting.

The idle focus continuation also checks window and optional job validity before
raise, unminimize and activate. This prevents an already-tiled but subsequently
closed/replaced window, or a changed AutoTiler, from being refocused by old work.
Non-tilable creation retains the existing idle-focus path with window checks.

Three existing fixtures explicitly provide the new FirstFrames owner. The UI
cleanup-order assertion verifies config -> extension timers -> first frames -> UI
-> decoration cleanup. Existing destruction assertions remain unchanged.

39 new tests cover the helper and extracted production window_entity/stop_window_io
methods with mock native dependencies. They pass with mechanically erased helper
TypeScript in the preparation environment, plus a separate updated UI fixture smoke
case. The old controller retains its normal frame/fallback controls but fails 12
of the 39 tests. This is not a native GJS/Shell integration run.

No TypeScript compiler or complete current repository checkout was available in
the preparation environment. Patch application/whitespace were checked against
known source and fixture contexts, including line-offset changes. The full real
checkout must pass git apply --check and check-first-frame.sh locally.

Acceptance: both TypeScript builds, all previous 364 cases and 39 new cases pass
(403 total); git diff --check is clean. No automatic commit, push or installation.
Display retry/migration, drag timers, broader lock recovery and native integration
remain separate work. The initialized lock-screen early-return path is unchanged.
