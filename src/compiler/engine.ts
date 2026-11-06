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

import type { ChildProcess } from "node:child_process";
import { nodeApi } from "../nodeApi";
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

import {
	DEFAULT_TIMEOUT_SECONDS,
	ENGINE_SPECS,
	type CompileFailure,
	type CompileFailureKind,
	type CompileOptions,
	type CompileResult,
	type EngineId,
} from "./engineSpecs";

export {
	DEFAULT_ENGINE,
	DEFAULT_TIMEOUT_SECONDS,
	ENGINE_IDS,
	ENGINE_SPECS,
	type CompileFailure,
	type CompileFailureKind,
	type CompileOptions,
	type CompileResult,
	type CompileSuccess,
	type EngineId,
	type EngineSpec,
} from "./engineSpecs";

/** Cap on captured process output (in characters), so a runaway log cannot blow up the DOM. */
const MAX_CAPTURE_CHARS = 1024 * 1024;
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
function killProcessTree(pid: number | undefined, child: ChildProcess): void {
	const { childProcess } = nodeApi();
	if (pid === undefined) return;
	if (process.platform === "win32") {
		try {
			const killer = childProcess.spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true });
			// Without a listener a failed spawn (taskkill missing from PATH)
			// would surface as an uncaught 'error' event.
			killer.on("error", () => {
				try {
					child.kill("SIGKILL");
				} catch {
					// Already gone.
				}
			});
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
	// Node timers (not `window`'s): this module is plain Node.
	const { childProcess, timers } = nodeApi();
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

		let child: ChildProcess;
		try {
			child = childProcess.spawn(spawnCmd, spawnArgs, {
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

		const append = (current: string, chunk: string): string => {
			if (current.length >= MAX_CAPTURE_CHARS) return current;
			return (current + chunk).slice(0, MAX_CAPTURE_CHARS);
		};

		// `setEncoding` decodes with a stateful decoder, so a multi-byte UTF-8
		// character split across two chunks is not turned into U+FFFD pairs.
		child.stdout?.setEncoding("utf8");
		child.stderr?.setEncoding("utf8");
		child.stdout?.on("data", (chunk: string) => {
			stdout = append(stdout, chunk);
		});
		child.stderr?.on("data", (chunk: string) => {
			stderr = append(stderr, chunk);
		});

		const timer = timers.setTimeout(() => {
			timedOut = true;
			killProcessTree(child.pid, child);
		}, options.timeoutMs);

		const finish = (result: ProcessResult): void => {
			if (settled) return;
			settled = true;
			timers.clearTimeout(timer);
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

	// TeX Live <= 2025 under `openin_any=p` (issue #4): luaotfload opens its
	// data files by absolute path and paranoid mode refuses them. The plugin no
	// longer sets it, so this only fires when the user's environment does.
	if (/luaotfload[\s|]*load\s*:\s*FATAL ERROR/i.test(flat) && /multiscript/i.test(flat)) {
		return "luaotfload could not open a file in your TeX tree; unset `openin_any` (or set it to `a`) in the environment Obsidian is started from.";
	}

	// LaTeX says "File `x' not found"; the bare \input primitive says "I can't find file `x'".
	const missingFile = flat.match(
		/File [`'"]?([^'"\s`]+)[`'"]? not\s+found|I can't find file [`'"]?([^'"\s`]+)/,
	);
	if (missingFile) {
		const file = missingFile[1] ?? missingFile[2];
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
	const { fsp } = nodeApi();
	try {
		return await fsp.readFile(file, "utf8");
	} catch {
		return null;
	}
}

/** Fresh scratch directory, always outside the vault. */
export function createWorkDir(): string {
	const { crypto, path } = nodeApi();
	return path.join(scratchRoot(), `${Date.now()}-${crypto.randomUUID().slice(0, 8)}`);
}

/**
 * Removes stale scratch directories left behind by earlier runs (plan §6.3:
 * "swept on next plugin load"). Only directories older than `maxAgeMs` are
 * touched, so a compile running in a second Obsidian window survives.
 */
export async function sweepScratchDirs(maxAgeMs = 60 * 60 * 1000): Promise<number> {
	const { fsp, path } = nodeApi();
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
	const { fs, fsp, path } = nodeApi();
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

	// No `openin_any`: it never sandboxed reads and broke luaotfload (#4). See
	// AGENTS.md rule 8.
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
