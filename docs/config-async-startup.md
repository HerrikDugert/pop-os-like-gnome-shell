# Asynchronous extension startup

The synchronous GNOME enable hook starts Config.reload_async() and returns. Runtime
activation is deferred until that request reports an applied configuration.

Before that point there are no extension event processing, DBus ownership, signal
attachments, panel indicator, keybindings, or automatic tiling. Constructor-time
configuration reading has been removed. Theme and snap callbacks are registered
after the load gate opens.

A failed load or a superseded result leaves startup paused. Fix the file and disable
then enable the extension to retry; this package does not introduce a file watcher
or automatic retries. Missing configuration uses in-memory defaults without creating
a file, according to the already-tested reload_async contract.

Regular disable invalidates the configuration read and cancels its Gio.Cancellable
before teardown. A late response cannot activate a previous startup. Pending loads
are also cancelled on lock. An already fully initialized extension retains the
existing lock-screen special path and resumes without duplicate initialization.

Signal attachment on reenable now discovers previously untracked windows, including
windows opened during the loading interval. Already tracked windows are not queued
again by this discovery step.

The JSON, async-load, and backend changes from the preceding packages, including the
dialog's config_io.ts symlink, must already be applied. This package changes only the
Shell startup reader. Dialog reading, dialog writes, and in-session config reloads
remain synchronous and require subsequent migration.

Tests evaluate actual startup-hook source with simulated Shell/GI dependencies.
They are not a native GNOME Shell integration test. Native startup, panel, actor,
and lock-screen behavior still require the planned integration test.
