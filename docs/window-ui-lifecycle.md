# Window UI timer ownership

Base: gnome-51-support at c81c9b65f0cd44fe3ca52d2c05ff11e51b2d3037.
The window.ts baseline has Git blob ef394d83a9677432c1f81f8ee4b2ee13ffc2a3d7.

Restack and active-hint operations keep module-wide coalescing, but each operation
owns a distinct request object. A cancelled/dispatched old callback cannot clear
or remove a replacement request, even when a numeric GLib ID is reused.

Every delayed UI mutation checks the activation generation, active extension,
actor lifetime, current ShellWindow identity and captured border identity.
Restack finishes after four live ticks with SOURCE_REMOVE instead of removing a
shared numeric source during dispatch. Its existing placement rules are retained.
The hint's existing focused-window repetition policy is retained; this patch does
not introduce an arbitrary retry cap.

stop_ui_work() revokes owned requests before removing their GLib sources. Regular
stop_window_io() and on_destroy() call it before decoration cleanup. hide_border()
cancels only that window's hint, not other windows' requests or its own restack.
The initialized lock-screen early-return path is unchanged. The public activation
generation accessor also protects constructor work not yet in windows storage.

The new tests extract the relevant production methods and provide GLib/Shell
mocks. They retain the four desired guarantees from the original reproduction and
cover live behavior, expiry, repeated cleanup, constructor insertion, fast restart,
source ID reuse, window/border replacement, reentrant replacement and error paths.
The Xprop structural test is updated to assert the stronger destruction order.

29 new model tests pass in the preparation environment. The unmodified window.ts
fails 23 of these tests, including all four original failure scenarios. No real
TypeScript compiler or native GJS/Shell integration run was available here.

Local acceptance: both TypeScript projects, the 29 new tests and all 298 previous
cases must pass (327 total), and git diff --check must remain clean. Run tests/
window-ui-lifecycle.test.mjs, not the old root-level reproduction helper: that
helper does not provide the added methods and activation-generation API.

Other extension timers, first-frame/fallback work, display migration, lock
recovery, regex limits and native integration remain separate review work.
