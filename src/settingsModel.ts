/**
 * Settings schema and normalisation. Pure module: no `import "obsidian"`, so
 * what ends up in `data.json` can be unit-tested.
 */

import { DEFAULT_ENGINE, DEFAULT_TIMEOUT_SECONDS, ENGINE_IDS, type EngineId } from "./compiler/engineSpecs";
import { DEFAULT_PREAMBLE, LEGACY_DEFAULT_PREAMBLE, normalizePreamble } from "./compiler/wrapSource";
import { DEFAULT_SHARED_FOLDER, validateSharedFolder } from "./shared/folder";
import type { ColorAdaptation } from "./svg";

export interface SharedCompileError {
	summary: string;
	hint?: string;
}

export interface TikzSettings {
	/**
	 * Schema version of what is stored in `data.json`. One-time migrations of
	 * *old defaults* key on it, so they run once on data an older version
	 * saved, never on a value the user has just chosen in the settings tab.
	 */
	settingsVersion: number;
	engine: EngineId;
	/** Override for the TeX engine; empty = auto-detect (plan §6.4). */
	enginePath: string;
	/** Override for dvisvgm; empty = auto-detect. */
	dvisvgmPath: string;
	/** Extra directories appended to the child `PATH` (the macOS GUI fix). */
	extraPathDirs: string[];
	/** Multi-line `\usepackage{...}` block used for blocks that need wrapping. */
	defaultPreamble: string;
	/**
	 * `-shell-escape` opt-in. Off by default, always (AGENTS.md rule 3): with
	 * it on, opening a note can run arbitrary shell commands.
	 */
	allowShellEscape: boolean;
	compileTimeoutSeconds: number;
	/** Diagrams compiled in parallel. 0 = automatic (see `resolveConcurrency`). */
	maxConcurrentCompiles: number;
	/**
	 * How diagram colours are made to work on a dark theme. Replaces upstream's
	 * `invertColorsInDarkMode` boolean, which could only ever handle exact
	 * black and white (plan §16.13).
	 */
	colorAdaptation: ColorAdaptation;
	/** 0 = unlimited. */
	maxCacheEntries: number;
	/** Clicking a diagram (or Enter on it) opens the zoomable viewer. */
	zoomOnClick: boolean;
	/**
	 * Opt-in (AGENTS.md rule 2): mirror every diagram into {@link sharedFolder},
	 * a normal vault folder, so a sync service can carry it to a phone.
	 */
	shareWithMobile: boolean;
	/** Vault-relative folder for shared diagrams. */
	sharedFolder: string;
	/** Compact map of desktop compile failures keyed by shared key, synced to mobile. */
	sharedErrors: Record<string, SharedCompileError>;
}

/**
 * 1: everything before 1.3 (no `settingsVersion` key).
 * 2: 1.3, default cache size 500 -> 2000.
 */
export const SETTINGS_VERSION = 2;

export const DEFAULT_SETTINGS: TikzSettings = {
	settingsVersion: SETTINGS_VERSION,
	engine: DEFAULT_ENGINE,
	enginePath: "",
	dvisvgmPath: "",
	extraPathDirs: [],
	defaultPreamble: DEFAULT_PREAMBLE,
	allowShellEscape: false,
	compileTimeoutSeconds: DEFAULT_TIMEOUT_SECONDS,
	maxConcurrentCompiles: 0,
	colorAdaptation: "adaptive",
	// Above the ~600 diagrams of a large real vault: at 500 such a vault kept
	// evicting entries it was about to need again.
	maxCacheEntries: 2000,
	zoomOnClick: true,
	shareWithMobile: false,
	sharedFolder: DEFAULT_SHARED_FOLDER,
	sharedErrors: {},
};

const ADAPTATION_MODES: ColorAdaptation[] = ["adaptive", "light-canvas", "off"];

export const MAX_TIMEOUT_SECONDS = 3600;

/** The default before 1.3. `saveData` stores every key, so most users have it saved. */
const LEGACY_DEFAULT_MAX_CACHE_ENTRIES = 500;

/**
 * A timeout of zero or less would kill every compile instantly, and a huge one
 * defeats the "never hang" rule, so out-of-range values are brought back in
 * range rather than trusted. Anything that is not a finite number is reset.
 */
export function sanitizeTimeoutSeconds(value: unknown): number {
	if (typeof value !== "number" || !Number.isFinite(value)) return DEFAULT_TIMEOUT_SECONDS;
	return Math.min(MAX_TIMEOUT_SECONDS, Math.max(1, Math.round(value)));
}

export const MAX_CONCURRENT_COMPILES_LIMIT = 16;

/** 0 = automatic, otherwise a whole number of parallel compiles. */
export function sanitizeMaxConcurrentCompiles(value: unknown): number {
	if (typeof value !== "number" || !Number.isFinite(value)) return 0;
	return Math.min(MAX_CONCURRENT_COMPILES_LIMIT, Math.max(0, Math.floor(value)));
}

/** A non-negative whole number; 0 means unlimited. */
export function sanitizeMaxCacheEntries(value: unknown): number {
	if (typeof value !== "number" || !Number.isFinite(value)) return DEFAULT_SETTINGS.maxCacheEntries;
	return Math.max(0, Math.floor(value));
}

const MAX_SHARED_ERRORS = 500;
const SHARED_KEY_PATTERN = /^[0-9a-f]{64}$/;

function sanitizeSharedErrors(raw: unknown): Record<string, SharedCompileError> {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
	const clean: Record<string, SharedCompileError> = {};
	let count = 0;
	for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
		if (count >= MAX_SHARED_ERRORS) break;
		if (!SHARED_KEY_PATTERN.test(key) || !value || typeof value !== "object") continue;
		const entry = value as Partial<SharedCompileError>;
		if (typeof entry.summary !== "string" || entry.summary.trim().length === 0) continue;
		clean[key] = {
			summary: entry.summary,
			...(typeof entry.hint === "string" && entry.hint.trim().length > 0 ? { hint: entry.hint } : {}),
		};
		count++;
	}
	return clean;
}

/** Normalises whatever is in `data.json` into a complete settings object. */
export function mergeSettings(loaded: unknown): TikzSettings {
	const raw = (loaded ?? {}) as Partial<TikzSettings> & {
		/** Pre-1.1 spelling, still present in existing `data.json` files. */
		invertColorsInDarkMode?: unknown;
	};
	const merged: TikzSettings = { ...DEFAULT_SETTINGS, ...raw };

	if (!ENGINE_IDS.includes(merged.engine)) merged.engine = DEFAULT_ENGINE;
	if (!Array.isArray(merged.extraPathDirs)) merged.extraPathDirs = [];
	else merged.extraPathDirs = merged.extraPathDirs.filter((dir) => typeof dir === "string");
	if (typeof merged.defaultPreamble !== "string") {
		merged.defaultPreamble = DEFAULT_PREAMBLE;
	} else if (normalizePreamble(merged.defaultPreamble) === LEGACY_DEFAULT_PREAMBLE) {
		merged.defaultPreamble = DEFAULT_PREAMBLE;
	}
	merged.compileTimeoutSeconds = sanitizeTimeoutSeconds(merged.compileTimeoutSeconds);
	merged.maxCacheEntries = sanitizeMaxCacheEntries(merged.maxCacheEntries);
	const storedVersion = typeof raw.settingsVersion === "number" ? raw.settingsVersion : 1;
	// Pre-1.3 data with exactly the old default: `saveData` wrote it back as a
	// value, not a choice, so it follows the new default. Once migrated (or
	// when set in the settings tab) 500 is kept like any other value.
	if (storedVersion < 2 && raw.maxCacheEntries === LEGACY_DEFAULT_MAX_CACHE_ENTRIES) {
		merged.maxCacheEntries = DEFAULT_SETTINGS.maxCacheEntries;
	}
	merged.settingsVersion = SETTINGS_VERSION;
	merged.maxConcurrentCompiles = sanitizeMaxConcurrentCompiles(merged.maxConcurrentCompiles);
	merged.allowShellEscape = merged.allowShellEscape === true;
	merged.zoomOnClick = typeof merged.zoomOnClick === "boolean" ? merged.zoomOnClick : DEFAULT_SETTINGS.zoomOnClick;
	// Writing into the vault is opt-in, so only an explicit `true` turns it on.
	merged.shareWithMobile = merged.shareWithMobile === true;
	const folder = validateSharedFolder(merged.sharedFolder);
	merged.sharedFolder = folder.ok ? folder.path : DEFAULT_SHARED_FOLDER;
	merged.sharedErrors = sanitizeSharedErrors(raw.sharedErrors);
	// Retired in #4: the "Restrict file access" toggle set `openin_any=p`, which
	// is a no-op since TeX Live 2026 and broke luaotfload before that. Drop the
	// stale key so it does not linger in `data.json`.
	Reflect.deleteProperty(merged, "restrictFileAccess");
	merged.enginePath = typeof merged.enginePath === "string" ? merged.enginePath : "";
	merged.dvisvgmPath = typeof merged.dvisvgmPath === "string" ? merged.dvisvgmPath : "";

	// Judge the *stored* value: `merged` already carries the default, which is
	// always valid and would mask the legacy toggle below.
	if (raw.colorAdaptation !== undefined && ADAPTATION_MODES.includes(raw.colorAdaptation)) {
		// Already migrated; nothing to do.
	} else if (raw.invertColorsInDarkMode === false) {
		// The old toggle off meant "do not touch my colours".
		merged.colorAdaptation = "off";
	} else {
		// Absent, or the old toggle on: the new default is strictly better at
		// the job the old toggle was trying to do.
		merged.colorAdaptation = DEFAULT_SETTINGS.colorAdaptation;
	}

	return merged;
}

/** Keys of {@link TikzSettings}, for deciding whether a control key is ours. */
const SETTING_KEYS = new Set<string>(Object.keys(DEFAULT_SETTINGS));

/**
 * Value shown by the settings tab's control for `key`. `extraPathDirs` is a
 * list in storage but a one-directory-per-line textarea in the UI.
 */
export function readSettingValue(settings: TikzSettings, key: string): unknown {
	if (!SETTING_KEYS.has(key)) return undefined;
	if (key === "extraPathDirs") return settings.extraPathDirs.join("\n");
	return settings[key as keyof TikzSettings];
}

/**
 * Returns the settings with one control's value applied. Everything goes back
 * through {@link mergeSettings}, so a value from the UI gets exactly the same
 * validation and clamping as one loaded from `data.json`. Unknown keys are
 * ignored.
 */
export function applySettingChange(settings: TikzSettings, key: string, value: unknown): TikzSettings {
	if (!SETTING_KEYS.has(key)) return settings;

	let next = value;
	if (key === "extraPathDirs" && typeof value === "string") {
		next = value
			.split("\n")
			.map((line) => line.trim())
			.filter((line) => line.length > 0);
	} else if ((key === "enginePath" || key === "dvisvgmPath") && typeof value === "string") {
		next = value.trim();
	}
	return mergeSettings({ ...settings, [key]: next });
}
