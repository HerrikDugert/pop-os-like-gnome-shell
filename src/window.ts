import * as lib from './lib.js';
import * as log from './log.js';
import * as once_cell from './once_cell.js';
import * as Rect from './rectangle.js';
import * as Tags from './tags.js';
import * as utils from './utils.js';
import * as xprop from './xprop.js';
import { DecorationController } from './decorations.js';
import type { Entity } from './ecs.js';
import type { Ext } from './extension.js';
import type { Rectangle } from './rectangle.js';
import * as scheduler from './scheduler.js';
import * as focus from './focus.js';

import Gdk from 'gi://Gdk';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import St from 'gi://St';
import GLib from 'gi://GLib';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

const { OnceCell } = once_cell;

export var window_tracker = Shell.WindowTracker.get_default();

interface WindowUIRequest {
    owner: ShellWindow;
    source: SignalID | null;
}

// Keep cross-window coalescing, but give every request its own identity.
let SCHEDULED_RESTACK: WindowUIRequest | null = null;
let ACTIVE_HINT_SHOW_ID: WindowUIRequest | null = null;

function report_ui_error(why: unknown): void {
    try { log.log(`Window UI callback failed: ${why}`); } catch (_) { }
}

function cancel_ui_source(request: WindowUIRequest): void {
    const source = request.source;
    request.source = null;
    if (source !== null) {
        try { GLib.source_remove(source); }
        catch (why) { report_ui_error(why); }
    }
}

const WM_TITLE_BLACKLIST: Array<string> = [
    'Firefox',
    'Nightly', // Firefox Nightly
    'Tor Browser',
];

enum RESTACK_STATE {
    RAISED,
    WORKSPACE_CHANGED,
    NORMAL,
}

enum RESTACK_SPEED {
    RAISED = 430,
    WORKSPACE_CHANGED = 300,
    NORMAL = 200,
}

interface X11Info {
    xid_: once_cell.OnceCell<string | null>;
}

export class ShellWindow {
    entity: Entity;
    meta: Meta.Window;
    ext: Ext;
    stack: number | null = null;
    known_workspace: number;
    grab: boolean = false;
    activate_after_move: boolean = false;
    ignore_detach: boolean = false;
    was_attached_to?: [Entity, boolean | number];
    destroying: boolean = false;

    // Awaiting reassignment after a display update
    reassignment: boolean = false;

    // True if this window is currently smart-gapped
    smart_gapped: boolean = false;

    border: null | St.Bin = new St.Bin({
        style_class: 'pop-shell-active-hint pop-shell-border-normal',
    });

    prev_rect: null | Rectangular = null;

    window_app: any;

    private decoration_state = { hidden: false };
    private decoration_controller: DecorationController | null = null;

    private extra: X11Info = {
        xid_: new OnceCell(),
    };

    private border_size = 0;

    constructor(entity: Entity, window: Meta.Window, window_app: any, ext: Ext) {
        this.window_app = window_app;

        this.entity = entity;
        this.meta = window;
        this.ext = ext;

        this.known_workspace = this.workspace_id();

        // Float fullscreen windows by default, such as Kodi.
        if (this.meta.is_fullscreen()) {
            ext.add_tag(entity, Tags.Floating);
        }

        this.bind_window_events();
        this.bind_hint_events();

        if (this.border) global.window_group.add_child(this.border);

        this.hide_border();
        this.restack();
        this.update_border_layout();

        if (this.meta.get_compositor_private()?.get_stage()) this.on_style_changed();
    }

    activate(move_mouse: boolean = true): void {
        activate(this.ext, move_mouse, this.meta);
    }

    actor_exists(): boolean {
        return !this.destroying && this.meta.get_compositor_private() !== null;
    }

    private bind_window_events() {
        this.ext.window_signals
            .get_or(this.entity, () => new Array())
            .push(
                this.meta.connect('size-changed', () => {
                    this.window_changed();
                }),
                this.meta.connect('position-changed', () => {
                    this.window_changed();
                }),
                this.meta.connect('workspace-changed', () => {
                    this.workspace_changed();
                }),
                this.meta.connect('notify::wm-class', () => {
                    this.wm_class_changed();
                }),
                this.meta.connect('raised', () => {
                    this.window_raised();
                }),
            );
    }

    private bind_hint_events() {
        if (!this.border) return;

        let settings = this.ext.settings;
        let change_id = settings.ext.connect('changed', (_, key) => {
            if (this.border) {
                if (key === 'hint-color-rgba') {
                    this.update_hint_colors();
                }
            }
            return false;
        });

        this.border.connect('destroy', () => {
            settings.ext.disconnect(change_id);
        });
        this.border.connect('style-changed', () => {
            this.on_style_changed();
        });

        this.update_hint_colors();
    }

    /**
     * Adjust the colors for:
     * - border hint
     * - overlay
     */
    private update_hint_colors() {
        let settings = this.ext.settings;
        const color_value = settings.hint_color_rgba();

        if (this.ext.overlay) {
            const gdk = new Gdk.RGBA();
            // TODO Probably move overlay color/opacity to prefs.js in future,
            // For now mimic the hint color with lower opacity
            const overlay_alpha = 0.3;
            const orig_overlay = 'rgba(53, 132, 228, 0.3)';
            gdk.parse(color_value);

            if (utils.is_dark(gdk.to_string())) {
                // too dark, use the blue overlay
                gdk.parse(orig_overlay);
            }

            gdk.alpha = overlay_alpha;
            this.ext.overlay.set_style(`background: ${gdk.to_string()}`);
        }

        this.update_border_style();
    }

    cmdline(): string | null {
        let pid = this.meta.get_pid(),
            out = null;
        if (-1 === pid) return out;

        const path = '/proc/' + pid + '/cmdline';
        if (!utils.exists(path)) return out;

        const result = utils.read_to_string(path);
        if (result.kind == 1) {
            out = result.value.trim();
        } else {
            log.error(`failed to fetch cmdline: ${result.value.format()}`);
        }

        return out;
    }

    /** Called for initialization, title settings changes and regular reenable. */
    update_decoration(ext: Ext): void {
        if (utils.is_wayland() || !ext.allows_window_io()) return;
        const xid = this.xid();
        if (!xid) return;
        if (!this.decoration_controller) {
            this.decoration_controller = new DecorationController(xid, this.decoration_state,
                () => ext.allows_window_io() && this.actor_exists() && ext.windows.get(this.entity) === this,
                () => !this.ignore_decoration());
        }
        this.decoration_controller.update(ext.settings.show_title());
    }

    cancel_decoration(): void {
        this.decoration_controller?.dispose();
        this.decoration_controller = null;
    }

    icon(_ext: Ext, size: number): any {
        let icon = this.window_app.create_icon_texture(size);

        if (!icon) {
            icon = new St.Icon({
                icon_name: 'applications-other',
                icon_size: size,
            });
        }

        return icon;
    }

    ignore_decoration(): boolean {
        const name = this.meta.get_wm_class();
        if (name === null) return true;
        return WM_TITLE_BLACKLIST.findIndex((n) => name.startsWith(n)) !== -1;
    }

    is_maximized(): boolean {
        return this.meta.maximized_horizontally || this.meta.maximized_vertically;
    }

    /**
     * Window is maximized, 0 gapped or smart gapped
     */
    is_max_screen(): boolean {
        // log.debug(`title: ${this.meta.get_title()}`);
        // log.debug(`max: ${this.is_maximized()}, 0-gap: ${this.ext.settings.gap_inner() === 0}, smart: ${this.smart_gapped}`);
        return this.is_maximized() || this.ext.settings.gap_inner() === 0 || this.smart_gapped;
    }

    is_single_max_screen(): boolean {
        const display = this.meta.get_display();

        if (display) {
            let monitor_count = display.get_n_monitors();
            return (this.is_maximized() || this.smart_gapped) && monitor_count == 1;
        }

        return false;
    }

    is_snap_edge(): boolean {
        return this.meta.maximized_vertically && !this.meta.maximized_horizontally;
    }

    is_tilable(ext: Ext): boolean {
        let tile_checks = () => {
            let wm_class = this.meta.get_wm_class();

            if (wm_class !== null && wm_class.trim().length === 0) {
                wm_class = this.name(ext);
            }

            const role = this.meta.get_role();

            // Quake-style terminals such as Tilix's quake mode.
            if (role === 'quake') return false;

            // Exclude oversized windows whose minimum size leaves insufficient space
            // for neighbouring windows (e.g. Steam, Winboat at certain scalings).
            const [min_known, min_width, min_height] = (this.meta as any).get_min_size();
            if (min_known) {
                const oversized_w = ext.settings.oversized_window_width();
                const oversized_h = ext.settings.oversized_window_height();
                const is_oversized =
                    (oversized_w > 0 && min_width > oversized_w) ||
                    (oversized_h > 0 && min_height > oversized_h);
                if (is_oversized) return false;
            }

            // Steam loading window is less than 400px wide and 200px tall
            if (this.meta.get_title() === 'Steam') {
                const rect = this.rect();

                const is_dialog = rect.width < 400 && rect.height < 200;
                const is_first_login = rect.width === 432 && rect.height === 438;

                if (is_dialog || is_first_login) return false;
            }

            // Blacklist any windows that happen to leak through our filter
            // Windows that are tagged ForceTile are considered tilable despite exemption
            if (wm_class !== null && ext.conf.window_shall_float(wm_class, this.title())) {
                return ext.contains_tag(this.entity, Tags.ForceTile);
            }

            // Only normal windows will be considered for tiling
            return (
                this.meta.window_type == Meta.WindowType.NORMAL &&
                // Transient windows are most likely dialogs
                !this.is_transient() &&
                // If a window lacks a class, it's probably a web browser dialog
                wm_class !== null
            );
        };

        return !ext.contains_tag(this.entity, Tags.Floating) && tile_checks();
    }

    is_transient(): boolean {
        return this.meta.get_transient_for() !== null;
    }

    move(ext: Ext, rect: Rectangular, on_complete?: () => void) {
        if (!this.same_workspace() && this.is_maximized()) {
            return;
        }

        this.hide_border();

        const max_width = ext.settings.max_window_width();
        if (max_width > 0 && rect.width > max_width) {
            rect.x += (rect.width - max_width) / 2;
            rect.width = max_width;
        }

        const clone = Rect.Rectangle.from_meta(rect);
        const meta = this.meta;
        const actor = meta.get_compositor_private();

        if (actor) {
            if (this.is_maximized()) {
                utils.unmaximize(meta);
            }
            actor.remove_all_transitions();

            ext.movements.insert(this.entity, clone);

            ext.register({ tag: 2, window: this, kind: { tag: 1 } });
            if (on_complete) ext.register_fn(on_complete);
            if (meta.appears_focused) {
                this.update_border_layout();
                ext.show_border_on_focused();
            }
        }
    }

    name(ext: Ext): string {
        return ext.names.get_or(this.entity, () => 'unknown');
    }

    private on_style_changed() {
        if (!this.border) return;
        this.border_size = this.border.get_theme_node().get_border_width(St.Side.TOP);
    }

    rect(): Rectangle {
        return Rect.Rectangle.from_meta(this.meta.get_frame_rect());
    }

    swap(ext: Ext, other: ShellWindow): void {
        let ar = this.rect().clone();
        let br = other.rect().clone();

        other.move(ext, ar);
        this.move(ext, br, () => place_pointer_on(this.ext, this.meta));
    }

    title(): string {
        const title = this.meta.get_title();
        return title ? title : this.name(this.ext);
    }

    workspace_id(): number {
        const workspace = this.meta.get_workspace();
        if (workspace) {
            return workspace.index();
        } else {
            this.meta.change_workspace_by_index(0, false);
            return 0;
        }
    }

    xid(): string | null {
        return this.extra.xid_.get_or_init(() => {
            if (utils.is_wayland()) return null;
            return xprop.get_xid(this.meta);
        });
    }

    show_border() {
        const activation = this.ext.window_io_generation();
        if (!this.ui_current(activation)) return;
        this.restack();
        this.update_border_style();
        const border = this.border;
        if (!border || !this.ext.settings.active_hint()) return;
        const sameMonitorCount = this.ext.active_window_list().filter((w) =>
            !w.meta.minimized && w.meta.get_monitor() === this.meta.get_monitor()).length;
        const permitted = () => this.ui_current(activation) && this.border === border &&
            this.ext.settings.active_hint() && this.ext.focus_window() === this &&
            !this.meta.is_fullscreen() && !this.meta.minimized &&
            (sameMonitorCount > 1 || this.is_snap_edge() || this.ext.settings.active_hint_show_on_maximized());
        if (!permitted()) return;
        border.show();
        if (!permitted()) return;
        let applications = 0;
        const request: WindowUIRequest = { owner: this, source: null };
        const owns = () => ACTIVE_HINT_SHOW_ID === request;
        const release = () => {
            if (owns()) ACTIVE_HINT_SHOW_ID = null;
            request.source = null;
        };
        const previous = ACTIVE_HINT_SHOW_ID;
        ACTIVE_HINT_SHOW_ID = request;
        if (previous) cancel_ui_source(previous);
        if (!owns() || !permitted()) { release(); return; }
        try {
            request.source = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 600, () => {
                if (!owns()) return GLib.SOURCE_REMOVE;
                try {
                    if (!permitted() || (applications > 4 && !this.same_workspace())) {
                        release();
                        return GLib.SOURCE_REMOVE;
                    }
                    applications += 1;
                    border.show();
                    const keep = owns() && permitted();
                    if (!keep) release();
                    return keep;
                } catch (why) {
                    release();
                    report_ui_error(why);
                    return GLib.SOURCE_REMOVE;
                }
            });
        } catch (why) { release(); report_ui_error(why); }
    }

    same_workspace() {
        const workspace = this.meta.get_workspace();
        if (workspace) {
            let workspace_id = workspace.index();
            return workspace_id === global.workspace_manager.get_active_workspace_index();
        }
        return false;
    }

    same_monitor() {
        return this.meta.get_monitor() === global.display.get_current_monitor();
    }

    /**
     * Sort the window group/always top group with each window border
     * @param updateState NORMAL, RAISED, WORKSPACE_CHANGED
     */
    restack(updateState: RESTACK_STATE = RESTACK_STATE.NORMAL) {
        const activation = this.ext.window_io_generation();
        if (!this.ext.allows_window_io() || !this.actor_exists() || !this.border) return;
        const expected_border = this.border;
        this.update_border_layout();
        const sameMonitorCount = this.ext.active_window_list().filter((w) => !w.meta.minimized && w.meta.get_monitor() === this.meta.get_monitor()).length;
        if (
            this.meta.is_fullscreen() ||
            this.meta.minimized ||
            (!this.is_snap_edge() &&
                !this.ext.settings.active_hint_show_on_maximized() &&
                sameMonitorCount <= 1)
        ) {
            this.hide_border();
        }

        let restackSpeed = RESTACK_SPEED.NORMAL;

        switch (updateState) {
            case RESTACK_STATE.NORMAL:
                restackSpeed = RESTACK_SPEED.NORMAL;
                break;
            case RESTACK_STATE.RAISED:
                restackSpeed = RESTACK_SPEED.RAISED;
                break;
            case RESTACK_STATE.WORKSPACE_CHANGED:
                restackSpeed = RESTACK_SPEED.WORKSPACE_CHANGED;
                break;
        }

        let restacks = 0;
        const request: WindowUIRequest = { owner: this, source: null };
        const owns = () => SCHEDULED_RESTACK === request;
        const current = () => this.ui_current(activation) && this.border === expected_border;
        const release = () => {
            if (owns()) SCHEDULED_RESTACK = null;
            request.source = null;
        };
        const action = () => {
            if (!owns()) return GLib.SOURCE_REMOVE;
            try {
                if (!current()) { release(); return GLib.SOURCE_REMOVE; }
                const border = this.border;
                const actor = this.meta.get_compositor_private();
                const win_group = global.window_group;

                if (actor && border && win_group) {
                    this.update_border_layout();
                    if (!owns() || !current()) { release(); return GLib.SOURCE_REMOVE; }
                    // move the border above the window group first
                    if (!owns() || !current()) { release(); return GLib.SOURCE_REMOVE; }
                    win_group.set_child_above_sibling(border, null);
                    if (!owns() || !current()) { release(); return GLib.SOURCE_REMOVE; }

                    if (this.always_top_windows.length > 0) {
                        // honor the always-top windows
                        for (const above_actor of this.always_top_windows) {
                            if (actor != above_actor) {
                                if (border.get_parent() === above_actor.get_parent()) {
                                    if (!owns() || !current()) { release(); return GLib.SOURCE_REMOVE; }
                                    win_group.set_child_below_sibling(border, above_actor);
                                    if (!owns() || !current()) { release(); return GLib.SOURCE_REMOVE; }
                                }
                            }
                        }

                        // Move the border above the current window actor
                        if (border.get_parent() === actor.get_parent()) {
                            if (!owns() || !current()) { release(); return GLib.SOURCE_REMOVE; }
                            win_group.set_child_above_sibling(border, actor);
                            if (!owns() || !current()) { release(); return GLib.SOURCE_REMOVE; }
                        }
                    }

                    // Honor transient windows
                    for (const window of this.ext.windows.values()) {
                        const parent = window.meta.get_transient_for();
                        const window_actor = window.meta.get_compositor_private();
                        if (!parent || !window_actor) continue;
                        const parent_actor = parent.get_compositor_private();
                        if (!parent_actor && parent_actor !== actor) continue;
                        if (!owns() || !current()) { release(); return GLib.SOURCE_REMOVE; }
                        win_group.set_child_below_sibling(border, window_actor);
                        if (!owns() || !current()) { release(); return GLib.SOURCE_REMOVE; }
                    }
                }
                restacks += 1;
                const keep = restacks < 4 && owns() && current();
                if (!keep) release();
                return keep;
            } catch (why) {
                release();
                report_ui_error(why);
                return GLib.SOURCE_REMOVE;
            }
        };
        const previous = SCHEDULED_RESTACK;
        SCHEDULED_RESTACK = request;
        if (previous) cancel_ui_source(previous);
        if (!owns() || activation !== this.ext.window_io_generation() ||
            !this.ext.allows_window_io() || !this.actor_exists()) { release(); return; }
        try { request.source = GLib.timeout_add(GLib.PRIORITY_LOW, restackSpeed, action); }
        catch (why) { release(); report_ui_error(why); }
    }

    get always_top_windows(): Clutter.Actor[] {
        let above_windows: Clutter.Actor[] = new Array();

        for (const actor of global.get_window_actors()) {
            if (actor && actor.get_meta_window() && actor.get_meta_window().is_above()) above_windows.push(actor);
        }

        return above_windows;
    }

    private ui_current(activation: number): boolean {
        return activation === this.ext.window_io_generation() && this.ext.allows_window_io() &&
            this.actor_exists() && this.border !== null && this.ext.windows.get(this.entity) === this;
    }

    /** Revoke UI work before native resources or the activation are torn down. */
    stop_ui_work(): void {
        const restack = SCHEDULED_RESTACK?.owner === this ? SCHEDULED_RESTACK : null;
        const hint = ACTIVE_HINT_SHOW_ID?.owner === this ? ACTIVE_HINT_SHOW_ID : null;
        if (restack) SCHEDULED_RESTACK = null;
        if (hint) ACTIVE_HINT_SHOW_ID = null;
        if (restack) cancel_ui_source(restack);
        if (hint) cancel_ui_source(hint);
    }

    hide_border() {
        if (ACTIVE_HINT_SHOW_ID?.owner === this) {
            const request = ACTIVE_HINT_SHOW_ID;
            ACTIVE_HINT_SHOW_ID = null;
            cancel_ui_source(request);
        }
        let b = this.border;
        if (b) b.hide();
    }

    update_border_layout() {
        let { x, y, width, height } = this.meta.get_frame_rect();

        const border = this.border;
        let borderSize = this.border_size;

        if (border) {
            if (!(this.is_max_screen() || this.is_snap_edge())) {
                border.remove_style_class_name('pop-shell-border-maximize');
            } else {
                borderSize = 0;
                border.add_style_class_name('pop-shell-border-maximize');
            }

            const stack_number = this.stack;
            let dimensions = null;

            if (stack_number !== null) {
                const stack = this.ext.auto_tiler?.forest.stacks.get(stack_number);
                if (stack) {
                    let stack_tab_height = stack.tabs_height;

                    if (borderSize === 0 || this.grab) {
                        // not in max screen state
                        stack_tab_height = 0;
                    }

                    dimensions = [
                        x - borderSize,
                        y - stack_tab_height - borderSize,
                        width + 2 * borderSize,
                        height + stack_tab_height + 2 * borderSize,
                    ];
                }
            } else {
                dimensions = [x - borderSize, y - borderSize, width + 2 * borderSize, height + 2 * borderSize];
            }

            if (dimensions) {
                [x, y, width, height] = dimensions;

                const workspace = this.meta.get_workspace();

                if (workspace === null) return;

                const screen = workspace.get_work_area_for_monitor(this.meta.get_monitor());

                if (screen) {
                    width = Math.min(width, screen.x + screen.width);
                    height = Math.min(height, screen.y + screen.height);
                }

                border.set_position(x, y);
                border.set_size(width, height);
            }
        }
    }

    update_border_style() {
        const { settings } = this.ext;
        const color_value = settings.hint_color_rgba();
        const radius_value = (this.is_maximized() || this.is_single_max_screen())
            ? 0
            : settings.active_hint_border_radius();
        const width_value = settings.active_hint_border_width();
        if (this.border) {
            this.border.set_style(`border-color: ${color_value}; border-width: ${width_value}px; border-radius: ${radius_value}px;`);
        }
    }

    private wm_class_changed() {
        if (this.is_tilable(this.ext)) {
            this.ext.connect_window(this);
            if (!this.meta.minimized) {
                this.ext.auto_tiler?.auto_tile(this.ext, this, this.ext.init);
            }
        }
    }

    private window_changed() {
        this.update_border_layout();
        this.ext.show_border_on_focused();
    }

    private window_raised() {
        this.restack(RESTACK_STATE.RAISED);
        this.ext.show_border_on_focused();
    }

    private workspace_changed() {
        this.restack(RESTACK_STATE.WORKSPACE_CHANGED);
    }
}

/// Activates a window, and moves the mouse point.
export function activate(ext: Ext, move_mouse: boolean, win: Meta.Window) {
    try {
        // Return if window was destroyed.
        if (!win.get_compositor_private()) return;

        // Return if window is being destroyed.
        if (ext.get_window(win)?.destroying) return;

        // Return if window has override-redirect set.
        if (win.is_override_redirect()) return;

        const workspace = win.get_workspace();
        if (!workspace) return;

        scheduler.setForeground(win);

        win.unminimize();
        workspace.activate_with_focus(win, global.get_current_time());
        win.raise();

        const pointer_placement_permitted =
            move_mouse &&
            Main.modalCount === 0 &&
            ext.settings.mouse_cursor_follows_active_window() &&
            !pointer_already_on_window(win) &&
            pointer_in_work_area();

        if (pointer_placement_permitted) {
            place_pointer_on(ext, win);
        }
    } catch (error) {
        log.error(`failed to activate window: ${error}`);
    }
}

function pointer_in_work_area(): boolean {
    const cursor = lib.cursor_rect();
    const indice = global.display.get_current_monitor();
    const mon = global.display.get_workspace_manager().get_active_workspace().get_work_area_for_monitor(indice);

    return mon ? cursor.intersects(mon) : false;
}

function place_pointer_on(ext: Ext, win: Meta.Window) {
    const rect = win.get_frame_rect();
    let x = rect.x;
    let y = rect.y;

    let key = Object.keys(focus.FocusPosition)[ext.settings.mouse_cursor_focus_location()];
    let pointer_position_ = focus.FocusPosition[key as keyof typeof focus.FocusPosition];

    switch (pointer_position_) {
        case focus.FocusPosition.TopLeft:
            x += 8;
            y += 8;
            break;
        case focus.FocusPosition.BottomLeft:
            x += 8;
            y += rect.height - 16;
            break;
        case focus.FocusPosition.TopRight:
            x += rect.width - 16;
            y += 8;
            break;
        case focus.FocusPosition.BottomRight:
            x += rect.width - 16;
            y += rect.height - 16;
            break;
        case focus.FocusPosition.Center:
            x += rect.width / 2 + 8;
            y += rect.height / 2 + 8;
            break;
        default:
            x += 8;
            y += 8;
    }

    global.stage.get_context().get_backend().get_default_seat().warp_pointer(x, y);
}

function pointer_already_on_window(meta: Meta.Window): boolean {
    const cursor = lib.cursor_rect();

    return cursor.intersects(meta.get_frame_rect());
}
