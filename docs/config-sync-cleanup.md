# Removal of legacy synchronous Config I/O

Apply after gtk-config-async.patch and all preceding Config migration packages.
The user-facing behavior and the asynchronous persistence contract are unchanged.

Removed: reload, sync_to_disk, add_app_exception, add_window_exception,
toggle_system_exception, remove_user_exception and the private from_config,
gio_file, read and write helpers. Config no longer imports Gio. CONF_FILE is
constructed directly, without the now-unused CONF_DIR intermediate.

Retained: pure rule helpers, validation, from_json fallback parsing,
load_from_json, serialization and all asynchronous read/mutation methods.

Tests are migrated rather than disabled:
- Config read failures, malformed/schema-invalid input, valid defaults and full
  field copying now exercise reload_async and explicitly inspect its result.
- Default-rule immutability, idempotence, duplicate removal, exact/regex behavior,
  persistence and failed-write results exercise asynchronous mutation methods.
- Fresh disk state is seeded explicitly before a mutation instead of treating a
  stale in-memory snapshot as authoritative.
- The two async-load cases tied to removed APIs are replaced with invalid direct
  JSON invalidation and pre-cancelled async mutation invalidation. Successful async
  mutation vs in-flight read remains covered by config-save.test.mjs.
- A new regression asserts that the removed instance/static APIs are absent.

A reusable Node-only in-memory GIO fixture supplies asynchronous operations, ETags,
locks, owned bytes, move semantics and injected failed read/write results. Any
synchronous filesystem method on that mock throws. The four previously added pure
JSON apply tests are left unchanged, as are the other thirteen async-load cases.

Expected local groups after cleanup: 79 Config/read/save/rule tests; 66 GTK and
Shell/startup/lifecycle tests; 31 backend tests; 29 IPC tests; 27 Xprop tests.
Total for those groups: 232. ECS/executor suites are outside that count.

No native GTK/GNOME integration or TypeScript build was available in the assistant
environment. Do not infer native lifecycle correctness from the model tests. Lock
recovery and the planned native integration checks are still open.
