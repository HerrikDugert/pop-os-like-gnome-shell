# Extension timers A: size debounce and stack-restack

Prerequisite: c81c9b6 plus the locally verified window-ui-lifecycle.patch (327 cases).
This is a separate incremental package, not a claim that all Extension timers
have been migrated.

Changes:
- Replace size_requests numeric-ID bookkeeping with a managed request per Meta.Window.
- Keep the 500 ms size/position debounce and validate current window identity and
  actor lifetime before enqueueing a Size event.
- Mark a destroyed window before canceling its debounce, then stop its UI work
  and decoration controller in the existing order.
- Manage Ext.restack through one coalesced request for the current AutoTiler.
  Keep the 50 ms interval and eleven iterations for a valid tiler. Skip allocating
  a timer without a tiler. A new request resets the bounded retry sequence.
- Validate request identity before each container operation, so reentrant stop,
  request replacement or AutoTiler replacement cannot continue the old loop.
- Regular stop_window_io cancels the new managed timers. The event-owner generation
  already changes in stop_events, so stale callbacks are also rejected before that
  explicit cleanup and after rapid reenable. Initialized lock early return remains
  unchanged. The existing idle/UI timer systems are not replaced in this package.

ExtensionTimers has an injected backend and no GI imports. TypeScript emits it to
 target/extension_timers.js; Node tests import that emitted module in a real local
build. Requests are revocable objects, never just numeric source IDs. Cleanup
revokes ownership before source removal, errors are contained, and callbacks cannot
remove a replacement even when GLib reuses an ID. A task can query its currentness
between multiple native operations.

Tests:
37 new cases cover ownership, cancellation, exceptions, reentrancy, ID reuse and
production connect_window/restack/stop_window_io integration. The previous UI and
Xprop destruction assertions are strengthened for debounce cancellation ordering;
the Shell configuration fixture supplies the new timer owner explicitly.

Preparation validation: 37 new tests pass with mechanically erased TypeScript;
the two modified UI fixture cases pass separately. With the same new manager but
the unmodified Extension controller, 14 integration/contract cases fail, including
stale size callback, destroying/replaced window and regular stop scenarios. No real
TypeScript compiler or native GJS/Shell was available in the preparation environment.
Patch whitespace/application checked against the known source contexts; complete
current Extension checkout validation is still required locally.

Acceptance: run check-extension-timers.sh after applying. Both TypeScript projects,
all previous 327 cases and 37 new cases must pass (364 total), plus git diff --check.

Still pending: first-frame plus fallback signal/timeout ownership; display retry
and migration timers; drag timer; broader lock recovery; native GTK/GNOME testing;
regex limits and performance measurements. Do not install based on model tests alone.
