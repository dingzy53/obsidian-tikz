/**
 * Settings schema and normalisation. Pure module: no `import "obsidian"`, so
 * what ends up in `data.json` can be unit-tested.
 */

import {
	DEFAULT_ENGINE,
	DEFAULT_PREAMBLE,
	DEFAULT_TIMEOUT_SECONDS,
	ENGINE_IDS,
	type EngineId,
} from "./compiler";
import type { ColorAdaptation } from "./svg";

export interface TikzSettings {
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
	/**
	 * Run TeX with `openin_any=p` so a block cannot read files outside its build
	 * folder (`\input{~/.ssh/config}`). On by default; same reasoning as shell
	 * escape: vault content is untrusted.
	 */
	restrictFileAccess: boolean;
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
}

export const DEFAULT_SETTINGS: TikzSettings = {
	engine: DEFAULT_ENGINE,
	enginePath: "",
	dvisvgmPath: "",
	extraPathDirs: [],
	defaultPreamble: DEFAULT_PREAMBLE,
	allowShellEscape: false,
	restrictFileAccess: true,
	compileTimeoutSeconds: DEFAULT_TIMEOUT_SECONDS,
	maxConcurrentCompiles: 0,
	colorAdaptation: "adaptive",
	maxCacheEntries: 500,
};

const ADAPTATION_MODES: ColorAdaptation[] = ["adaptive", "light-canvas", "off"];

export const MAX_TIMEOUT_SECONDS = 3600;

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
	if (typeof merged.defaultPreamble !== "string") merged.defaultPreamble = DEFAULT_PREAMBLE;
	merged.compileTimeoutSeconds = sanitizeTimeoutSeconds(merged.compileTimeoutSeconds);
	merged.maxCacheEntries = sanitizeMaxCacheEntries(merged.maxCacheEntries);
	merged.maxConcurrentCompiles = sanitizeMaxConcurrentCompiles(merged.maxConcurrentCompiles);
	merged.allowShellEscape = merged.allowShellEscape === true;
	// Only an explicit `false` opts out; anything else keeps the safe default.
	merged.restrictFileAccess = merged.restrictFileAccess !== false;
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
