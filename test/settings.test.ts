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
} from "../src/settingsModel";

describe("mergeSettings", () => {
	it("fills every field from the defaults when nothing is stored", () => {
		expect(mergeSettings(null)).toEqual(DEFAULT_SETTINGS);
		expect(mergeSettings(undefined)).toEqual(DEFAULT_SETTINGS);
	});

	it("never leaves shell escape on unless it is exactly true", () => {
		expect(mergeSettings({ allowShellEscape: "yes" }).allowShellEscape).toBe(false);
		expect(mergeSettings({ allowShellEscape: 1 }).allowShellEscape).toBe(false);
		expect(mergeSettings({ allowShellEscape: true }).allowShellEscape).toBe(true);
	});

	it("restricts file access unless explicitly opted out", () => {
		expect(DEFAULT_SETTINGS.restrictFileAccess).toBe(true);
		expect(mergeSettings({}).restrictFileAccess).toBe(true);
		expect(mergeSettings({ restrictFileAccess: "no" }).restrictFileAccess).toBe(true);
		expect(mergeSettings({ restrictFileAccess: false }).restrictFileAccess).toBe(false);
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
