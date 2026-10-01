import { describe, expect, it } from "vitest";
import {
	DEFAULT_PREAMBLE,
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
