import { describe, expect, it } from "vitest";
import {
	DEFAULT_PREAMBLE,
	DEFAULT_TIKZ_LIBRARIES,
	ON_DEMAND_PACKAGES,
	PGF_DRIVER_LINE,
	detectTier,
	normalizePreamble,
	tidyTikzSource,
	wrapTikzSource,
} from "../src/compiler/wrapSource";

describe("tidyTikzSource", () => {
	it("strips non-breaking spaces that Obsidian inserts on paste", () => {
		expect(tidyTikzSource("\u00a0\\draw (0,0);&nbsp;")).toBe("\\draw (0,0);");
	});

	it("trims each line and drops blank ones", () => {
		expect(tidyTikzSource("  \\draw (0,0);  \n\n\t\\draw (1,1);\n")).toBe(
			"\\draw (0,0);\n\\draw (1,1);",
		);
	});
});

describe("detectTier", () => {
	it("tier 1: the block brings its own document class", () => {
		expect(detectTier("\\documentclass{article}\n\\begin{document}x\\end{document}")).toBe(1);
	});

	it("tier 2: begin{document} without a document class (upstream TikZJax input)", () => {
		expect(detectTier("\\begin{document}\n\\begin{tikzpicture}\\end{tikzpicture}\n\\end{document}")).toBe(2);
	});

	it("ignores a commented-out \\documentclass or \\begin{document}", () => {
		expect(detectTier("% \\documentclass{article}\n\\draw (0,0)--(1,1);")).toBe(3);
		expect(detectTier("\\draw (0,0)--(1,1); % \\begin{document}")).toBe(3);
		expect(detectTier("% \\documentclass{article}\n\\begin{document}\\end{document}")).toBe(2);
	});

	it("still treats an escaped percent as ordinary text", () => {
		expect(detectTier("\\node{50\\%}; \\documentclass{x}")).toBe(1);
	});

	it("tier 3: bare TikZ", () => {
		expect(detectTier("\\begin{tikzpicture}\\draw (0,0)--(1,1);\\end{tikzpicture}")).toBe(3);
	});

	it("tolerates spaces inside begin{document}", () => {
		expect(detectTier("\\begin { document }")).toBe(2);
	});
});

describe("wrapTikzSource", () => {
	const base = { preamble: DEFAULT_PREAMBLE, injectDvisvgmDriver: true };

	it("leaves a tier-1 document alone apart from the pgf driver line", () => {
		const source = "\\documentclass{article}\n\\begin{document}hi\\end{document}";
		const { tex, tier } = wrapTikzSource({ ...base, source });
		expect(tier).toBe(1);
		expect(tex.startsWith(PGF_DRIVER_LINE)).toBe(true);
		expect(tex).toContain(source);
	});

	it("reproduces the upstream plugin's document shape for tier 2", () => {
		const source = "\\begin{document}\n\\begin{tikzpicture}\\end{tikzpicture}\n\\end{document}";
		const { tex, tier } = wrapTikzSource({ ...base, source });
		expect(tier).toBe(2);
		const lines = tex.split("\n");
		// The class comes first, then the driver line as the first preamble
		// entry — it must precede `\usepackage{tikz}` so pgf picks the
		// dvisvgm backend when it loads.
		expect(lines[0]).toBe("\\documentclass{standalone}");
		expect(lines[1]).toBe(PGF_DRIVER_LINE);
		expect(lines[2]).toBe("\\usepackage{tikz}");
		expect(tex.indexOf(PGF_DRIVER_LINE)).toBeLessThan(tex.indexOf("\\usepackage{tikz}"));
		expect(tex.endsWith(source)).toBe(true);
	});

	it("fully wraps a bare tier-3 block", () => {
		const { tex, tier } = wrapTikzSource({ ...base, source: "\\draw (0,0)--(1,1);" });
		expect(tier).toBe(3);
		expect(tex).toContain("\\begin{document}\n\\draw (0,0)--(1,1);\n\\end{document}");
		expect(tex.indexOf("\\usepackage{tikz}")).toBeLessThan(tex.indexOf("\\begin{document}"));
	});

	it("hoists \\usepackage out of a tier-3 body", () => {
		const { tex, hoisted } = wrapTikzSource({
			...base,
			source: "\\usepackage{tkz-euclide}\n\\begin{tikzpicture}\\end{tikzpicture}",
		});
		expect(hoisted).toEqual(["\\usepackage{tkz-euclide}"]);
		expect(tex.indexOf("\\usepackage{tkz-euclide}")).toBeLessThan(tex.indexOf("\\begin{document}"));
	});

	it("hoists \\usetikzlibrary out of a tier-3 body", () => {
		const { tex } = wrapTikzSource({
			...base,
			source: "\\usetikzlibrary{arrows.meta}\n\\begin{tikzpicture}\\end{tikzpicture}",
		});
		expect(tex.indexOf("\\usetikzlibrary{arrows.meta}")).toBeLessThan(tex.indexOf("\\begin{document}"));
	});

	it("hoists a \\usetikzlibrary written over several lines as a whole", () => {
		// Hoisting only the first line used to leave `positioning}` in the
		// document body: "! Missing \\endcsname inserted".
		const source = "\\usetikzlibrary{arrows.meta,\npositioning}\n\\begin{tikzpicture}\\end{tikzpicture}";
		const { tex, hoisted } = wrapTikzSource({ ...base, source });
		expect(hoisted).toEqual(["\\usetikzlibrary{arrows.meta,\npositioning}"]);
		const body = tex.slice(tex.indexOf("\\begin{document}"));
		expect(body).not.toContain("positioning");
		expect(tex.indexOf("\\usepackage{tikz}")).toBeLessThan(tex.indexOf("\\usetikzlibrary{arrows.meta,"));
	});

	it("keeps package options written over several lines together", () => {
		const source = "\\usepackage[\nmode=x,\n% a comment with a { brace\nother]{pkg}\n\\draw (0,0);";
		const { tex, hoisted } = wrapTikzSource({ ...base, source });
		expect(hoisted).toEqual(["\\usepackage[\nmode=x,\n% a comment with a { brace\nother]{pkg}"]);
		expect(tex.indexOf("other]{pkg}")).toBeLessThan(tex.indexOf("\\usepackage{tikz}"));
	});

	it("leaves a preamble line whose braces never close as it was", () => {
		const source = "\\usetikzlibrary{calc\n\\draw (0,0);";
		const { hoisted, tex } = wrapTikzSource({ ...base, source });
		expect(hoisted).toEqual(["\\usetikzlibrary{calc"]);
		expect(tex.slice(tex.indexOf("\\begin{document}"))).toContain("\\draw (0,0);");
	});

	it("hoists \\DeclareMathOperator out of a tier-3 body, after amsmath", () => {
		// In the body it fails with "Can be used only in preamble".
		const source = "\\DeclareMathOperator{\\tr}{tr}\n\\node {$\\tr A$};";
		const { tex, hoisted } = wrapTikzSource({ ...base, source });
		expect(hoisted).toEqual(["\\DeclareMathOperator{\\tr}{tr}"]);
		expect(tex.indexOf("\\usepackage{amsmath}")).toBeLessThan(tex.indexOf("\\DeclareMathOperator"));
		expect(tex.indexOf("\\DeclareMathOperator")).toBeLessThan(tex.indexOf("\\begin{document}"));
	});

	it("tier 2: leaves \\DeclareMathOperator where the block's preamble put it", () => {
		const source = "\\newcommand{\\R}{\\mathbb{R}}\n\\DeclareMathOperator{\\tr}{tr}\n\\begin{document}\nx\n\\end{document}";
		const { tex } = wrapTikzSource({ ...base, source });
		expect(tex.indexOf("\\newcommand{\\R}")).toBeLessThan(tex.indexOf("\\DeclareMathOperator"));
	});

	it("loads the block's own packages before the default preamble (no xcolor option clash)", () => {
		const source = "\\usepackage[dvipsnames]{xcolor}\n\\begin{tikzpicture}\\end{tikzpicture}";
		const { tex } = wrapTikzSource({ ...base, source });
		expect(tex.indexOf("[dvipsnames]{xcolor}")).toBeLessThan(tex.indexOf("\\usepackage{tikz}"));
		// ...but still after the driver line, which must precede any pgf load.
		expect(tex.indexOf(PGF_DRIVER_LINE)).toBeLessThan(tex.indexOf("[dvipsnames]{xcolor}"));
	});

	it("keeps \\usetikzlibrary after tikz is loaded", () => {
		const source = "\\usetikzlibrary{arrows.meta}\n\\begin{tikzpicture}\\end{tikzpicture}";
		const { tex } = wrapTikzSource({ ...base, source });
		expect(tex.indexOf("\\usepackage{tikz}")).toBeLessThan(tex.indexOf("\\usetikzlibrary{arrows.meta}"));
	});

	it("tier 2: reorders the block's own preamble lines, leaving the body alone", () => {
		const source =
			"\\usepackage[dvipsnames]{xcolor}\n\\usetikzlibrary{calc}\n\\begin{document}\n\\usepackage{inbody}\n\\end{document}";
		const { tex, tier } = wrapTikzSource({ ...base, source });
		expect(tier).toBe(2);
		const at = (needle: string): number => tex.indexOf(needle);
		expect(at("[dvipsnames]{xcolor}")).toBeLessThan(at("\\usepackage{tikz}"));
		expect(at("\\usepackage{tikz}")).toBeLessThan(at("\\usetikzlibrary{calc}"));
		expect(at("\\usetikzlibrary{calc}")).toBeLessThan(at("\\begin{document}"));
		// Lines after \begin{document} are the body and must not be moved.
		expect(at("\\begin{document}")).toBeLessThan(at("\\usepackage{inbody}"));
	});

	it("omits the pgf driver line for pdflatex, which writes PDF operators directly", () => {
		const { tex } = wrapTikzSource({
			source: "\\draw (0,0)--(1,1);",
			preamble: DEFAULT_PREAMBLE,
			injectDvisvgmDriver: false,
		});
		expect(tex).not.toContain(PGF_DRIVER_LINE);
	});

	it("uses the user's edited preamble", () => {
		const { tex } = wrapTikzSource({
			source: "\\draw (0,0)--(1,1);",
			preamble: "\\usepackage{mypkg}",
			injectDvisvgmDriver: true,
		});
		expect(tex).toContain("\\usepackage{mypkg}");
		expect(tex).not.toContain("\\usepackage{circuitikz}");
	});

	it("keeps comments in the preamble (only the block source is tidied)", () => {
		const { tex } = wrapTikzSource({
			source: "\\draw (0,0)--(1,1);",
			preamble: "\\usepackage{tikz}\n% keep me",
			injectDvisvgmDriver: true,
		});
		expect(tex).toContain("% keep me");
	});
});

describe("normalizePreamble", () => {
	it("normalises line endings and trailing whitespace", () => {
		expect(normalizePreamble("\\usepackage{tikz}  \r\n\r\n\\usepackage{array}")).toBe(
			"\\usepackage{tikz}\n\n\\usepackage{array}",
		);
	});

	it("trims the whole block", () => {
		expect(normalizePreamble("\n\n\\usepackage{tikz}\n\n")).toBe("\\usepackage{tikz}");
	});
});

describe("DEFAULT_PREAMBLE", () => {
	it("leaves the heavy packages to on-demand loading", () => {
		for (const pkg of ["pgfplots", "tikz-cd", "circuitikz", "chemfig", "tikz-3dplot"]) {
			expect(DEFAULT_PREAMBLE).not.toContain(`{${pkg}}`);
		}
	});

	it("loads the everyday libraries, and the ones the heavy packages used to bring along", () => {
		// Missing positioning/shapes.geometric were 21 of 31 audit failures; the
		// second group came implicitly with tikz-cd, circuitikz and pgfplots.
		for (const library of ["shapes.geometric", "arrows.meta", "calc", "fit", "backgrounds",
			"matrix", "arrows", "plotmarks", "decorations.pathmorphing", "3d", "quotes", "bending"]) {
			expect(DEFAULT_TIKZ_LIBRARIES).toContain(library);
		}
		expect(DEFAULT_PREAMBLE).toContain(`\\usetikzlibrary{${DEFAULT_TIKZ_LIBRARIES.join(", ")}}`);
		expect(DEFAULT_PREAMBLE).toContain("\\usepackage{ifthen}");
	});

	it("does not load positioning, which changes what `above right=4pt` means", () => {
		// It moved labels in 65 of 593 real diagrams that never asked for it.
		expect(DEFAULT_TIKZ_LIBRARIES).not.toContain("positioning");
	});

	it("still sets the pgfplots compatibility level when pgfplots is loaded", () => {
		const pgfplots = ON_DEMAND_PACKAGES.find((pkg) => pkg.name === "pgfplots");
		expect(pgfplots?.lines).toEqual(["\\usepackage{pgfplots}", "\\pgfplotsset{compat=1.18}"]);
	});
});

describe("on-demand packages", () => {
	const wrap = (source: string, packages: "on-demand" | "all" | "none" = "on-demand", preamble = DEFAULT_PREAMBLE) =>
		wrapTikzSource({ source, preamble, injectDvisvgmDriver: true, packages });

	it("loads pgfplots for an axis, and nothing else", () => {
		const result = wrap("\\begin{tikzpicture}\\begin{axis}\\addplot {x};\\end{axis}\\end{tikzpicture}");
		expect(result.loaded).toEqual(["pgfplots"]);
		expect(result.skipped).toEqual(["tikz-cd", "circuitikz", "chemfig", "tikz-3dplot"]);
		expect(result.tex).toContain("\\usepackage{pgfplots}\n\\pgfplotsset{compat=1.18}");
		expect(result.tex).not.toContain("{tikz-cd}");
	});

	it("recognises each package by what a block writes", () => {
		const loaded = (source: string): string[] => wrap(source).loaded;
		expect(loaded("\\begin{tikzcd} A \\arrow[r] & B \\end{tikzcd}")).toEqual(["tikz-cd"]);
		expect(loaded("\\begin{circuitikz}\\draw (0,0) to[R] (2,0);\\end{circuitikz}")).toEqual(["circuitikz"]);
		expect(loaded("\\begin{tikzpicture}\\draw (0,0) to[R=$R_1$] (2,0);\\end{tikzpicture}")).toEqual(["circuitikz"]);
		expect(loaded("\\chemfig{H-C(-[2]H)(-[6]H)-H}")).toEqual(["chemfig"]);
		expect(loaded("\\tdplotsetmaincoords{60}{110}\n\\begin{tikzpicture}[tdplot_main_coords]\\end{tikzpicture}")).toEqual(["tikz-3dplot"]);
		expect(loaded("\\begin{tikzpicture}\\draw (0,0) -- (1,1);\\end{tikzpicture}")).toEqual([]);
	});

	it("does not mistake TikZ's own syntax for a heavy package", () => {
		// `\\arrow` is also decorations.markings; `to[out=…]` is plain TikZ.
		expect(wrap("\\draw[decoration={markings, mark=at position .5 with {\\arrow{>}}}, postaction={decorate}] (0,0) -- (1,0);").loaded).toEqual([]);
		expect(wrap("\\draw (0,0) to[out=30, in=150] (2,0);").loaded).toEqual([]);
		// Commented-out use does not count.
		expect(wrap("% \\begin{axis}\n\\draw (0,0);").loaded).toEqual([]);
	});

	it("skips packages the preamble or the block already load (their options win)", () => {
		const own = wrap("\\usepackage[siunitx]{circuitikz}\n\\begin{circuitikz}\\end{circuitikz}");
		expect(own.loaded).toEqual([]);
		expect(own.tex.match(/\\usepackage(\[[^\]]*\])?\{circuitikz\}/g)).toHaveLength(1);
		const custom = wrap("\\begin{axis}\\end{axis}", "on-demand", "\\usepackage{tikz}\n\\usepackage{pgfplots}");
		expect(custom.loaded).toEqual([]);
		expect(custom.skipped).not.toContain("pgfplots");
	});

	it("\"all\" loads every package, as the 1.0–1.2 preamble did", () => {
		const result = wrap("\\draw (0,0);", "all");
		expect(result.loaded).toEqual(["tikz-cd", "circuitikz", "pgfplots", "chemfig", "tikz-3dplot"]);
		expect(result.skipped).toEqual([]);
	});

	it("places them after the preamble and before the block's libraries", () => {
		const { tex } = wrap("\\usepgfplotslibrary{fillbetween}\n\\begin{axis}\\end{axis}");
		expect(tex.indexOf("\\usepackage{amsmath}")).toBeLessThan(tex.indexOf("\\usepackage{pgfplots}"));
		expect(tex.indexOf("\\usepackage{pgfplots}")).toBeLessThan(tex.indexOf("\\usepgfplotslibrary{fillbetween}"));
	});

	it("leaves tier 1 documents alone, and defaults to loading nothing extra", () => {
		expect(wrap("\\documentclass{article}\\begin{document}\\begin{axis}\\end{axis}\\end{document}").loaded).toEqual([]);
		const plain = wrapTikzSource({ source: "\\begin{axis}\\end{axis}", preamble: DEFAULT_PREAMBLE, injectDvisvgmDriver: true });
		expect(plain.loaded).toEqual([]);
		expect(plain.skipped).toEqual([]);
	});
});
