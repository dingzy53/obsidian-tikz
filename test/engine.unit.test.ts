import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { compileTikz } from "../src/compiler";
import { countOutputPages, deriveHint, extractDvisvgmError, unwrapTexLog } from "../src/compiler/engine";

/**
 * Exercises the process plumbing with stand-in executables, so the failure
 * paths (never-throw, timeout, bad exit) are covered on machines — and CI —
 * with no TeX installation.
 */
const posix = process.platform !== "win32";
const dir = mkdtempSync(path.join(tmpdir(), "tikz-fake-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function script(name: string, body: string): string {
	const file = path.join(dir, name);
	writeFileSync(file, `#!/bin/sh\n${body}\n`);
	chmodSync(file, 0o755);
	return file;
}

const okEngine = script("ok-engine", `echo "fake" > diagram.dvi`);
const okDvisvgm = script("ok-dvisvgm", `echo "<svg xmlns='http://www.w3.org/2000/svg'/>" > diagram.svg`);
const base = { source: "\\draw (0,0)--(1,1);", preamble: "", engine: "latex" as const };

describe.skipIf(!posix)("compileTikz process handling", () => {
	it("returns the svg when both stages succeed", async () => {
		const result = await compileTikz({ ...base, enginePath: okEngine, dvisvgmPath: okDvisvgm });
		expect(result.ok).toBe(true);
	});

	it("reports a compile error with the real log", async () => {
		const engine = script("bad-engine", `printf '! Undefined control sequence.\\nl.4 \\\\foo\\n' > diagram.log\nexit 1`);
		const result = await compileTikz({ ...base, enginePath: engine, dvisvgmPath: okDvisvgm });
		expect(result).toMatchObject({ ok: false, kind: "compile-error" });
		if (!result.ok) expect(result.log).toContain("Undefined control sequence");
	});

	it("decodes multi-byte output split across pipe chunks", async () => {
		// 3-byte characters, in far more than one 64 KiB chunk, so boundaries
		// fall inside a character.
		const engine = script("utf8-engine", `yes '€€€€€€€€€€€€€€€€€€€€€€€€€€€€€€' | head -n 20000 >&2\nexit 1`);
		const result = await compileTikz({ ...base, enginePath: engine, dvisvgmPath: okDvisvgm });
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.log).not.toContain("\uFFFD");
			expect(result.log).toContain("€€€");
		}
	});

	it("does not set openin_any for TeX (issue #4)", async () => {
		const saved = process.env.openin_any;
		delete process.env.openin_any;
		try {
			const engine = script("env-engine", `echo "openin_any=[$openin_any]" >&2\nexit 1`);
			const result = await compileTikz({ ...base, enginePath: engine, dvisvgmPath: okDvisvgm });
			expect(result.ok).toBe(false);
			if (!result.ok) expect(result.log).toContain("openin_any=[]");
		} finally {
			if (saved !== undefined) process.env.openin_any = saved;
		}
	});

	it("kills a hung engine and reports a timeout", async () => {
		const engine = script("hung-engine", "sleep 30");
		const started = Date.now();
		const result = await compileTikz({ ...base, enginePath: engine, dvisvgmPath: okDvisvgm, timeoutMs: 300 });
		expect(result).toMatchObject({ ok: false, kind: "timeout" });
		expect(Date.now() - started).toBeLessThan(5000);
	});

	it("reports a missing binary instead of throwing", async () => {
		const result = await compileTikz({ ...base, enginePath: path.join(dir, "nope"), dvisvgmPath: okDvisvgm });
		expect(result).toMatchObject({ ok: false, kind: "binary-not-found" });
	});

	it("turns an unexpected exception into a failure result", async () => {
		// A non-string `source` makes the wrapper throw before any process runs.
		const result = await compileTikz({
			...base,
			source: undefined as unknown as string,
			enginePath: okEngine,
			dvisvgmPath: okDvisvgm,
		});
		expect(result).toMatchObject({ ok: false, kind: "internal" });
	});
});

describe("deriveHint", () => {
	it("explains the luaotfload failure that openin_any=p causes on TeX Live 2025 (issue #4)", () => {
		const log = [
			"luaotfload | load : FATAL ERROR",
			'luaotfload | load :   × Failed to load "luaotfload" module "multiscript".',
			"luaotfload | load :     × \"...luaotfload-multiscript.lua:70: attempt to index a nil value (local 'f')\".",
		].join("\n");
		expect(deriveHint(log, "dvilualatex")).toContain("openin_any");
	});

	it("no longer blames a file-access setting for a missing absolute path", () => {
		const hint = deriveHint("! LaTeX Error: File `/home/u/secret.tex' not found.", "dvilualatex");
		expect(hint).not.toContain("Restrict file access");
		expect(hint).toContain("/home/u/secret.tex");
	});
});

/**
 * Excerpts of real dvilualatex / dvisvgm 3.6 logs (TeX Live 2026), including
 * TeX's hard wrap at 79 columns, from the failures found in a 593-diagram
 * vault audit.
 */
describe("deriveHint: the common authoring mistakes", () => {
	it("explains MathJax's \\lt / \\gt leaking into a tikz block", () => {
		const log = [
			"! Undefined control sequence.",
			"l.15 \\begin{tikzpicture}\\node at (0,0) {$x \\lt",
			"                                               1$};\\end{tikzpicture}",
		].join("\n");
		expect(deriveHint(log, "dvilualatex")).toContain("write `<` and `>`");
	});

	it("does not blame \\lt for an unrelated undefined control sequence", () => {
		const log = ["! Undefined control sequence.", "l.15 \\begin{tikzpicture}\\foo", "  {x}"].join("\n");
		expect(deriveHint(log, "dvilualatex")).toBeUndefined();
	});

	it("points `right=of a` and `below=1cm of a` at the positioning library", () => {
		for (const message of [
			"! Package PGF Math Error: Unknown function `of' (in 'of a').",
			"! Package PGF Math Error: Unknown operator `o' or `of' (in '1cm of a').",
		]) {
			expect(deriveHint(message, "dvilualatex")).toContain("\\usetikzlibrary{positioning}");
		}
	});

	it("names the library for a shape key, even when TeX wrapped the line", () => {
		const log = [
			"! Package pgfkeys Error: I do not know the key '/tikz/diamond' and I am going t",
			"o ignore it. Perhaps you misspelled it.",
		].join("\n");
		expect(deriveHint(log, "dvilualatex")).toContain("\\usetikzlibrary{shapes.geometric}");
		const wrappedKey = [
			"! Package pgfkeys Error: I do not know the key '/tikz/regular polygon sides' an",
			"d I am going to ignore it.",
		].join("\n");
		expect(deriveHint(wrappedKey, "dvilualatex")).toContain("shapes.geometric");
	});

	it("rejoins TeX's 79-column wraps without a space, and only those", () => {
		// TeX breaks at exactly 79 characters, mid-word if need be.
		const head = "! Package pgfkeys Error: I do not know the key '/tikz/on background la";
		const wrapped = `${head.padEnd(79, "y")}\ner' and I am going to ignore it.\nl.15 short line\nnext`;
		const key = head.slice(head.indexOf("'") + 1) + "y".repeat(79 - head.length) + "er";
		expect(unwrapTexLog(wrapped)).toContain(`'${key}'`);
		expect(unwrapTexLog(wrapped)).toContain("l.15 short line\nnext");
		expect(deriveHint(`! Package pgfkeys Error: I do not know the key '/tikz/on backgroun${"\n"}d layer'`, "dvilualatex")).toBeUndefined();
	});

	it("covers the other common library keys", () => {
		const hint = (key: string): string | undefined =>
			deriveHint(`! Package pgfkeys Error: I do not know the key '/tikz/${key}' and I am`, "dvilualatex");
		expect(hint("fit")).toContain("{fit}");
		expect(hint("on background layer")).toContain("{backgrounds}");
		expect(hint("matrix of math nodes")).toContain("{matrix}");
		expect(hint("name path")).toContain("{intersections}");
		expect(hint("pics/angle")).toContain("{angles}");
		expect(hint("rectangle split")).toContain("{shapes.multipart}");
		expect(hint("decoration")).toContain("decorations.markings");
		// A key no library defines gets no (misleading) library hint.
		expect(hint("colour")).toBeUndefined();
	});

	it("points arrows.meta tips at arrows.meta, but not the built-in lower-case ones", () => {
		expect(deriveHint("! Package pgf Error: Unknown arrow tip kind 'Stealth'.", "dvilualatex")).toContain(
			"arrows.meta",
		);
		expect(deriveHint("! Package pgf Error: Unknown arrow tip kind 'Latex'.", "dvilualatex")).toContain(
			"arrows.meta",
		);
		expect(deriveHint("! Package pgf Error: Unknown arrow tip kind 'Foo'.", "dvilualatex")).toBeUndefined();
	});

	it("explains a missing decoration library", () => {
		const log = "! Package tikz Error: You need to load a decoration library.";
		expect(deriveHint(log, "dvilualatex")).toContain("decorations.pathreplacing");
	});

	it("explains dvisvgm's unclosed group, caused by \\color inside font=", () => {
		const log = ["processing page 1", "  XML error: missing closing tag(s): </g>"].join("\n");
		expect(deriveHint(log, "dvilualatex")).toContain("text=<colour>");
	});
});

describe("extractDvisvgmError", () => {
	it("returns dvisvgm's own error line instead of an exit code", () => {
		const output = ["pre-processing DVI file (format version 2)", "processing page 1", "  XML error: missing closing tag(s): </g>"].join("\n");
		expect(extractDvisvgmError(output)).toBe("dvisvgm: XML error: missing closing tag(s): </g>");
		expect(extractDvisvgmError("processing page 1")).toBeNull();
	});
});

describe("countOutputPages", () => {
	it("reads the page count TeX reports for every output format", () => {
		expect(countOutputPages("Output written on diagram.dvi (2 pages, 1880 bytes).")).toBe(2);
		expect(countOutputPages("Output written on diagram.dvi (1 page, 1492 bytes).")).toBe(1);
		expect(countOutputPages("Output written on diagram.xdv (3 pages, 9000 bytes).")).toBe(3);
		expect(countOutputPages("Output written on diagram.pdf (1 page, 12345 bytes).")).toBe(1);
	});

	it("is null when there is no output line", () => {
		expect(countOutputPages("No pages of output.")).toBeNull();
	});
});
