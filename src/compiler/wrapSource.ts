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

const PACKAGE_LOADERS = /^\\(usepackage|RequirePackage)\b/;
const PREAMBLE_ONLY = /^\\(usepackage|RequirePackage|usetikzlibrary|usepgfplotslibrary)\b/;

/**
 * Splits the block's own preamble-level lines into those that must come
 * *before* the default preamble and those that must come after it.
 *
 * The order matters. `\usepackage[dvipsnames]{xcolor}` has to be seen before
 * the default `\usepackage{tikz}` (which loads xcolor without options), or
 * LaTeX aborts with "Option clash for package xcolor" — and dvipsnames is
 * extremely common in TikZ snippets. Conversely `\usetikzlibrary` and
 * `\usepgfplotslibrary` need tikz/pgfplots to be loaded already, so they have
 * to follow the default preamble.
 */
function splitPreambleLines(lines: string[]): { early: string[]; late: string[]; rest: string[] } {
	const early: string[] = [];
	const late: string[] = [];
	const rest: string[] = [];
	for (const line of lines) {
		if (PACKAGE_LOADERS.test(line)) early.push(line);
		else if (PREAMBLE_ONLY.test(line)) late.push(line);
		else rest.push(line);
	}
	return { early, late, rest };
}

const BEGIN_DOCUMENT = /\\begin\s*\{\s*document\s*\}/;

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

	const withContent = (parts: string[]): string => parts.filter((part) => part.length > 0).join("\n");

	if (tier === 2) {
		// Only the part of the block *before* `\begin{document}` is preamble.
		const match = BEGIN_DOCUMENT.exec(tidiedSource);
		const index = match?.index ?? 0;
		const head = tidiedSource.slice(0, index);
		const document = tidiedSource.slice(index);
		const { early, late, rest } = splitPreambleLines(head.split("\n"));
		const tex = withContent([
			STANDALONE_CLASS,
			driverLine,
			...early,
			preamble,
			...late,
			...rest,
			document,
		]);
		return { tex, tier, tidiedSource, hoisted: [] };
	}

	// Tier 3: `\usepackage` and friends are preamble-only, so lift them out of
	// what will become the document body.
	const { early, late, rest } = splitPreambleLines(tidiedSource.split("\n"));
	const tex = withContent([
		STANDALONE_CLASS,
		driverLine,
		...early,
		preamble,
		...late,
		"\\begin{document}",
		rest.join("\n"),
		"\\end{document}",
	]);

	return { tex, tier, tidiedSource, hoisted: [...early, ...late] };
}
