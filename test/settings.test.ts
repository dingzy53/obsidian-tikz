import { describe, expect, it } from "vitest";
import { DEFAULT_ENGINE, DEFAULT_TIMEOUT_SECONDS } from "../src/compiler";
import {
	DEFAULT_SETTINGS,
	MAX_TIMEOUT_SECONDS,
	applySettingChange,
	mergeSettings,
	readSettingValue,
	sanitizeMaxCacheEntries,
	sanitizeMaxConcurrentCompiles,
	sanitizeTimeoutSeconds,
	SETTINGS_VERSION,
} from "../src/settingsModel";
import { DEFAULT_PREAMBLE, LEGACY_DEFAULT_PREAMBLE, V1_DEFAULT_PREAMBLE } from "../src/compiler/wrapSource";

describe("mergeSettings", () => {
	it("fills every field from the defaults when nothing is stored", () => {
		expect(mergeSettings(null)).toEqual(DEFAULT_SETTINGS);
		expect(mergeSettings(undefined)).toEqual(DEFAULT_SETTINGS);
	});

	it("keeps mobile sharing off unless it is exactly true (it writes into the vault)", () => {
		expect(DEFAULT_SETTINGS.shareWithMobile).toBe(false);
		expect(mergeSettings({ shareWithMobile: "true" }).shareWithMobile).toBe(false);
		expect(mergeSettings({ shareWithMobile: 1 }).shareWithMobile).toBe(false);
		expect(mergeSettings({ shareWithMobile: true }).shareWithMobile).toBe(true);
		expect(applySettingChange(DEFAULT_SETTINGS, "shareWithMobile", true).shareWithMobile).toBe(true);
	});

	it("normalises the shared folder and falls back for folders Sync would skip", () => {
		expect(DEFAULT_SETTINGS.sharedFolder).toBe("TikZ cache");
		expect(mergeSettings({ sharedFolder: "/Assets//TikZ/" }).sharedFolder).toBe("Assets/TikZ");
		expect(mergeSettings({ sharedFolder: ".tikz-cache" }).sharedFolder).toBe("TikZ cache");
		expect(mergeSettings({ sharedFolder: ".obsidian/plugins/tikz" }).sharedFolder).toBe("TikZ cache");
		expect(mergeSettings({ sharedFolder: 7 }).sharedFolder).toBe("TikZ cache");
	});

	it("enables click-to-enlarge by default and keeps only boolean values", () => {
		expect(DEFAULT_SETTINGS.zoomOnClick).toBe(true);
		expect(mergeSettings({}).zoomOnClick).toBe(true);
		expect(mergeSettings({ zoomOnClick: false }).zoomOnClick).toBe(false);
		expect(mergeSettings({ zoomOnClick: "no" }).zoomOnClick).toBe(true);
		expect(mergeSettings({ zoomOnClick: 0 }).zoomOnClick).toBe(true);
		expect(mergeSettings(mergeSettings({ zoomOnClick: false })).zoomOnClick).toBe(false);
		expect(readSettingValue(DEFAULT_SETTINGS, "zoomOnClick")).toBe(true);
		expect(applySettingChange(DEFAULT_SETTINGS, "zoomOnClick", false).zoomOnClick).toBe(false);
	});

	it("never leaves shell escape on unless it is exactly true", () => {
		expect(mergeSettings({ allowShellEscape: "yes" }).allowShellEscape).toBe(false);
		expect(mergeSettings({ allowShellEscape: 1 }).allowShellEscape).toBe(false);
		expect(mergeSettings({ allowShellEscape: true }).allowShellEscape).toBe(true);
	});

	it("drops the retired restrictFileAccess key from stored data (issue #4)", () => {
		expect("restrictFileAccess" in DEFAULT_SETTINGS).toBe(false);
		expect("restrictFileAccess" in mergeSettings({ restrictFileAccess: true })).toBe(false);
		expect("restrictFileAccess" in mergeSettings({ restrictFileAccess: false })).toBe(false);
		expect(applySettingChange(DEFAULT_SETTINGS, "restrictFileAccess", true)).toBe(DEFAULT_SETTINGS);
	});

	it("rejects an unknown engine", () => {
		expect(mergeSettings({ engine: "rm -rf" }).engine).toBe(DEFAULT_ENGINE);
	});

	it("repairs a timeout that would kill every compile", () => {
		expect(mergeSettings({ compileTimeoutSeconds: 0 }).compileTimeoutSeconds).toBe(1);
		expect(mergeSettings({ compileTimeoutSeconds: -30 }).compileTimeoutSeconds).toBe(1);
		expect(mergeSettings({ compileTimeoutSeconds: "20" }).compileTimeoutSeconds).toBe(DEFAULT_TIMEOUT_SECONDS);
		expect(mergeSettings({ compileTimeoutSeconds: Infinity }).compileTimeoutSeconds).toBe(DEFAULT_TIMEOUT_SECONDS);
	});

	it("caps an absurd timeout", () => {
		expect(mergeSettings({ compileTimeoutSeconds: 1e9 }).compileTimeoutSeconds).toBe(MAX_TIMEOUT_SECONDS);
	});

	it("repairs a negative or fractional cache limit", () => {
		expect(mergeSettings({ maxCacheEntries: -5 }).maxCacheEntries).toBe(0);
		expect(mergeSettings({ maxCacheEntries: 12.9 }).maxCacheEntries).toBe(12);
		expect(mergeSettings({ maxCacheEntries: NaN }).maxCacheEntries).toBe(DEFAULT_SETTINGS.maxCacheEntries);
	});

	it("raises the cache limit to 2000, which a ~600-diagram vault fits in", () => {
		expect(DEFAULT_SETTINGS.maxCacheEntries).toBe(2000);
	});

	it("moves a pre-1.3 saved 500 (the old default) to the new default, once", () => {
		// `saveData` wrote the old default back as a value, so it is not a choice.
		expect(mergeSettings({ maxCacheEntries: 500 }).maxCacheEntries).toBe(2000);
		expect(mergeSettings({ maxCacheEntries: 501 }).maxCacheEntries).toBe(501);
		// Once migrated, 500 is an ordinary value again.
		expect(mergeSettings({ maxCacheEntries: 500, settingsVersion: 2 }).maxCacheEntries).toBe(500);
		expect(mergeSettings({ maxCacheEntries: 500 }).settingsVersion).toBe(SETTINGS_VERSION);
	});

	it("moves an untouched 1.0–1.2 default preamble to the new one, and keeps edited ones", () => {
		expect(mergeSettings({ defaultPreamble: V1_DEFAULT_PREAMBLE }).defaultPreamble).toBe(DEFAULT_PREAMBLE);
		expect(mergeSettings({ defaultPreamble: `  ${V1_DEFAULT_PREAMBLE}\n` }).defaultPreamble).toBe(DEFAULT_PREAMBLE);
		expect(mergeSettings({ defaultPreamble: LEGACY_DEFAULT_PREAMBLE }).defaultPreamble).toBe(DEFAULT_PREAMBLE);
		const edited = `${V1_DEFAULT_PREAMBLE}\n\\usepackage{siunitx}`;
		expect(mergeSettings({ defaultPreamble: edited }).defaultPreamble).toBe(edited);
		// Pasted back deliberately after the migration: kept.
		expect(
			mergeSettings({ defaultPreamble: V1_DEFAULT_PREAMBLE, settingsVersion: SETTINGS_VERSION }).defaultPreamble,
		).toBe(V1_DEFAULT_PREAMBLE);
	});

	it("loads heavy packages on demand by default, and repairs an unknown mode", () => {
		expect(DEFAULT_SETTINGS.heavyPackages).toBe("on-demand");
		expect(mergeSettings({ heavyPackages: "all" }).heavyPackages).toBe("all");
		expect(mergeSettings({ heavyPackages: "sometimes" }).heavyPackages).toBe("on-demand");
	});

	it("keeps 500 when the user chooses it in the settings tab", () => {
		expect(applySettingChange(DEFAULT_SETTINGS, "maxCacheEntries", 500).maxCacheEntries).toBe(500);
	});

	it("migrates the pre-1.1 invertColorsInDarkMode toggle", () => {
		expect(mergeSettings({ invertColorsInDarkMode: false }).colorAdaptation).toBe("off");
		expect(mergeSettings({ invertColorsInDarkMode: true }).colorAdaptation).toBe("adaptive");
		expect(mergeSettings({ colorAdaptation: "light-canvas" }).colorAdaptation).toBe("light-canvas");
	});

	it("drops non-string extra path entries", () => {
		expect(mergeSettings({ extraPathDirs: ["/a", 3, null, "/b"] }).extraPathDirs).toEqual(["/a", "/b"]);
		expect(mergeSettings({ extraPathDirs: "/a" }).extraPathDirs).toEqual([]);
	});
});

describe("sanitizers", () => {
	it("keeps parallel compiles within 0..16", () => {
		expect(sanitizeMaxConcurrentCompiles(-1)).toBe(0);
		expect(sanitizeMaxConcurrentCompiles("many")).toBe(0);
		expect(sanitizeMaxConcurrentCompiles(99)).toBe(16);
		expect(sanitizeMaxConcurrentCompiles(3.7)).toBe(3);
	});

	it("round to whole numbers in range", () => {
		expect(sanitizeTimeoutSeconds(2.6)).toBe(3);
		expect(sanitizeMaxCacheEntries(0)).toBe(0);
	});
});

describe("readSettingValue / applySettingChange", () => {
	it("shows extra PATH directories one per line and stores them as a list", () => {
		const settings = applySettingChange(DEFAULT_SETTINGS, "extraPathDirs", "/a\n  /b  \n\n");
		expect(settings.extraPathDirs).toEqual(["/a", "/b"]);
		expect(readSettingValue(settings, "extraPathDirs")).toBe("/a\n/b");
	});

	it("trims binary paths", () => {
		expect(applySettingChange(DEFAULT_SETTINGS, "enginePath", "  /usr/bin/latex ").enginePath).toBe(
			"/usr/bin/latex",
		);
	});

	it("validates UI values exactly like stored ones", () => {
		expect(applySettingChange(DEFAULT_SETTINGS, "compileTimeoutSeconds", 0).compileTimeoutSeconds).toBe(1);
		expect(applySettingChange(DEFAULT_SETTINGS, "engine", "nonsense").engine).toBe(DEFAULT_ENGINE);
		expect(applySettingChange(DEFAULT_SETTINGS, "allowShellEscape", "true").allowShellEscape).toBe(false);
	});

	it("does not mutate its input", () => {
		const before = { ...DEFAULT_SETTINGS };
		applySettingChange(DEFAULT_SETTINGS, "maxCacheEntries", 7);
		expect(DEFAULT_SETTINGS).toEqual(before);
	});

	it("ignores keys that are not settings", () => {
		expect(applySettingChange(DEFAULT_SETTINGS, "__proto__", { polluted: true })).toBe(DEFAULT_SETTINGS);
		expect(readSettingValue(DEFAULT_SETTINGS, "toString")).toBeUndefined();
	});
});
