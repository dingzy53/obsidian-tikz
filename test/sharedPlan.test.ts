import { describe, expect, it } from "vitest";
import { DEFAULT_SHARED_FOLDER, normalizeFolderPath, validateSharedFolder } from "../src/shared/folder";
import { isSharedFileName, keyOfSharedFile, planSync, sharedFileName } from "../src/shared/plan";

const A = "a".repeat(64);
const B = "b".repeat(64);
const C = "c".repeat(64);

describe("shared file names", () => {
	it("recognises only <64 hex>.svg", () => {
		expect(isSharedFileName(sharedFileName(A))).toBe(true);
		expect(keyOfSharedFile(`${B}.svg`)).toBe(B);
		for (const name of ["notes.txt", `${A}.png`, `${A.slice(1)}.svg`, `${A.toUpperCase()}.svg`, `x${A}.svg`, "diagram.svg"]) {
			expect(isSharedFileName(name)).toBe(false);
		}
	});
});

describe("planSync", () => {
	it("lists missing keys and stale files", () => {
		const plan = planSync([A, B], [`${B}.svg`, `${C}.svg`]);
		expect(plan.missing).toEqual([A]);
		expect(plan.stale).toEqual([`${C}.svg`]);
	});

	it("never marks files that are not ours as stale", () => {
		const plan = planSync([], ["notes.txt", "my diagram.svg", `${A}.png`, `${A}.svg`]);
		expect(plan.stale).toEqual([`${A}.svg`]);
	});

	it("de-duplicates wanted keys", () => {
		expect(planSync([A, A], []).missing).toEqual([A]);
	});
});

describe("validateSharedFolder", () => {
	it("accepts and normalises a plain vault folder", () => {
		expect(validateSharedFolder(DEFAULT_SHARED_FOLDER)).toEqual({ ok: true, path: "TikZ cache" });
		expect(validateSharedFolder(" /99 - Assets//tikz\\\\cache/ ")).toEqual({ ok: true, path: "99 - Assets/tikz/cache" });
	});

	it("rejects folders Sync would never carry", () => {
		for (const raw of [".tikz-cache", "Assets/.hidden", ".obsidian/plugins/tikz/cache", ".obsidian"]) {
			expect(validateSharedFolder(raw).ok).toBe(false);
		}
		expect(validateSharedFolder(".obsidian-mobile/x", ".obsidian-mobile").ok).toBe(false);
	});

	it("rejects empty, root and relative segments", () => {
		for (const raw of ["", "   ", "/", "a/../b", "./a", 42, undefined]) {
			expect(validateSharedFolder(raw).ok).toBe(false);
		}
	});

	it("normalises separators", () => {
		expect(normalizeFolderPath("a\\b//c/")).toBe("a/b/c");
	});
});
