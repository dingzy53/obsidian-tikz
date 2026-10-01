/**
 * Source tidying and `\documentclass` / `\begin{document}` detection.
 *
 * Pure Node module: deliberately free of any `import "obsidian"` so it can be
 * unit tested without the Obsidian `Plugin` lifecycle (AGENTS.md).
 */

/**
 * pgf only emits SVG-friendly specials when it is told which backend it is
 * targeting. Without this, a `latex`/`dvilualatex`/`xelatex` run uses the
 * default dvips driver, whose PostScript specials dvisvgm cannot turn into
 * vector paths: **every drawn shape silently disappears from the SVG while
 * text survives**, which looks like a half-rendered diagram with no error.
 * Verified against TeX Live 2026 + dvisvgm 3.6 (see README "Verified facts").
 *
 * Must be issued before pgf/tikz is loaded. Not used for `pdflatex`, which
 * writes native PDF drawing operators instead.
 */
export const PGF_DRIVER_LINE = "\\def\\pgfsysdriver{pgfsys-dvisvgm.def}";

/** `\documentclass{standalone}` — what the upstream TikZJax plugin used. */
export const STANDALONE_CLASS = "\\documentclass{standalone}";

/**
 * Convenience packages seeded into the default preamble. This is a *default*,
 * not a restriction: any package installed in the user's TeX distribution can
 * be loaded with an in-block `\usepackage{...}`. The list mirrors what the
 * upstream TikZJax plugin hardcoded, so existing notes keep working.
 */
export const DEFAULT_PREAMBLE = [
	"\\usepackage{tikz}",
	"\\usepackage{tikz-cd}",
	"\\usepackage{circuitikz}",
	"\\usepackage{pgfplots}",
	"\\usepackage{chemfig}",
	"\\usepackage{amsmath}",
	"\\usepackage{amssymb}",
	"\\usepackage{amsfonts}",
	"\\usepackage{tikz-3dplot}",
	"\\usepackage{array}",
].join("\n");

export type SourceTier = 1 | 2 | 3;

export interface WrapOptions {
	/** Raw code-block content. */
	source: string;
	/** Resolved default preamble (settings value). */
	preamble: string;
	/** Emit {@link PGF_DRIVER_LINE} ahead of pgf/tikz. False for `pdflatex`. */
	injectDvisvgmDriver: boolean;
}

export interface WrappedSource {
	/** The complete document handed to the TeX engine. */
	tex: string;
	/** Which of the three compatibility tiers was detected. */
	tier: SourceTier;
	/** The tidied block source (cache-key material). */
	tidiedSource: string;
	/** Packages hoisted out of a tier-3 block into the preamble. */
	hoisted: string[];
}

/**
 * Ported unchanged from `artisticat1/obsidian-tikzjax`.
 *
 * Obsidian's editor inserts non-breaking spaces when pasting, which TeX
 * rejects, and leading whitespace inserted by the code-block indentation
 * confuses TikZ's parser.
 */
export function tidyTikzSource(tikzSource: string): string {
	const remove = "&nbsp;";
	tikzSource = tikzSource.replaceAll(remove, "");

	let lines = tikzSource.split("\n");

	// Trim whitespace that is inserted when pasting in code, otherwise TikZ complains
	lines = lines.map((line) => line.trim());

	// Remove empty lines
	lines = lines.filter((line) => line);

	return lines.join("\n");
}

/**
 * Normalises the preamble: the user is expected to hand-edit this in settings,
 * so keep comments and blank lines but normalise line endings and surrounding
 * whitespace. Blank lines are *not* stripped here (unlike the block source),
 * because a preamble is ordinary LaTeX where they are harmless.
 */
export function normalizePreamble(preamble: string): string {
	return preamble
		.replaceAll("\r\n", "\n")
		.replaceAll("\r", "\n")
		.split("\n")
		.map((line) => line.replace(/[ \t]+$/, ""))
		.join("\n")
		.trim();
}

/**
 * Three-tier detection, for backward compatibility with every note written
 * against the upstream TikZJax plugin (plan §6.1).
 *
 * 1. Block carries its own `\documentclass` → use verbatim (only the driver
 *    line is prepended, which must precede pgf).
 * 2. Block has `\begin{document}` but no `\documentclass` → prepend
 *    `\documentclass{standalone}` + preamble. **This is exactly the input
 *    shape the upstream plugin expected.**
 * 3. Bare TikZ/LaTeX → wrap fully.
 */
export function detectTier(tidiedSource: string): SourceTier {
	if (/\\documentclass\b/.test(tidiedSource)) return 1;
	if (/\\begin\s*\{\s*document\s*\}/.test(tidiedSource)) return 2;
	return 3;
}

/**
 * In tier 3 the block has no `\begin{document}`, so anything the user writes
 * is placed *inside* the document body. `\usepackage` is preamble-only and
 * would abort the compile with a confusing "Can be used only in preamble"
 * error, so hoist those lines into the preamble where the user clearly meant
 * them to be. `\usetikzlibrary` is legal in the body but hoisting it too keeps
 * the generated document readable.
 */
function hoistPreambleOnlyLines(lines: string[]): { hoisted: string[]; body: string[] } {
	const hoisted: string[] = [];
	const body: string[] = [];
	for (const line of lines) {
		if (/^\\(usepackage|RequirePackage|usetikzlibrary|usepgfplotslibrary)\b/.test(line)) {
			hoisted.push(line);
		} else {
			body.push(line);
		}
	}
	return { hoisted, body };
}

export function wrapTikzSource(options: WrapOptions): WrappedSource {
	const tidiedSource = tidyTikzSource(options.source);
	const preamble = normalizePreamble(options.preamble);
	const tier = detectTier(tidiedSource);

	const driverLine = options.injectDvisvgmDriver ? PGF_DRIVER_LINE : "";

	if (tier === 1) {
		// The block owns its document. Material before `\documentclass` is
		// legal LaTeX and is the only way to get the driver in ahead of the
		// user's own `\usepackage{tikz}`.
		const tex = driverLine ? `${driverLine}\n${tidiedSource}` : tidiedSource;
		return { tex, tier, tidiedSource, hoisted: [] };
	}

	const preambleParts = [driverLine, preamble].filter((part) => part.length > 0);

	if (tier === 2) {
		const tex = [STANDALONE_CLASS, ...preambleParts, tidiedSource]
			.filter((part) => part.length > 0)
			.join("\n");
		return { tex, tier, tidiedSource, hoisted: [] };
	}

	const { hoisted, body } = hoistPreambleOnlyLines(tidiedSource.split("\n"));
	const tex = [
		STANDALONE_CLASS,
		...preambleParts,
		...hoisted,
		"\\begin{document}",
		body.join("\n"),
		"\\end{document}",
	].join("\n");

	return { tex, tier, tidiedSource, hoisted };
}
