# Idle scheduling and AutoTiler ownership (review fixes, part 1)

Base: gnome-51-support at e994fc0. This package changes only the idle scheduling
path and AutoTiler ownership, not Config persistence, IPC or ECS insertion.

schedule_idle() rejects inactive owners, tracks each delayed GLib source using a
unique request object and an activation generation, and removes owned sources in
stop_events(). Dispatched obsolete callbacks cannot act after reenable or erase a
new request if GLib reuses a numeric source ID. Immediate execution and delayed
boolean-controlled repetition remain supported. Callback/logging errors cannot
leave a live tracked repeating source behind.

Creation during signals_attach() is retained because initial window discovery
already needs the Tiler. auto_tile_on() reuses that instance instead of replacing
it and registering a second attached Storage. Regular extension teardown now
unregisters the attached Storage before destroy, just like manual auto_tile_off.
The existing initialized lock-screen early return remains unchanged.

Tests extract the actual relevant methods and startup/disable code. They cover
stop/start, dispatched stale callbacks, ID reuse, reentrant replacement, exceptions,
source ownership, paired startup paths and repeated creation/cleanup cycles.
They model GLib/Shell dependencies; they are not native integration tests.
Existing lifecycle/startup fixtures gain the corresponding state and storage check.

Scope boundaries: other direct GLib timers, first-frame handlers, display-update
callbacks and size request timers have not been migrated by this package. Stale
Storage.insert/get_or protection is the separate second part of review priority 1.
Lock recovery, regex limits and native GNOME/GTK integration remain pending.

Expected groups when added to the existing local regression command:
87 GTK/Shell/startup/lifecycle/idle tests; 79 Config/rule/save tests; 31 backend;
29 IPC; 27 Xprop. Total 253 in these groups, excluding separate ECS/executor suites.
