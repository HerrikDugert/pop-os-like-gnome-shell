#!/usr/bin/gjs --module

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk?version=3.0';
import Pango from 'gi://Pango';

/** The directory that this script is executed from. */
const SCRIPT_DIR = GLib.path_get_dirname(new Error().stack!.split(':')[0].slice(1));

/** Add our directory so we can import modules from it. */
imports.searchPath.push(SCRIPT_DIR);

import * as config from './config.js';

const WM_CLASS_ID = 'pop-shell-exceptions';

interface SelectWindow {
    tag: 0;
}

enum ViewNum {
    MainView = 0,
    Exceptions = 1,
}

interface SwitchTo {
    tag: 1;
    view: ViewNum;
}

interface ToggleException {
    tag: 2;
    wmclass: string | undefined;
    wmtitle: string | undefined;
    enable: boolean;
}

interface RemoveException {
    tag: 3;
    match: config.MatchMode;
    wmclass: string | undefined;
    wmtitle: string | undefined;
}

type Event = SelectWindow | SwitchTo | ToggleException | RemoveException;

interface View {
    widget: any;

    callback: (event: Event) => void;
}

function exceptions_button(): any {
    let title = Gtk.Label.new('System Exceptions');
    title.set_xalign(0);

    let description = Gtk.Label.new('Updated based on validated user reports.');
    description.set_xalign(0);
    description.get_style_context().add_class('dim-label');

    let icon = Gtk.Image.new_from_icon_name('go-next-symbolic', Gtk.IconSize.BUTTON);
    icon.set_hexpand(true);
    icon.set_halign(Gtk.Align.END);

    let layout = Gtk.Grid.new();
    layout.set_row_spacing(4);
    layout.set_border_width(12);
    layout.attach(title, 0, 0, 1, 1);
    layout.attach(description, 0, 1, 1, 1);
    layout.attach(icon, 1, 0, 1, 2);

    let button = Gtk.Button.new();
    button.relief = Gtk.ReliefStyle.NONE;
    button.add(layout);

    return button;
}

export class MainView implements View {
    widget: any;

    callback: (event: Event) => void = () => {};

    private list: any;

    constructor() {
        let select = Gtk.Button.new_with_label('Select');
        select.set_halign(Gtk.Align.CENTER);
        select.connect('clicked', () => this.callback({ tag: 0 }));
        select.set_margin_bottom(12);

        let exceptions = exceptions_button();
        exceptions.connect('clicked', () => this.callback({ tag: 1, view: ViewNum.Exceptions }));

        this.list = Gtk.ListBox.new();
        this.list.set_selection_mode(Gtk.SelectionMode.NONE);
        this.list.set_header_func(list_header_func);
        this.list.add(exceptions);

        let scroller = new Gtk.ScrolledWindow();
        scroller.hscrollbar_policy = Gtk.PolicyType.NEVER;
        scroller.set_propagate_natural_width(true);
        scroller.set_propagate_natural_height(true);
        scroller.add(this.list);

        let list_frame = Gtk.Frame.new(null);
        list_frame.add(scroller);

        let desc = new Gtk.Label({
            label: 'Select an application or window to add an exact, case-sensitive exception. Existing regex rules keep their original meaning.',
        });
        desc.set_line_wrap(true);
        desc.set_halign(Gtk.Align.CENTER);
        desc.set_justify(Gtk.Justification.CENTER);
        desc.set_max_width_chars(55);
        desc.set_margin_top(12);

        this.widget = Gtk.Box.new(Gtk.Orientation.VERTICAL, 24);
        this.widget.add(desc);
        this.widget.add(select);
        this.widget.add(list_frame);
    }

    clear_rules() {
        // The first row is the persistent system-exceptions navigation button.
        for (const row of this.list.get_children().slice(1)) row.destroy();
    }

    add_rule(wmclass: string | undefined, wmtitle: string | undefined, match: config.MatchMode) {
        const text = wmtitle === undefined ? wmclass : `${wmclass} / ${wmtitle}`;
        let label = Gtk.Label.new(`[${match === 'exact' ? 'Exact' : 'Regex'}] ${text}`);
        label.set_xalign(0);
        label.set_hexpand(true);
        label.set_ellipsize(Pango.EllipsizeMode.END);

        let button = Gtk.Button.new_from_icon_name('edit-delete', Gtk.IconSize.BUTTON);
        button.set_valign(Gtk.Align.CENTER);

        let widget = Gtk.Box.new(Gtk.Orientation.HORIZONTAL, 24);
        widget.add(label);
        widget.add(button);
        widget.set_border_width(12);
        widget.set_margin_start(12);
        widget.show_all();

        button.connect('clicked', () => {
            this.callback({ tag: 3, wmclass, wmtitle, match });
        });

        this.list.add(widget);
    }
}

export class ExceptionsView implements View {
    widget: any;
    callback: (event: Event) => void = () => {};

    exceptions: any = Gtk.ListBox.new();

    constructor() {
        let desc_title = Gtk.Label.new('<b>System Exceptions</b>');
        desc_title.set_use_markup(true);
        desc_title.set_xalign(0);

        let desc_desc = Gtk.Label.new('Updated based on validated user reports.');
        desc_desc.set_xalign(0);
        desc_desc.get_style_context().add_class('dim-label');
        desc_desc.set_margin_bottom(6);

        let scroller = new Gtk.ScrolledWindow();
        scroller.hscrollbar_policy = Gtk.PolicyType.NEVER;
        scroller.set_propagate_natural_width(true);
        scroller.set_propagate_natural_height(true);
        scroller.add(this.exceptions);

        let exceptions_frame = Gtk.Frame.new(null);
        exceptions_frame.add(scroller);

        this.exceptions.set_selection_mode(Gtk.SelectionMode.NONE);
        this.exceptions.set_header_func(list_header_func);

        this.widget = Gtk.Box.new(Gtk.Orientation.VERTICAL, 6);
        this.widget.add(desc_title);
        this.widget.add(desc_desc);
        this.widget.add(exceptions_frame);
    }

    clear_rules() {
        for (const row of this.exceptions.get_children()) row.destroy();
    }

    add_rule(wmclass: string | undefined, wmtitle: string | undefined, enabled: boolean) {
        let label = Gtk.Label.new(wmtitle === undefined ? wmclass : `${wmclass} / ${wmtitle}`);
        label.set_xalign(0);
        label.set_hexpand(true);
        label.set_ellipsize(Pango.EllipsizeMode.END);

        let button = Gtk.Switch.new();
        button.set_valign(Gtk.Align.CENTER);
        button.set_active(enabled);
        button.set_state(enabled);
        button.connect('state-set', (_button: any, requested: boolean) => {
            this.callback({ tag: 2, wmclass, wmtitle, enable: requested });
            return true;
        });

        let widget = Gtk.Box.new(Gtk.Orientation.HORIZONTAL, 24);
        widget.add(label);
        widget.add(button);
        widget.show_all();
        widget.set_border_width(12);

        this.exceptions.add(widget);
    }
}

class App {
    main_view: MainView = new MainView();
    exceptions_view: ExceptionsView = new ExceptionsView();
    stack: any = Gtk.Stack.new();
    window: any;
    config: config.Config = new config.Config();
    private back: any;
    private error_box: any;
    private error_label: any;
    private retry: any;
    private ready = false;
    private busy = false;
    private closing = false;
    private active: any = null;
    private pending: Promise<void> | null = null;

    constructor() {
        this.stack.set_border_width(16);
        this.stack.add(this.main_view.widget);
        this.stack.add(this.exceptions_view.widget);
        this.back = Gtk.Button.new_from_icon_name('go-previous-symbolic', Gtk.IconSize.BUTTON);
        const TITLE = 'Floating Window Exceptions';
        const win = new Gtk.Dialog({ use_header_bar: true });
        this.window = win;
        const headerbar = win.get_header_bar();
        headerbar.set_show_close_button(true);
        headerbar.set_title(TITLE);
        headerbar.pack_start(this.back);
        Gtk.Window.set_default_icon_name('application-default');
        win.set_wmclass(WM_CLASS_ID, TITLE);
        win.set_default_size(550, 700);
        win.get_content_area().add(this.stack);

        this.error_label = Gtk.Label.new('');
        this.error_label.set_line_wrap(true);
        this.error_label.set_max_width_chars(55);
        this.error_label.set_selectable(true);
        this.retry = Gtk.Button.new_with_label('Reload configuration');
        this.retry.connect('clicked', () => this.load_config());
        this.error_box = Gtk.Box.new(Gtk.Orientation.VERTICAL, 6);
        this.error_box.set_border_width(12);
        this.error_box.add(this.error_label);
        this.error_box.add(this.retry);
        win.get_content_area().add(this.error_box);
        win.connect('delete-event', () => { this.close(); return true; });
        win.connect('destroy', () => this.close());
        this.main_view.callback = event => this.handle_event(event);
        this.exceptions_view.callback = event => this.handle_event(event);
        this.back.connect('clicked', () => this.handle_event({ tag: 1, view: ViewNum.MainView }));
        win.show_all();
        this.back.hide();
        this.error_box.hide();
        this.load_config();
    }

    private update_controls(): void {
        const enabled = this.ready && !this.busy && !this.closing;
        this.stack.set_sensitive(enabled);
        this.back.set_sensitive(enabled);
        this.retry.set_sensitive(!this.busy && !this.closing);
    }

    private show_error(message: string): void {
        if (this.closing) return;
        this.error_label.set_text(message);
        this.error_box.show_all();
    }

    private render(): void {
        this.main_view.clear_rules();
        this.exceptions_view.clear_rules();
        for (const value of config.DEFAULT_FLOAT_RULES.values()) {
            const wmtitle = value.title ?? undefined;
            const wmclass = value.class ?? undefined;
            const disabled = this.config.rule_disabled({ class: wmclass, title: wmtitle });
            this.exceptions_view.add_rule(wmclass, wmtitle, !disabled);
        }
        for (const value of Array.from<any>(this.config.float)) {
            const wmtitle = value.title ?? undefined;
            const wmclass = value.class ?? undefined;
            if (!value.disabled) this.main_view.add_rule(wmclass, wmtitle, config.rule_mode(value));
        }
    }

    private run_job(action: (token: any) => Promise<void>): void {
        if (this.busy || this.closing) return;
        this.busy = true;
        this.error_box.hide();
        this.update_controls();
        const token = new Gio.Cancellable();
        this.active = token;
        this.pending = (async () => {
            try { await action(token); }
            catch (why) {
                try { println('RELOAD'); } catch (_) { }
                if (!this.closing) {
                    this.ready = false;
                    this.render();
                    this.show_error(`Could not complete the operation. The file may already have changed. ${why}`);
                }
            } finally {
                this.active = null;
                this.pending = null;
                this.busy = false;
                if (this.closing) Gtk.main_quit();
                else this.update_controls();
            }
        })();
        void this.pending.catch(why => {
            try { log(`Floating exceptions UI failure: ${why}`); } catch (_) { }
        });
    }

    private load_config(): void {
        if (this.busy || this.closing) return;
        this.ready = false;
        this.run_job(async token => {
            const result = await this.config.reload_async(token);
            if (this.closing) return;
            this.ready = result.tag === 0 && result.value;
            if (this.ready) this.render();
            else this.show_error(result.tag === 1 ? result.why : 'Configuration load was superseded. Reload to retry.');
        });
    }

    private mutate(event: ToggleException | RemoveException): void {
        this.run_job(async token => {
            const result = event.tag === 2
                ? await this.config.toggle_system_exception_async(event.wmclass, event.wmtitle, !event.enable, token)
                : await this.config.remove_user_exception_async(event.wmclass, event.wmtitle, event.match, token);
            // Protocol notifications are not UI success messages. RELOAD means persistence is uncertain.
            if (result.tag === 0) println('MODIFIED');
            else if (result.persistence === 'unknown') println('RELOAD');
            if (this.closing) return;
            if (result.tag === 1) {
                if (result.persistence === 'unknown') {
                    const recovered = await this.config.reload_async(token);
                    if (this.closing) return;
                    this.ready = recovered.tag === 0 && recovered.value;
                    this.render();
                    const detail = recovered.tag === 1 ? ` Reload failed: ${recovered.why}` : '';
                    this.show_error(`The change may already have been saved. ${result.why}${detail}`);
                } else {
                    this.render();
                    this.show_error(`The save did not start. ${result.why}`);
                }
                return;
            }
            if (!result.value.applied) {
                const recovered = await this.config.reload_async(token);
                if (this.closing) return;
                this.ready = recovered.tag === 0 && recovered.value;
                if (!this.ready) this.show_error(recovered.tag === 1
                    ? `Save completed, but reload failed: ${recovered.why}`
                    : 'Save completed, but reload was superseded. Reload to retry.');
            }
            this.render();
        });
    }

    private handle_event(event: Event): void {
        if (!this.ready || this.busy || this.closing) return;
        switch (event.tag) {
            case 0:
                println('SELECT');
                this.close();
                break;
            case 1:
                if (event.view === ViewNum.MainView) {
                    this.stack.set_visible_child(this.main_view.widget);
                    this.back.hide();
                } else {
                    this.stack.set_visible_child(this.exceptions_view.widget);
                    this.back.show();
                }
                break;
            case 2:
            case 3:
                this.mutate(event);
                break;
        }
    }

    private close(): void {
        if (this.closing) return;
        this.closing = true;
        this.config.invalidate_load();
        this.active?.cancel();
        try { this.window.hide(); } catch (_) { }
        // Keep GTK's loop alive until cancellation and owned lock/temp cleanup finish.
        if (!this.pending) Gtk.main_quit();
    }
}

function list_header_func(row: any, before: null | any) {
    if (before) {
        row.set_header(Gtk.Separator.new(Gtk.Orientation.HORIZONTAL));
    }
}

/** We'll use stdout for printing events for the shell to handle */
const STDOUT = new Gio.DataOutputStream({
    base_stream: new Gio.UnixOutputStream({ fd: 1 }),
});

/** Utility function for printing a message to stdout with an added newline */
function println(message: string) {
    STDOUT.put_string(message + '\n', null);
}

/** Initialize GTK and start the application */
function main() {
    GLib.set_prgname(WM_CLASS_ID);
    GLib.set_application_name('Pop Shell Floating Window Exceptions');

    Gtk.init(null);

    new App();

    Gtk.main();
}

main();
