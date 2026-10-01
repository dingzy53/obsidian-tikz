/**
 * M1 acceptance matrix (plan §12/§13), run against a real TeX installation.
 *
 * These are the tests that actually prove the rewrite works: each one targets
 * a documented failure of the upstream WASM engine, plus the silent
 * shape-dropping bug this project was created to fix.
 *
 * Opt in with `npm run m1` (or TIKZ_NATIVE_INTEGRATION=1 vitest run). Skipped
 * by default so `npm test` stays green on machines without TeX installed.
 */

import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { compileTikz, type CompileOptions, type CompileResult } from "../src/compiler/engine";
import { DEFAULT_PREAMBLE } from "../src/compiler/wrapSource";

const RUN = process.env.TIKZ_NATIVE_INTEGRATION === "1";
const TEST_TIMEOUT = 90_000;

/** Wraps a bare TikZ body the way a note would contain it (tier 3). */
function block(body: string): string {
	return body;
}

async function compile(
	source: string,
	overrides: Partial<CompileOptions> = {},
): Promise<CompileResult> {
	return compileTikz({
		source,
		preamble: DEFAULT_PREAMBLE,
		engine: "dvilualatex",
		timeoutMs: 30_000,
		...overrides,
	});
}

/** Number of drawn shapes. Glyph outlines live in `<defs>` and are referenced
 * by `<use>`, so a text-free snippet with zero paths means the drawing was
 * dropped. */
function pathCount(svg: string): number {
	return (svg.match(/<path\b/g) ?? []).length;
}

function expectRendered(result: CompileResult): string {
	if (!result.ok) {
		throw new Error(`expected a successful compile, got ${result.kind}: ${result.summary}`);
	}
	expect(result.svg).toContain("<svg");
	return result.svg;
}

describe.skipIf(!RUN)("M1 acceptance matrix (real TeX)", () => {
	it("renders `opacity` — an upstream infinite-hang case", async () => {
		const svg = expectRendered(
			await compile(block(`\\begin{tikzpicture}
\\fill[red,opacity=0.3] (0,0) rectangle (2,1);
\\draw[blue,opacity=0.5,ultra thick] (0,1) -- (2,0);
\\end{tikzpicture}`)),
		);
		expect(pathCount(svg)).toBeGreaterThan(0);
		// Transparency must survive as real SVG opacity, not be flattened.
		expect(svg).toMatch(/opacity='0?\.3'/);
	}, TEST_TIMEOUT);

	it("renders `decorations.pathreplacing` — an upstream infinite-hang case", async () => {
		const svg = expectRendered(
			await compile(block(`\\usetikzlibrary{decorations.pathreplacing}
\\begin{tikzpicture}
\\draw (0,0) -- (3,0);
\\draw[decorate,decoration={brace,amplitude=6pt}] (0,0) -- (3,0) node[midway,above=6pt]{label};
\\end{tikzpicture}`)),
		);
		expect(pathCount(svg)).toBeGreaterThan(0);
	}, TEST_TIMEOUT);

	it("renders `arrows.meta` — an upstream infinite-hang case", async () => {
		const svg = expectRendered(
			await compile(block(`\\usetikzlibrary{arrows.meta}
\\begin{tikzpicture}
\\draw[-{Stealth[length=4mm]},thick] (0,0) -- (2,0);
\\draw[-{Latex[width=3mm]}] (0,1) -- (2,1);
\\end{tikzpicture}`)),
		);
		expect(pathCount(svg)).toBeGreaterThan(0);
	}, TEST_TIMEOUT);

	it("renders circuitikz, the documented worst case for the PDF route", async () => {
		const svg = expectRendered(
			await compile(block(`\\begin{circuitikz}
\\draw (0,0) to[R=$R_1$] (2,0) to[C=$C$] (4,0);
\\end{circuitikz}`)),
		);
		expect(pathCount(svg)).toBeGreaterThan(0);
	}, TEST_TIMEOUT);

	it("loads a package absent from the upstream hardcoded bundle (forest)", async () => {
		const svg = expectRendered(
			await compile(block(`\\usepackage{forest}
\\begin{forest}
[VP [NP [Det][N]] [V][NP]]
\\end{forest}`)),
		);
		expect(pathCount(svg)).toBeGreaterThan(0);
	}, TEST_TIMEOUT);

	it("loads a second external package (tkz-euclide)", async () => {
		const svg = expectRendered(
			await compile(block(`\\usepackage{tkz-euclide}
\\begin{tikzpicture}
\\tkzDefPoint(0,0){A}\\tkzDefPoint(3,0){B}\\tkzDefPoint(1,2){C}
\\tkzDrawPolygon(A,B,C)
\\end{tikzpicture}`)),
		);
		expect(pathCount(svg)).toBeGreaterThan(0);
	}, TEST_TIMEOUT);

	it("renders a pgfplots 3D surface within the default timeout", async () => {
		const started = Date.now();
		const svg = expectRendered(
			await compile(block(`\\begin{tikzpicture}
\\begin{axis}[view={60}{30},colormap/viridis]
\\addplot3[surf,shader=flat,samples=25,domain=-2:2]{exp(-x^2-y^2)};
\\end{axis}
\\end{tikzpicture}`)),
		);
		expect(pathCount(svg)).toBeGreaterThan(50);
		const seconds = (Date.now() - started) / 1000;
		console.log(`[M1] pgfplots 3D surface: ${seconds.toFixed(2)}s, ${svg.length} bytes`);
		// Evidence for plan §14 open question #4: is a 20s default generous?
		expect(seconds).toBeLessThan(20);
	}, TEST_TIMEOUT);

	it("keeps the drawing when the block brings its own documentclass (tier 1)", async () => {
		const svg = expectRendered(
			await compile(`\\documentclass{standalone}
\\usepackage{tikz}
\\begin{document}
\\begin{tikzpicture}\\draw (0,0) circle (1);\\end{tikzpicture}
\\end{document}`),
		);
		expect(pathCount(svg)).toBeGreaterThan(0);
	}, TEST_TIMEOUT);

	it("keeps the drawing for an upstream-style block (tier 2)", async () => {
		const svg = expectRendered(
			await compile(block(`\\begin{document}
\\begin{tikzpicture}\\draw (0,0) circle (1);\\end{tikzpicture}
\\end{document}`)),
		);
		expect(pathCount(svg)).toBeGreaterThan(0);
	}, TEST_TIMEOUT);

	/**
	 * The bug this whole project exists to fix: without the pgf driver line,
	 * pgf emits dvips PostScript specials, dvisvgm silently drops every drawn
	 * shape, and the compile still reports success. This is the negative
	 * control that proves the assertion above is meaningful.
	 */
	it("negative control: the dvips driver silently drops shapes, so the driver line matters", async () => {
		const result = await compile(`\\documentclass{standalone}
\\def\\pgfsysdriver{pgfsys-dvips.def}
\\usepackage{tikz}
\\begin{document}
\\begin{tikzpicture}\\draw (0,0) circle (1);\\end{tikzpicture}
\\end{document}`);
		const rendered = result.ok && pathCount(result.svg) > 0;
		expect(rendered).toBe(false);
	}, TEST_TIMEOUT);

	it("shows the real LaTeX error for a broken block, instead of hanging", async () => {
		const result = await compile(block(`\\begin{tikzpicture}
\\draw (0,0) -- (1,1);
\\thiscommanddoesnotexist
\\end{tikzpicture}`));
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.kind).toBe("compile-error");
		expect(result.summary).toContain("Undefined control sequence");
		expect(result.log).toContain("!");
	}, TEST_TIMEOUT);

	it("reports a missing package with an actionable hint", async () => {
		const result = await compile(block(`\\usepackage{thispackagedoesnotexist}
\\begin{tikzpicture}\\draw (0,0)--(1,1);\\end{tikzpicture}`));
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.hint).toContain("thispackagedoesnotexist");
	}, TEST_TIMEOUT);

	it("times out and kills the process instead of hanging", async () => {
		const started = Date.now();
		const result = await compile(block(`\\begin{tikzpicture}
\\foreach \\i in {1,...,10000}{\\draw (0,0) circle (1);}
\\end{tikzpicture}`), { timeoutMs: 250 });
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.kind).toBe("timeout");
		expect(result.hint).toContain("timeout");
		// The whole point: it must come back promptly, not hang.
		expect(Date.now() - started).toBeLessThan(15_000);
	}, TEST_TIMEOUT);

	it("reports a missing binary with an actionable hint", async () => {
		const result = await compile(block(`\\begin{tikzpicture}\\draw (0,0)--(1,1);\\end{tikzpicture}`), {
			enginePath: "/nonexistent/dvilualatex",
		});
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.kind).toBe("binary-not-found");
		expect(result.hint).toContain("settings");
	}, TEST_TIMEOUT);

	it("blocks \\write18 while shell escape is off (the default)", async () => {
		const canary = path.join(os.tmpdir(), `tikz-canary-${randomUUID()}`);
		const result = await compile(block(`\\begin{tikzpicture}
\\draw (0,0) -- (1,1);
\\immediate\\write18{touch ${canary}}
\\end{tikzpicture}`), { allowShellEscape: false });
		expect(fs.existsSync(canary)).toBe(false);
		expect(result.ok).toBe(true);
	}, TEST_TIMEOUT);

	/**
	 * Positive control for the test above: it proves the canary would have been
	 * created had the opt-in been on, so "file absent" really does mean
	 * "blocked" rather than "test written wrong".
	 */
	it("positive control: shell escape runs the command once opted in", async () => {
		const canary = path.join(os.tmpdir(), `tikz-canary-${randomUUID()}`);
		await compile(block(`\\begin{tikzpicture}
\\draw (0,0) -- (1,1);
\\immediate\\write18{touch ${canary}}
\\end{tikzpicture}`), { allowShellEscape: true });
		const created = fs.existsSync(canary);
		if (created) fs.rmSync(canary, { force: true });
		expect(created).toBe(true);
	}, TEST_TIMEOUT);
});

describe.skipIf(!RUN)("engine matrix", () => {
	it("LuaLaTeX (the default) renders shapes", async () => {
		const svg = expectRendered(
			await compile(block(`\\begin{tikzpicture}\\draw (0,0) circle (1);\\end{tikzpicture}`), {
				engine: "dvilualatex",
			}),
		);
		expect(pathCount(svg)).toBeGreaterThan(0);
	}, TEST_TIMEOUT);

	it("LaTeX renders the same shapes", async () => {
		const svg = expectRendered(
			await compile(block(`\\begin{tikzpicture}\\draw (0,0) circle (1);\\end{tikzpicture}`), {
				engine: "latex",
			}),
		);
		expect(pathCount(svg)).toBeGreaterThan(0);
	}, TEST_TIMEOUT);

	it("accepts package options for a package the default preamble also loads", async () => {
		// The default preamble loads circuitikz without options. Loading it
		// again *with* options afterwards is an "Option clash"; the block's own
		// packages therefore have to come first.
		const svg = expectRendered(
			await compile(
				block(`\\usepackage[american]{circuitikz}
\\begin{circuitikz}
\\draw (0,0) to[R] (2,0);
\\end{circuitikz}`),
			),
		);
		expect(pathCount(svg)).toBeGreaterThan(0);
	}, TEST_TIMEOUT);

	it("treats a commented-out \\documentclass as a comment", async () => {
		const svg = expectRendered(
			await compile(
				block(`% \\documentclass{article}
\\begin{tikzpicture}\\draw (0,0) -- (1,1);\\end{tikzpicture}`),
			),
		);
		expect(pathCount(svg)).toBeGreaterThan(0);
	}, TEST_TIMEOUT);

	it("LuaLaTeX supports system fonts via fontspec, which plain LaTeX cannot", async () => {
		// `\usepackage` in a bare block is hoisted into the preamble, so this
		// also exercises that path end to end.
		const body = `\\usepackage{fontspec}
\\begin{tikzpicture}\\node[font=\\fontspec{Helvetica}]{System font};\\end{tikzpicture}`;

		const lua = await compile(body, { engine: "dvilualatex" });
		expect(lua.ok).toBe(true);

		const latex = await compile(body, { engine: "latex" });
		expect(latex.ok).toBe(false);
		if (!latex.ok) expect(latex.hint).toContain("LuaLaTeX");
	}, TEST_TIMEOUT);

	/**
	 * The PDF route is documented as an opt-in fallback (plan §6.2): on
	 * Ghostscript >= 9.52 `dvisvgm --pdf` can drop vector objects, and some
	 * dvisvgm builds have no working PDF backend at all. Either outcome is
	 * acceptable; a hang or a bare crash is not.
	 */
	it("pdfLaTeX either renders or fails with an actionable message", async () => {
		const result = await compile(block(`\\begin{tikzpicture}\\draw (0,0) circle (1);\\end{tikzpicture}`), {
			engine: "pdflatex",
		});
		if (result.ok) {
			expect(result.svg).toContain("<svg");
			return;
		}
		expect(result.summary.length).toBeGreaterThan(0);
		expect(result.log.length).toBeGreaterThan(0);
		console.log(`[M1] pdflatex route: ${result.kind} — ${result.summary}`);
	}, TEST_TIMEOUT);
});
