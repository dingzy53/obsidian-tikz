import * as path from "node:path";
import { describe, expect, it } from "vitest";
import {
	BinaryNotFoundError,
	describeResolution,
	isExecutable,
	isFlatpak,
	knownBinDirs,
	resolveBinary,
	scratchRoot,
	splitPathList,
} from "../src/compiler/pathResolve";

describe("isFlatpak", () => {
	it("returns a boolean", () => {
		expect(typeof isFlatpak()).toBe("boolean");
	});
});

describe("splitPathList", () => {
	it("returns empty array for undefined or empty string", () => {
		expect(splitPathList(undefined)).toEqual([]);
		expect(splitPathList("")).toEqual([]);
		expect(splitPathList("   ")).toEqual([]);
	});

	it("splits paths with delimiter and trims whitespace", () => {
		const sep = path.delimiter;
		const input = `  /usr/bin ${sep}  ${sep} /usr/local/bin  `;
		expect(splitPathList(input)).toEqual(["/usr/bin", "/usr/local/bin"]);
	});
});

describe("knownBinDirs", () => {
	it("returns known paths for linux including texlive years", () => {
		const dirs = knownBinDirs("linux");
		expect(dirs).toContain("/usr/bin");
		expect(dirs).toContain("/usr/local/bin");
		expect(dirs).toContain("/opt/texlive/2026/bin/x86_64-linux");
	});

	it("returns known paths for darwin", () => {
		const dirs = knownBinDirs("darwin");
		expect(dirs).toContain("/Library/TeX/texbin");
		expect(dirs).toContain("/opt/homebrew/bin");
	});

	it("returns known paths for win32", () => {
		const dirs = knownBinDirs("win32");
		expect(dirs).toContain("C:\\texlive\\2026\\bin\\windows");
	});
});

describe("isExecutable", () => {
	it("returns false for nonexistent paths", () => {
		expect(isExecutable("/nonexistent/file/path/here")).toBe(false);
	});

	it("returns true for a known system binary on linux/mac", () => {
		if (process.platform !== "win32") {
			expect(isExecutable("/bin/sh") || isExecutable("/usr/bin/sh")).toBe(true);
		}
	});
});

describe("scratchRoot", () => {
	it("returns a directory outside vault", () => {
		const root = scratchRoot();
		expect(path.isAbsolute(root)).toBe(true);
		expect(root.endsWith("obsidian-tikz")).toBe(true);
	});
});

describe("resolveBinary", () => {
	it("resolves an explicit existing executable", () => {
		if (process.platform !== "win32") {
			const target = isExecutable("/bin/sh") ? "/bin/sh" : "/usr/bin/sh";
			const resolved = resolveBinary({ name: "sh", override: target });
			expect(resolved.path).toBe(target);
			expect(resolved.viaHost).toBe(false);
		}
	});

	it("throws BinaryNotFoundError for a nonexistent override", () => {
		expect(() =>
			resolveBinary({
				name: "nonexistent",
				override: "/nonexistent/path/xyz",
				allowHost: false,
			}),
		).toThrow(BinaryNotFoundError);
	});

	it("throws BinaryNotFoundError when binary cannot be found in search dirs", () => {
		expect(() =>
			resolveBinary({
				name: "definitely_not_a_real_binary_abc123",
				envPath: "",
				extraDirs: [],
				allowHost: false,
			}),
		).toThrow(BinaryNotFoundError);
	});

	it("describes resolution failure cleanly", () => {
		const res = describeResolution({
			name: "definitely_not_a_real_binary_abc123",
			envPath: "",
			extraDirs: [],
			allowHost: false,
		});
		expect(res.found).toBe(false);
	});
});
