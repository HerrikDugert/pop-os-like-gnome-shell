# Asynchronous X11 decoration I/O

Baseline: bbf1abeb6aa4ba9d0a907e1b3aeea94ecfa7efd5 from the supplied repo-review.txt.

Scope:
- Remove unused ShellWindow.size_hint()/wm_role() and their unused xprop helpers/SizeHint type.
- Existing Meta.Window.get_role() and get_min_size() tiling checks remain unchanged.
- Keep the previous Wayland guard: no X11 decoration I/O in a Wayland session.
- Preserve the historical motif-decoration policy and title blacklist.
- Query _MOTIF_WM_HINTS and _GTK_FRAME_EXTENTS in one subprocess.
- Parse cardinals numerically, not by prefixing hexadecimal strings or slicing quotes.
- Missing properties and malformed output are distinguished; failures cause no decoration write.
- All query and write communication uses communicate_utf8_async, with no synchronous wait.
- Each subprocess has a 1500 ms timeout. Cancellation kills that subprocess, not a process tree.
- Caller tokens are not cancelled by a command timeout; per-command internal tokens are used.
- Cancellation connections are removed after communication completes, not within cancel callbacks.
- One controller per window serializes writes and coalesces desired states during a query.
- There is deliberately no persistent property cache: each required decision rereads properties.
  This avoids a long-lived cache invalidation problem; it does not subscribe to arbitrary X11
  property changes. Properties changed independently are reconsidered on the next title update.
- Initialize after ECS storage insertion, never against a half-constructed ShellWindow.
- Check window identity, actor existence, controller disposal and extension activity after awaits.
- Cancel on window destruction and regular extension disable; refresh on regular reenable.
- Keep the existing lock/unlock early-return behavior.
- Preserve attempted hide ownership across controller disposal so a later show can restore it.
  Cancelling a process cannot undo an X11 request that has already reached the server.

Runtime failures resolve conservatively rather than changing decorations. No performance gain
is claimed for the already-guarded Wayland path, and no frame-time benchmark has been run.

Build both projects and run the new group separately:

```sh
npx --no-install tsc --project tsconfig.json
npx --no-install tsc --project src/floating_exceptions/tsconfig.json
node --experimental-loader ./tests/xprop-loader.mjs --test tests/xprop.test.mjs
```

The 27 new tests use mocked GIO/GLib, real decoration-controller logic after type erasure,
and extracted window methods/structural integration checks. They are not real X11 or GNOME
integration tests. The existing 83 tests also pass under type erasure in the review environment.
A regular tsc build and real GIO/X11/GTK/desktop checks must still be run locally.
