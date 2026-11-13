import GLib from 'gi://GLib';
import { AsyncConfigStore } from './config_io.js';

export var CONF_FILE: string = GLib.get_user_config_dir() + '/pop-shell/config.json';

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

export type Result<T> = Ok<T> | Error;

/** Success includes no-op updates; applied=false does NOT mean the file was unchanged. */
export type ConfigSaveResult = Ok<{ applied: boolean }> | {
    tag: 1;
    why: string;
    persistence: 'not-started' | 'unknown';
};

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

// Keep runtime bookkeeping out of JSON.stringify(this).
const LOAD_GENERATIONS: WeakMap<Config, number> = new WeakMap();
const ASYNC_STORES: WeakMap<Config, AsyncConfigStore> = new WeakMap();
const WRITE_QUEUES: WeakMap<Config, Promise<void>> = new WeakMap();

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
    private add_rule(rule: FloatRule): boolean {
        if (!valid_rule(rule) || this.float.some(value => same_rule(value, rule))) return false;
        this.float.push(rule);
        return true;
    }

    add_app_exception_async(wmclass: string, cancellable: any = null): Promise<ConfigSaveResult> {
        return this.update_async(config => config.add_rule({ class: wmclass, match: 'exact' }), cancellable);
    }

    add_window_exception_async(wmclass: string, title: string, cancellable: any = null): Promise<ConfigSaveResult> {
        return this.update_async(config => config.add_rule({ class: wmclass, title, match: 'exact' }), cancellable);
    }

    toggle_system_exception_async(wmclass: string | undefined, wmtitle: string | undefined,
        disabled: boolean, cancellable: any = null): Promise<ConfigSaveResult> {
        return this.update_async(config => config.set_system_rule(wmclass, wmtitle, disabled), cancellable);
    }

    remove_user_exception_async(wmclass: string | undefined, wmtitle: string | undefined,
        match: MatchMode = 'regex', cancellable: any = null): Promise<ConfigSaveResult> {
        return this.update_async(config => config.remove_rule(wmclass, wmtitle, match), cancellable);
    }

    private async_store(): AsyncConfigStore {
        let store = ASYNC_STORES.get(this);
        if (!store) {
            store = new AsyncConfigStore(CONF_FILE);
            ASYNC_STORES.set(this, store);
        }
        return store;
    }

    private update_async(change: (config: Config) => boolean, cancellable: any): Promise<ConfigSaveResult> {
        this.invalidate_load();
        const generation = LOAD_GENERATIONS.get(this);
        const pending = this.save_change(change, generation, cancellable);
        WRITE_QUEUES.set(this, pending.then(() => undefined, () => undefined));
        return pending;
    }

    private async save_change(change: (config: Config) => boolean, generation: number | undefined,
        cancellable: any): Promise<ConfigSaveResult> {
        let started = false;
        try {
            if (cancellable?.is_cancelled()) {
                return { tag: 1, why: 'Configuration save cancelled before start', persistence: 'not-started' };
            }
            const store = this.async_store();
            started = true;
            const snapshot = await store.update(current => {
                const parsed = Config.parse_json(current ?? '{}');
                if (parsed.tag === 1) throw new Error(parsed.why);
                const raw = JSON.parse(current ?? '{}');
                // Reading retains legacy filtering; writing must not silently erase malformed rules.
                for (const rules of [raw.float, raw.skiptaskbarhidden]) {
                    if (Array.isArray(rules) && !rules.every(valid_rule)) {
                        throw new Error('Refusing to save configuration containing invalid rules');
                    }
                }
                const config = parsed.value;
                if (!change(config)) return current;
                return JSON.stringify({ ...raw, float: config.float,
                    skiptaskbarhidden: config.skiptaskbarhidden, log_on_focus: config.log_on_focus }, set_to_json, 2);
            }, cancellable);

            const parsed = Config.parse_json(snapshot.text ?? '{}');
            if (parsed.tag === 1) throw new Error(parsed.why);
            const applied = LOAD_GENERATIONS.get(this) === generation && !cancellable?.is_cancelled();
            if (applied) this.apply(parsed.value);
            return { tag: 0, value: { applied } };
        } catch (why) {
            // Even a rejected backend operation may already have persisted its change.
            return { tag: 1, why: `failed to save config asynchronously: ${why}`,
                persistence: started ? 'unknown' : 'not-started' };
        }
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

    /** Invalidate pending reads; a supplied Gio.Cancellable controls native cancellation. */
    invalidate_load(): void {
        LOAD_GENERATIONS.set(this, (LOAD_GENERATIONS.get(this) ?? 0) + 1);
    }

    /** true: applied; false: superseded/cancelled; tag 1: read or validation error. */
    async reload_async(cancellable: any = null): Promise<Result<boolean>> {
        this.invalidate_load();
        const generation = LOAD_GENERATIONS.get(this);
        const current = () => LOAD_GENERATIONS.get(this) === generation &&
            !cancellable?.is_cancelled();
        if (!current()) return { tag: 0, value: false };

        try {
            const writes = WRITE_QUEUES.get(this);
            if (writes) {
                await writes;
                if (!current()) return { tag: 0, value: false };
            }
            const snapshot = await this.async_store().load(cancellable);
            if (!current()) return { tag: 0, value: false };
            // An absent file means in-memory defaults, never implicit file creation.
            const applied = this.load_from_json(snapshot.text ?? '{}');
            if (applied.tag === 1) return applied;
            return { tag: 0, value: true };
        } catch (why) {
            if (!current()) return { tag: 0, value: false };
            return { tag: 1, why: `failed to load config asynchronously: ${why}` };
        }
    }

    /** Apply already-read JSON without filesystem I/O or fallback defaults on error. */
    load_from_json(json: string): Result<null> {
        this.invalidate_load();
        const parsed = Config.parse_json(json);
        if (parsed.tag === 1) return parsed;
        this.apply(parsed.value);
        return { tag: 0, value: null };
    }

    private apply(config: Config): void {
        REGEX_CACHE.clear();
        this.float = config.float;
        this.skiptaskbarhidden = config.skiptaskbarhidden;
        this.log_on_focus = config.log_on_focus;
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

    private set_system_rule(wmclass: string | undefined, wmtitle: string | undefined, disabled: boolean): boolean {
        const standard = DEFAULT_FLOAT_RULES.find(rule => rule.class === wmclass && rule.title === wmtitle);
        if (!standard) return false;
        const matching = this.float.filter(rule => same_rule(rule, standard));
        if (disabled && matching.length === 1 && matching[0].disabled === true) return false;
        if (!disabled && matching.length === 0) return false;
        this.float = this.float.filter(rule => !same_rule(rule, standard));
        if (disabled) this.float.push({ ...standard, disabled: true });
        return true;
    }

    private remove_rule(wmclass: string | undefined, wmtitle: string | undefined, match: MatchMode): boolean {
        const target: FloatRule = { class: wmclass, title: wmtitle, match };
        const remaining = this.float.filter(rule => !same_rule(rule, target));
        if (remaining.length === this.float.length) return false;
        this.float = remaining;
        return true;
    }

    /** Pure fallback parser; async loading and saving use the strict result. */
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


}

function set_to_json(_key: string, value: any) {
    if (typeof value === 'object' && value instanceof Set) {
        return [...value];
    }
    return value;
}

