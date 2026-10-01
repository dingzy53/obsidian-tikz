import { describe, expect, it } from "vitest";
import { DEFAULT_ENGINE, DEFAULT_TIMEOUT_SECONDS } from "../src/compiler";
import {
	DEFAULT_SETTINGS,
	MAX_TIMEOUT_SECONDS,
	mergeSettings,
	sanitizeMaxCacheEntries,
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
	it("round to whole numbers in range", () => {
		expect(sanitizeTimeoutSeconds(2.6)).toBe(3);
		expect(sanitizeMaxCacheEntries(0)).toBe(0);
	});
});
