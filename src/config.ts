import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

const CONF_DIR: string = GLib.get_user_config_dir() + '/pop-shell';
export var CONF_FILE: string = CONF_DIR + '/config.json';

export type MatchMode = 'exact' | 'regex';

export interface FloatRule {
    class?: string;
    title?: string;
    disabled?: boolean;
    match?: MatchMode;
}

interface Ok<T> {
    tag: 0;
    value: T;
}

interface Error {
    tag: 1;
    why: string;
}

type Result<T> = Ok<T> | Error;

/** Compiled regex cache so window focus checks do not recompile rules every time. */
const REGEX_CACHE: Map<string, RegExp | null> = new Map();

function compile_regex(source: string): RegExp | null {
    if (REGEX_CACHE.has(source)) return REGEX_CACHE.get(source) ?? null;

    let regex: RegExp | null = null;
    try {
        regex = new RegExp(source, 'i');
    } catch (why) {
        log(`pop-shell: invalid window rule pattern "${source}": ${why}`);
    }

    REGEX_CACHE.set(source, regex);
    return regex;
}

function valid_rule(value: any): value is FloatRule {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
    if (value.class !== undefined && typeof value.class !== 'string') return false;
    if (value.title !== undefined && typeof value.title !== 'string') return false;
    if (value.match !== undefined && value.match !== 'exact' && value.match !== 'regex') return false;
    if (value.disabled !== undefined && typeof value.disabled !== 'boolean') return false;
    return (typeof value.class === 'string' && value.class.length > 0) ||
        (typeof value.title === 'string' && value.title.length > 0);
}

export const DEFAULT_FLOAT_RULES: Array<FloatRule> = [
    { class: 'Authy Desktop' },
    { class: 'Com.github.amezin.ddterm' },
    { class: 'Com.github.donadigo.eddy' },
    { class: 'Conky' },
    { title: 'Discord Updater' },
    { class: 'Enpass', title: 'Enpass Assistant' },
    { class: 'Floating Window Exceptions' },
    { class: 'Gjs', title: 'Settings' },
    { class: 'Gnome-initial-setup' },
    { class: 'Gnome-terminal', title: 'Preferences – General' },
    { class: 'Guake' },
    { class: 'Io.elementary.sideload' },
    { title: 'JavaEmbeddedFrame' },
    { class: 'KotatogramDesktop', title: 'Media viewer' },
    { class: 'Mozilla VPN' },
    { class: 'update-manager', title: 'Software Updater' },
    { class: 'Solaar' },
    { class: 'Steam', title: '^((?!Steam).)*$' },
    { class: 'Steam', title: '^.*(Guard|Login).*' },
    { class: 'TelegramDesktop', title: 'Media viewer' },
    { class: 'Zotero', title: 'Quick Format Citation' },
    { class: 'firefox', title: '^(?!.*Mozilla Firefox).*$' },
    { class: 'gnome-screenshot' },
    { class: 'ibus-.*' },
    { class: 'jetbrains-toolbox' },
    { class: 'jetbrains-webstorm', title: 'Customize WebStorm' },
    { class: 'jetbrains-webstorm', title: 'License Activation' },
    { class: 'jetbrains-webstorm', title: 'Welcome to WebStorm' },
    { class: 'krunner' },
    { class: 'pritunl' },
    { class: 're.sonny.Junction' },
    { class: 'system76-driver' },
    { class: 'tilda' },
    { class: 'zoom' },
    { class: '^.*action=join.*$' },
    { class: 'gjs' },
];

export interface WindowRule {
    class?: string;
    title?: string;
    disabled?: boolean;
    match?: MatchMode;
}

/**
 * These windows will skip showing in Overview, Thumbnails or SwitcherList
 * And any rule here should be added on the DEFAULT_RULES above
 */
export const SKIPTASKBAR_EXCEPTIONS: Array<WindowRule> = [
    { class: 'Conky' },
    { class: 'gjs' },
    { class: 'Guake' },
    { class: 'Com.github.amezin.ddterm' },
    { class: 'plank' },
];

/** Rules without a mode retain their historical regex semantics. */
export function rule_mode(rule: FloatRule): MatchMode {
    return rule.match ?? 'regex';
}

function same_rule(a: FloatRule, b: FloatRule): boolean {
    return a.class === b.class && a.title === b.title && rule_mode(a) === rule_mode(b);
}

function matches_rule(rule: FloatRule, wmclass: string | null, title: string | null): boolean {
    if (!valid_rule(rule)) return false;
    if (rule_mode(rule) === 'exact') {
        return (rule.class === undefined || rule.class === wmclass) &&
            (rule.title === undefined || rule.title === title);
    }
    if (rule.class && (typeof wmclass !== 'string' || !compile_regex(rule.class)?.test(wmclass))) return false;
    if (rule.title && (typeof title !== 'string' || !compile_regex(rule.title)?.test(title))) return false;
    return true;
}

export class Config {
    /** List of windows that should float, regardless of their WM hints */
    float: Array<FloatRule> = [];

    /**
     * List of Windows with skip taskbar true but still hidden in Overview,
     * Switchers, Workspace Thumbnails
     */
    skiptaskbarhidden: Array<WindowRule> = [];

    /** Logs window details on focus of window */
    log_on_focus: boolean = false;

    /** New selections are literal, case-sensitive rules; legacy regex rules coexist. */
    add_app_exception(wmclass: string) {
        const rule: FloatRule = { class: wmclass, match: 'exact' };
        if (!valid_rule(rule) || this.float.some(value => same_rule(value, rule))) return;
        this.float.push(rule);
        this.sync_to_disk();
    }

    add_window_exception(wmclass: string, title: string) {
        const rule: FloatRule = { class: wmclass, title, match: 'exact' };
        if (!valid_rule(rule) || this.float.some(value => same_rule(value, rule))) return;
        this.float.push(rule);
        this.sync_to_disk();
    }

    window_shall_float(wclass: string, title: string): boolean {
        for (const rule of this.float.concat(DEFAULT_FLOAT_RULES)) {
            if (matches_rule(rule, wclass, title)) return !rule.disabled;
        }
        return false;
    }

    skiptaskbar_shall_hide(meta_window: any) {
        if (!meta_window.is_skip_taskbar()) return false;
        const wmclass = meta_window.get_wm_class();
        const title = meta_window.get_title();
        for (const rule of this.skiptaskbarhidden.concat(SKIPTASKBAR_EXCEPTIONS)) {
            if (matches_rule(rule, wmclass, title)) return !rule.disabled;
        }
        return false;
    }

    reload() {
        const conf = Config.from_config();

        if (conf.tag === 0) {
            const c = conf.value;
            REGEX_CACHE.clear();
            this.float = c.float;
            this.skiptaskbarhidden = c.skiptaskbarhidden;
            this.log_on_focus = c.log_on_focus;
        } else {
            log(`error loading conf: ${conf.why}`);
        }
    }

    rule_disabled(rule: FloatRule): boolean {
        for (const value of this.float.values()) {
            if (value.disabled && same_rule(value, rule)) {
                return true;
            }
        }

        return false;
    }

    to_json(): string {
        return JSON.stringify(this, set_to_json, 2);
    }

    toggle_system_exception(wmclass: string | undefined, wmtitle: string | undefined, disabled: boolean) {
        const standard = DEFAULT_FLOAT_RULES.find(rule => rule.class === wmclass && rule.title === wmtitle);
        if (!standard) return;

        const matching = this.float.filter(rule => same_rule(rule, standard));
        if (disabled && matching.length === 1 && matching[0].disabled === true) return;
        if (!disabled && matching.length === 0) return;

        this.float = this.float.filter(rule => !same_rule(rule, standard));
        if (disabled) this.float.push({ ...standard, disabled: true });
        this.sync_to_disk();
    }

    remove_user_exception(wmclass: string | undefined, wmtitle: string | undefined, match: MatchMode = 'regex') {
        const target: FloatRule = { class: wmclass, title: wmtitle, match };
        const remaining = this.float.filter(rule => !same_rule(rule, target));
        if (remaining.length === this.float.length) return;
        this.float = remaining;
        this.sync_to_disk();
    }

    /** Preserve the existing public fallback API; reload uses the strict result. */
    static from_json(json: string): Config {
        const parsed = Config.parse_json(json);
        if (parsed.tag === 0) return parsed.value;
        log(`pop-shell: failed to parse config: ${parsed.why}`);
        return new Config();
    }

    private static parse_json(json: string): Result<Config> {
        try {
            const data = JSON.parse(json);
            if (data === null || typeof data !== 'object' || Array.isArray(data)) {
                return { tag: 1, why: 'config root must be an object' };
            }
            if (data.float !== undefined && !Array.isArray(data.float)) {
                return { tag: 1, why: 'float must be an array' };
            }
            if (data.skiptaskbarhidden !== undefined && !Array.isArray(data.skiptaskbarhidden)) {
                return { tag: 1, why: 'skiptaskbarhidden must be an array' };
            }
            if (data.log_on_focus !== undefined && typeof data.log_on_focus !== 'boolean') {
                return { tag: 1, why: 'log_on_focus must be a boolean' };
            }

            const config = new Config();
            if (Array.isArray(data.float)) config.float = data.float.filter(valid_rule);
            if (Array.isArray(data.skiptaskbarhidden)) {
                config.skiptaskbarhidden = data.skiptaskbarhidden.filter(valid_rule);
            }
            if (typeof data.log_on_focus === 'boolean') config.log_on_focus = data.log_on_focus;
            return { tag: 0, value: config };
        } catch (why) {
            return { tag: 1, why: `invalid config JSON: ${why}` };
        }
    }

    private static from_config(): Result<Config> {
        const stream = Config.read();
        if (stream.tag === 1) return stream;
        return Config.parse_json(stream.value);
    }

    private static gio_file(): Result<any> {
        try {
            const conf = Gio.File.new_for_path(CONF_FILE);

            if (!conf.query_exists(null)) {
                const dir = Gio.File.new_for_path(CONF_DIR);
                if (!dir.query_exists(null) && !dir.make_directory(null)) {
                    return { tag: 1, why: 'failed to create pop-shell config directory' };
                }

                const example = new Config();
                example.float.push({ class: 'pop-shell-example', title: 'pop-shell-example' });

                conf.create(Gio.FileCreateFlags.NONE, null).write_all(JSON.stringify(example, undefined, 2), null);
            }

            return { tag: 0, value: conf };
        } catch (why) {
            return { tag: 1, why: `Gio.File I/O error: ${why}` };
        }
    }

    private static read(): Result<string> {
        try {
            const file = Config.gio_file();
            if (file.tag === 1) return file;

            const [ok, buffer] = file.value.load_contents(null);
            if (!ok) return { tag: 1, why: 'failed to read config contents' };

            return { tag: 0, value: imports.byteArray.toString(buffer) };
        } catch (why) {
            return { tag: 1, why: `failed to read pop-shell config: ${why}` };
        }
    }

    private static write(data: string): Result<null> {
        try {
            const file = Config.gio_file();
            if (file.tag === 1) return file;

            const [ok] = file.value.replace_contents(data, null, false, Gio.FileCreateFlags.NONE, null);
            if (!ok) return { tag: 1, why: 'failed to replace config contents' };

            return { tag: 0, value: null };
        } catch (why) {
            return { tag: 1, why: `failed to write to config: ${why}` };
        }
    }

    sync_to_disk(): boolean {
        const written = Config.write(this.to_json());
        if (written.tag === 1) {
            log(`pop-shell: failed to save config: ${written.why}`);
            return false;
        }
        return true;
    }
}

function set_to_json(_key: string, value: any) {
    if (typeof value === 'object' && value instanceof Set) {
        return [...value];
    }
    return value;
}

