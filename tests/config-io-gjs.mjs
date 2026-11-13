#!/usr/bin/gjs -m
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import { AsyncConfigStore, ConfigLockError } from '../target/config_io.js';

// This native-GIO smoke test touches only a newly allocated temporary directory.
const directory = GLib.dir_make_tmp('pop-shell-config-io-XXXXXX');
const root = Gio.File.new_for_path(directory);
const loop = new GLib.MainLoop(null, false);
let failure = null;
function check(value, message) { if (!value) throw new Error(message); }

async function run() {
    try {
        const file = root.get_child('config.json');
        const store = new AsyncConfigStore(file.get_path());
        check((await store.load()).text === null, 'new config should be absent');
        const absent = await store.update(text => text);
        check(absent.text === null && !file.query_exists(null), 'no-op created a configuration file');
        const title = 'Grüße — 日本語';
        const first = await store.update(() => JSON.stringify({ count: 1, title }));
        check(JSON.parse(first.text).count === 1, 'first creation failed');
        check(JSON.parse(first.text).title === title, 'first creation corrupted UTF-8');
        const increment = text => JSON.stringify({ ...JSON.parse(text), count: JSON.parse(text).count + 1 });
        await Promise.all([store.update(increment), store.update(increment)]);
        const after = JSON.parse((await store.load()).text);
        check(after.count === 3, 'ordered updates failed');
        check(after.title === title, 'replacement corrupted UTF-8');
        const lock = root.get_child('config.json.lock');
        const stream = lock.create(Gio.FileCreateFlags.PRIVATE, null);
        stream.close(null);
        let rejected = false;
        try { await store.update(increment); }
        catch (error) { rejected = error instanceof ConfigLockError; }
        check(rejected, 'a foreign lock must prevent updating');
        lock.delete(null);
        check(JSON.parse((await store.load()).text).count === 3, 'lock test changed config');
        print('Native GIO smoke test passed (temporary files only).');
    } finally {
        const entries = root.enumerate_children('standard::name', Gio.FileQueryInfoFlags.NONE, null);
        try {
            let info;
            while ((info = entries.next_file(null)) !== null) root.get_child(info.get_name()).delete(null);
        } finally { entries.close(null); }
        root.delete(null);
    }
}
run().then(() => loop.quit(), error => { failure = error; loop.quit(); });
loop.run();
if (failure) throw failure;
