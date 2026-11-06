/**
 * Engine ids, specs and compile result types. Pure: no Node imports, so the
 * settings model and the renderer can use them on mobile, where the compiler
 * itself (`engine.ts`) must never load.
 */

export type EngineId = "dvilualatex" | "latex" | "xelatex" | "pdflatex";

export const ENGINE_IDS: readonly EngineId[] = ["dvilualatex", "latex", "xelatex", "pdflatex"];

/**
 * Default engine, validated empirically against TeX Live 2026 + dvisvgm 3.6
 * (plan §14 open question #1 — see README "Verified facts"):
 * `dvilualatex` matched `latex` on every DVI case and additionally handles
 * `fontspec`/system fonts, so it is a strict superset for this use case.
 */
export const DEFAULT_ENGINE: EngineId = "dvilualatex";

export const DEFAULT_TIMEOUT_SECONDS = 20;

export interface EngineSpec {
	/** Label for the settings dropdown. */
	label: string;
	/** Intermediate artifact produced by stage 1. */
	artifactExt: "dvi" | "xdv" | "pdf";
	/** Whether pgf must be told to emit dvisvgm specials (see PGF_DRIVER_LINE). */
	injectDvisvgmDriver: boolean;
	/** Extra arguments for the tex engine. */
	engineArgs: string[];
	/** Extra arguments for dvisvgm. */
	dvisvgmArgs: string[];
}

export const ENGINE_SPECS: Record<EngineId, EngineSpec> = {
	dvilualatex: {
		label: "LuaLaTeX → DVI (recommended)",
		artifactExt: "dvi",
		injectDvisvgmDriver: true,
		engineArgs: [],
		dvisvgmArgs: [],
	},
	latex: {
		label: "LaTeX → DVI (most battle-tested, no system fonts)",
		artifactExt: "dvi",
		injectDvisvgmDriver: true,
		engineArgs: [],
		dvisvgmArgs: [],
	},
	xelatex: {
		label: "XeLaTeX → XDV (system fonts)",
		artifactExt: "xdv",
		injectDvisvgmDriver: true,
		engineArgs: ["-no-pdf"],
		dvisvgmArgs: [],
	},
	pdflatex: {
		label: "pdfLaTeX → PDF (experimental: see README)",
		artifactExt: "pdf",
		injectDvisvgmDriver: false,
		engineArgs: [],
		// `dvisvgm --pdf` needs Ghostscript/mutool support and is known to drop
		// vector objects (dvisvgm#139/#150). Kept as an opt-in fallback only.
		dvisvgmArgs: ["--pdf"],
	},
};

export type CompileFailureKind =
	| "binary-not-found"
	| "compile-error"
	| "timeout"
	| "dvisvgm-error"
	| "io-error"
	| "internal";

export interface CompileOptions {
	/** Raw code-block content, untrusted. */
	source: string;
	/** Resolved default preamble from settings. */
	preamble: string;
	engine: EngineId;
	/** Explicit engine path from settings; empty → auto-detect. */
	enginePath?: string;
	/** Explicit dvisvgm path from settings; empty → auto-detect. */
	dvisvgmPath?: string;
	/** Extra directories prepended to the child `PATH`. */
	extraPathDirs?: string[];
	/** Opt-in `\write18` support. Off by default (AGENTS.md rule 3). */
	allowShellEscape?: boolean;
	/** Per-stage timeout. Defaults to {@link DEFAULT_TIMEOUT_SECONDS}. */
	timeoutMs?: number;
	/** Scratch directory. A fresh one under `os.tmpdir()` is used by default. */
	workDir?: string;
	/** Base name of the generated files. */
	jobName?: string;
	/** Keep the scratch directory even on success (debugging). */
	keepWorkDirOnSuccess?: boolean;
}

export interface CompileSuccess {
	ok: true;
	svg: string;
	/** Full compiler log (kept for the debug affordance / tests). */
	log: string;
	/** The exact document that was compiled. */
	tex: string;
	durationMs: number;
	enginePath: string;
	dvisvgmPath: string;
	workDir: string;
}

export interface CompileFailure {
	ok: false;
	kind: CompileFailureKind;
	/** Short human-readable line for the error block header. */
	summary: string;
	/** Actionable follow-up, when we can tell what went wrong. */
	hint?: string;
	log: string;
	tex: string;
	durationMs: number;
	/** Retained on failure so the user can inspect the inputs. */
	workDir: string;
}

export type CompileResult = CompileSuccess | CompileFailure;
