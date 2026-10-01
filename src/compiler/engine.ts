/**
 * Compile a TikZ source string into an SVG by shelling out to a local TeX
 * distribution.
 *
 * Pure Node module: no `import "obsidian"` (AGENTS.md), so the whole
 * "string in → {svg} | {error, log} out" contract is testable headlessly
 * (plan §M1) and reusable if a general `latex` fence is added later.
 *
 * Two stages, exactly as plan §6.2/§6.3 describe:
 *   1. tex engine  → .dvi / .xdv / .pdf
 *   2. dvisvgm     → .svg
 */

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import {
	BinaryNotFoundError,
	buildHostSpawn,
	buildSpawnEnv,
	isFlatpak,
	resolveBinary,
	scratchRoot,
	type ResolvedBinary,
} from "./pathResolve";
import { normalizePreamble, wrapTikzSource } from "./wrapSource";

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

/** Cap on captured process output, so a runaway log cannot blow up the DOM. */
const MAX_CAPTURE_BYTES = 1024 * 1024;
/** Cap on the log string returned to callers. */
const MAX_LOG_CHARS = 400_000;

interface ProcessResult {
	code: number | null;
	signal: NodeJS.Signals | null;
	stdout: string;
	stderr: string;
	timedOut: boolean;
	spawnError?: Error;
}

/** Kills a process and its children. `detached` gives us a killable group. */
function killProcessTree(pid: number | undefined, child: ReturnType<typeof spawn>): void {
	if (pid === undefined) return;
	if (process.platform === "win32") {
		try {
			spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true });
		} catch {
			child.kill("SIGKILL");
		}
		return;
	}
	try {
		// Negative pid targets the whole process group created by `detached`.
		process.kill(-pid, "SIGKILL");
	} catch {
		try {
			child.kill("SIGKILL");
		} catch {
			// Already gone.
		}
	}
}

/**
 * Spawns a binary with an argv array — never a concatenated shell string
 * (AGENTS.md rule 4) — enforcing a hard timeout with a process-tree kill
 * (AGENTS.md rule 5).
 */
function runProcess(
	command: string,
	args: string[],
	options: {
		cwd: string;
		env: NodeJS.ProcessEnv;
		timeoutMs: number;
		viaHost?: boolean;
		extraDirs?: string[];
	},
): Promise<ProcessResult> {
	return new Promise((resolve) => {
		let stdout = "";
		let stderr = "";
		let settled = false;
		let timedOut = false;

		const host = options.viaHost
			? buildHostSpawn(command, args, options.cwd, options.extraDirs)
			: null;
		const spawnCmd = host ? host.command : command;
		const spawnArgs = host ? host.args : args;

		let child: ReturnType<typeof spawn>;
		try {
			child = spawn(spawnCmd, spawnArgs, {
				cwd: options.cwd,
				env: options.env,
				stdio: ["ignore", "pipe", "pipe"],
				// Own process group, so a timeout can kill helper processes too.
				detached: process.platform !== "win32",
				windowsHide: true,
			});
		} catch (error) {
			// `spawn` can throw synchronously (e.g. EINVAL for a .bat/.cmd on
			// Windows) instead of emitting `error`.
			resolve({
				code: null,
				signal: null,
				stdout: "",
				stderr: "",
				timedOut: false,
				spawnError: error instanceof Error ? error : new Error(String(error)),
			});
			return;
		}

		const append = (current: string, chunk: Buffer): string => {
			if (current.length >= MAX_CAPTURE_BYTES) return current;
			return (current + chunk.toString("utf8")).slice(0, MAX_CAPTURE_BYTES);
		};

		child.stdout?.on("data", (chunk: Buffer) => {
			stdout = append(stdout, chunk);
		});
		child.stderr?.on("data", (chunk: Buffer) => {
			stderr = append(stderr, chunk);
		});

		const timer = setTimeout(() => {
			timedOut = true;
			killProcessTree(child.pid, child);
		}, options.timeoutMs);

		const finish = (result: ProcessResult): void => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolve(result);
		};

		child.on("error", (error: Error) => {
			finish({ code: null, signal: null, stdout, stderr, timedOut, spawnError: error });
		});

		child.on("close", (code, signal) => {
			finish({ code, signal, stdout, stderr, timedOut });
		});
	});
}

/** Extracts the first `! ...` LaTeX error line, with its line context. */
export function extractErrorSummary(log: string): string | null {
	const lines = log.split("\n");
	const index = lines.findIndex((line) => /^!\s?/.test(line));
	if (index === -1) return null;

	const message = lines[index].replace(/^!\s?/, "").trim();
	// LaTeX follows an error with `l.<line> <context>` (or `<file>:<line>:`).
	for (let i = index + 1; i < Math.min(index + 8, lines.length); i++) {
		const contextMatch = lines[i].match(/^\s*(l\.\d+)\s*(.*)$/);
		if (contextMatch) {
			const context = contextMatch[2].trim();
			return context
				? `! ${message} — ${contextMatch[1]} (${context})`
				: `! ${message} — ${contextMatch[1]}`;
		}
	}
	return `! ${message}`;
}

/** Turns a compiler log into an actionable hint, when we recognise the case. */
export function deriveHint(log: string, engine: EngineId): string | undefined {
	// TeX wraps log lines at ~79 columns, so a phrase like "not found" can be
	// split across two lines. Collapse the newlines for the phrase checks;
	// the line-anchored checks below use the original text.
	const flat = log.replace(/\s*\n\s*/g, " ");

	const missingFile = flat.match(/File [`'"]?([^'"\s`]+)[`'"]? not\s+found/);
	if (missingFile) {
		const file = missingFile[1];
		if (file.endsWith(".sty")) {
			const pkg = file.replace(/\.sty$/, "");
			return `The LaTeX package "${pkg}" is not installed in your TeX distribution. Install it (e.g. \`tlmgr install ${pkg}\`) or remove the \\usepackage line.`;
		}
		return `LaTeX could not find "${file}". It is neither installed nor in the current directory.`;
	}

	if (/Can be used only in preamble/i.test(flat)) {
		return "\\usepackage must appear before \\begin{document}. Move it to the top of the block, or add it to the plugin's default preamble setting.";
	}

	if (/surface shading \(shader=interp\) is NOT available/i.test(flat)) {
		return "pgfplots cannot do `shader=interp` on the DVI route. Use `shader=flat`, or switch the engine to pdfLaTeX in settings.";
	}

	if (/fontspec package requires either XeTeX or/i.test(flat) && engine === "latex") {
		return "System fonts (fontspec) need LuaLaTeX or XeLaTeX. Change the engine in settings.";
	}

	if (engine === "pdflatex" && /can't retrieve number of pages/i.test(flat)) {
		return "`dvisvgm --pdf` could not read the PDF — this build of dvisvgm has no working PDF backend. Switch the engine to LuaLaTeX (the default) instead.";
	}

	if (/^!\s*Missing \\begin\{document\}/m.test(log)) {
		return "The block looks incomplete. Add \\begin{document} ... \\end{document}, or write bare TikZ commands and let the plugin wrap them.";
	}

	if (/Portal call failed/i.test(flat) || /org\.freedesktop\.portal/i.test(flat)) {
		return "Obsidian running in Flatpak could not spawn host process. Grant permission with: `flatpak override --user --talk-name=org.freedesktop.Flatpak md.obsidian.Obsidian`";
	}

	return undefined;
}

function capLog(log: string): string {
	if (log.length <= MAX_LOG_CHARS) return log;
	return `${log.slice(0, MAX_LOG_CHARS)}\n\n[... log truncated at ${MAX_LOG_CHARS} characters ...]`;
}

function joinLog(parts: (string | null | undefined)[]): string {
	const kept = parts
		.map((part) => (part ?? "").trim())
		.filter((part) => part.length > 0);
	return capLog(kept.join("\n\n"));
}

async function readIfExists(file: string): Promise<string | null> {
	try {
		return await fsp.readFile(file, "utf8");
	} catch {
		return null;
	}
}

/** Fresh scratch directory, always outside the vault. */
export function createWorkDir(): string {
	return path.join(scratchRoot(), `${Date.now()}-${randomUUID().slice(0, 8)}`);
}

/**
 * Removes stale scratch directories left behind by earlier runs (plan §6.3:
 * "swept on next plugin load"). Only directories older than `maxAgeMs` are
 * touched, so a compile running in a second Obsidian window survives.
 */
export async function sweepScratchDirs(maxAgeMs = 60 * 60 * 1000): Promise<number> {
	const root = scratchRoot();
	let removed = 0;
	let entries: string[];
	try {
		entries = await fsp.readdir(root);
	} catch {
		return 0;
	}

	const cutoff = Date.now() - maxAgeMs;
	for (const entry of entries) {
		const full = path.join(root, entry);
		try {
			const stat = await fsp.stat(full);
			if (stat.isDirectory() && stat.mtimeMs < cutoff) {
				await fsp.rm(full, { recursive: true, force: true });
				removed++;
			}
		} catch {
			// Raced with another sweep; nothing to do.
		}
	}
	return removed;
}

/**
 * Compiles a TikZ block. Never throws for user-caused failures: every failure
 * mode comes back as a {@link CompileFailure} carrying the real compiler log
 * (AGENTS.md rule 6), so the render layer always has something to show.
 */
export async function compileTikz(options: CompileOptions): Promise<CompileResult> {
	const started = Date.now();
	try {
		return await compileTikzUnsafe(options, started);
	} catch (error) {
		// Backstop for the "never throws" contract: an unexpected exception
		// (a bug, an fs error outside the guarded calls) must still surface as
		// a failure with a message instead of an unhandled rejection.
		const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
		return {
			ok: false,
			kind: "internal",
			summary: `Unexpected error while compiling: ${error instanceof Error ? error.message : String(error)}`,
			log: message,
			tex: "",
			durationMs: Date.now() - started,
			workDir: options.workDir ?? "",
		};
	}
}

async function compileTikzUnsafe(options: CompileOptions, started: number): Promise<CompileResult> {
	const spec = ENGINE_SPECS[options.engine];
	const jobName = options.jobName ?? "diagram";
	const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_SECONDS * 1000;
	const workDir = options.workDir ?? createWorkDir();

	const wrapped = wrapTikzSource({
		source: options.source,
		preamble: normalizePreamble(options.preamble),
		injectDvisvgmDriver: spec.injectDvisvgmDriver,
	});
	const tex = wrapped.tex;

	const fail = (
		kind: CompileFailureKind,
		summary: string,
		log: string,
		hint?: string,
	): CompileFailure => ({
		ok: false,
		kind,
		summary,
		...(hint ? { hint } : {}),
		log: capLog(log),
		tex,
		durationMs: Date.now() - started,
		workDir,
	});

	try {
		await fsp.mkdir(workDir, { recursive: true });
	} catch (error) {
		return fail(
			"io-error",
			`Could not create the scratch directory: ${workDir}`,
			error instanceof Error ? error.message : String(error),
			"Check that the system temp directory is writable.",
		);
	}

	const env = buildSpawnEnv(options.extraPathDirs ?? []);

	// ---- resolve binaries -------------------------------------------------
	let engineResolved: ResolvedBinary;
	let dvisvgmResolved: ResolvedBinary;
	try {
		engineResolved = resolveBinary({
			name: options.engine,
			override: options.enginePath,
			extraDirs: options.extraPathDirs,
		});
	} catch (error) {
		const searched = error instanceof BinaryNotFoundError ? error.searchedDirs : [];
		return fail(
			"binary-not-found",
			`TeX engine "${options.engine}" was not found.`,
			searched.join("\n"),
			isFlatpak()
				? "Install a TeX distribution on your host Linux system (or inside Flatpak via `flatpak install org.freedesktop.Sdk.Extension.texlive`), and ensure Flatpak has permission to talk to the host (`flatpak override --user --talk-name=org.freedesktop.Flatpak md.obsidian.Obsidian`)."
				: "Install a TeX distribution (MacTeX, TeX Live or MiKTeX), or set the full binary path in the plugin settings and use “Detect automatically”.",
		);
	}
	try {
		dvisvgmResolved = resolveBinary({
			name: "dvisvgm",
			override: options.dvisvgmPath,
			extraDirs: options.extraPathDirs,
		});
	} catch (error) {
		const searched = error instanceof BinaryNotFoundError ? error.searchedDirs : [];
		return fail(
			"binary-not-found",
			'"dvisvgm" was not found.',
			searched.join("\n"),
			isFlatpak()
				? "dvisvgm ships with TeX Live on your host system or in org.freedesktop.Sdk.Extension.texlive."
				: "dvisvgm ships with TeX Live/MacTeX. Set its full path in the plugin settings if your install keeps it elsewhere.",
		);
	}

	const engineBin = engineResolved.path;
	const dvisvgmBin = dvisvgmResolved.path;

	// ---- stage 1: tex → dvi/xdv/pdf ---------------------------------------
	const texFile = `${jobName}.tex`;
	try {
		await fsp.writeFile(path.join(workDir, texFile), tex, "utf8");
	} catch (error) {
		return fail(
			"io-error",
			`Could not write ${texFile}`,
			error instanceof Error ? error.message : String(error),
		);
	}

	const engineArgs = [
		"-interaction=nonstopmode",
		// `-halt-on-error` is the fix for the upstream plugin's silent infinite
		// hangs: an error stops the run and returns a log instead of prompting.
		"-halt-on-error",
		options.allowShellEscape ? "-shell-escape" : "-no-shell-escape",
		...spec.engineArgs,
		texFile,
	];

	const engineRun = await runProcess(engineBin, engineArgs, {
		cwd: workDir,
		env,
		timeoutMs,
		viaHost: engineResolved.viaHost,
		extraDirs: options.extraPathDirs,
	});
	const engineLogFile = await readIfExists(path.join(workDir, `${jobName}.log`));
	const engineLog = joinLog([
		engineRun.stderr,
		engineLogFile ?? engineRun.stdout,
	]);

	if (engineRun.timedOut) {
		return fail(
			"timeout",
			`The TeX engine timed out after ${Math.round(timeoutMs / 1000)}s.`,
			engineLog,
			"Large diagrams (or a first run that has to build font maps) can exceed the limit. Raise the compile timeout in settings.",
		);
	}

	if (engineRun.spawnError) {
		return fail(
			"binary-not-found",
			`Could not start "${options.engine}": ${engineRun.spawnError.message}`,
			engineLog,
			engineResolved.viaHost
				? "Check that flatpak-spawn has permission to run commands on the host (`flatpak override --user --talk-name=org.freedesktop.Flatpak md.obsidian.Obsidian`)."
				: "Set the full binary path in the plugin settings.",
		);
	}

	if (engineRun.code !== 0 || /^!\s?/m.test(engineLog)) {
		const summary = extractErrorSummary(engineLog) ?? `The TeX engine exited with code ${engineRun.code}.`;
		return fail("compile-error", summary, engineLog, deriveHint(engineLog, options.engine));
	}

	const artifact = path.join(workDir, `${jobName}.${spec.artifactExt}`);
	if (!fs.existsSync(artifact)) {
		return fail(
			"internal",
			`The TeX engine reported success but produced no .${spec.artifactExt} file.`,
			engineLog,
			"This usually means the document produced no pages. Check that the block draws something.",
		);
	}

	// ---- stage 2: dvi/xdv/pdf → svg --------------------------------------
	// `--no-fonts` is required: dvisvgm's default embeds SVG <font> elements,
	// which Chromium (and therefore Obsidian) no longer renders — text would
	// vanish. With it, glyphs become <path> elements referenced via <use>.
	const dvisvgmArgs = [
		...spec.dvisvgmArgs,
		"--no-fonts",
		"-o",
		`${jobName}.svg`,
		`${jobName}.${spec.artifactExt}`,
	];

	const svgRun = await runProcess(dvisvgmBin, dvisvgmArgs, {
		cwd: workDir,
		env,
		timeoutMs,
		viaHost: dvisvgmResolved.viaHost,
		extraDirs: options.extraPathDirs,
	});
	if (svgRun.timedOut) {
		return fail(
			"timeout",
			`dvisvgm timed out after ${Math.round(timeoutMs / 1000)}s.`,
			joinLog([engineLog, svgRun.stderr, svgRun.stdout]),
			"Raise the compile timeout in settings.",
		);
	}
	if (svgRun.spawnError) {
		return fail(
			"binary-not-found",
			`Could not start "dvisvgm": ${svgRun.spawnError.message}`,
			joinLog([engineLog, svgRun.stderr, svgRun.stdout]),
			dvisvgmResolved.viaHost
				? "Check that flatpak-spawn has permission to run commands on the host (`flatpak override --user --talk-name=org.freedesktop.Flatpak md.obsidian.Obsidian`)."
				: "Set the full binary path in the plugin settings.",
		);
	}
	if (svgRun.code !== 0) {
		const svgLog = joinLog([engineLog, svgRun.stderr, svgRun.stdout]);
		return fail(
			"dvisvgm-error",
			extractErrorSummary(svgRun.stderr + svgRun.stdout) ??
				`dvisvgm exited with code ${svgRun.code}.`,
			svgLog,
			deriveHint(svgLog, options.engine),
		);
	}

	const svg = await readIfExists(path.join(workDir, `${jobName}.svg`));
	if (!svg || svg.trim().length === 0) {
		return fail(
			"internal",
			"dvisvgm produced no SVG output.",
			joinLog([engineLog, svgRun.stderr, svgRun.stdout]),
		);
	}

	const log = joinLog([engineLog, svgRun.stderr]);

	if (!options.keepWorkDirOnSuccess) {
		// Zero vault pollution either way: this is in the OS temp dir.
		await fsp.rm(workDir, { recursive: true, force: true }).catch(() => undefined);
	}

	return {
		ok: true,
		svg,
		log,
		tex,
		durationMs: Date.now() - started,
		enginePath: engineBin,
		dvisvgmPath: dvisvgmBin,
		workDir,
	};
}
