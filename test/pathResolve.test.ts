import { execFileSync } from "node:child_process";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import {
	BinaryNotFoundError,
	buildHostSpawn,
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

describe("buildHostSpawn", () => {
	it("runs through flatpak-spawn --host in the given directory", () => {
		const { command, args } = buildHostSpawn("dvilualatex", ["-halt-on-error", "x.tex"], "/work");
		expect(command).toBe("/usr/bin/flatpak-spawn");
		expect(args.slice(0, 3)).toEqual(["--host", "--watch-bus", "--directory=/work"]);
		expect(args.slice(-3)).toEqual(["dvilualatex", "-halt-on-error", "x.tex"].slice(-3));
	});

	it("never replaces the host PATH via --env", () => {
		const { args } = buildHostSpawn("latex", [], "/work", ["/extra"]);
		expect(args.some((arg) => arg.startsWith("--env="))).toBe(false);
	});

	it("passes directories and the command as arguments, not as script text", () => {
		const evil = "/tmp/$(touch pwned);x";
		const { args } = buildHostSpawn("latex", ["a b", "; rm -rf /"], "/work", [evil]);
		const scriptIndex = args.indexOf("-c") + 1;
		expect(args[scriptIndex]).toBe('PATH="$1:$PATH"; shift; exec "$@"');
		expect(args.some((arg) => arg.startsWith(`${evil}:`))).toBe(true);
		expect(args.slice(-3)).toEqual(["latex", "a b", "; rm -rf /"]);
	});

	it.skipIf(process.platform === "win32")("the wrapper prepends dirs to the existing PATH and runs the command", () => {
		const { args } = buildHostSpawn("sh", ["-c", "echo $PATH"], "/", ["/first-extra"]);
		// Drop flatpak-spawn's own options and run the wrapper locally.
		const wrapper = args.slice(args.indexOf("--") + 1);
		const out = execFileSync(wrapper[0], wrapper.slice(1), {
			encoding: "utf8",
			env: { PATH: "/usr/bin:/bin" },
		}).trim();
		expect(out.startsWith("/first-extra:")).toBe(true);
		expect(out.endsWith(":/usr/bin:/bin")).toBe(true);
	});
});
