/**
 * Binary discovery for the TeX engine and `dvisvgm`.
 *
 * Pure Node module: no `import "obsidian"` (AGENTS.md), so it can be tested
 * directly.
 *
 * The problem this exists to solve (plan §6.4): a GUI app launched from
 * Finder/Dock — including Obsidian.app — does **not** inherit the interactive
 * shell's `PATH`. A MacTeX install at `/Library/TeX/texbin` or a Homebrew
 * `dvisvgm` at `/opt/homebrew/bin` therefore works in Terminal but is
 * invisible to a bare `spawn`, which fails with `ENOENT`. Three layers, in
 * order: settings override → `PATH` → known install directories. A fourth
 * escape hatch asks the user's login shell what it would have used.
 */

import { execFile, execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/** True when running inside a Flatpak container. */
export function isFlatpak(): boolean {
	return Boolean(process.env.FLATPAK_ID) || fs.existsSync("/.flatpak-info");
}

/** True when flatpak-spawn is available to run commands on the host. */
export function canFlatpakSpawnHost(): boolean {
	return process.platform === "linux" && isFlatpak() && isExecutable("/usr/bin/flatpak-spawn");
}

/**
 * How long a host probe result is trusted. Each probe is a *synchronous*
 * `flatpak-spawn` round-trip that blocks Obsidian's UI thread, and resolution
 * runs for every diagram and on every settings redraw, so results are reused
 * briefly. Short enough that installing TeX is noticed without a restart.
 */
export const HOST_PROBE_TTL_MS = 30_000;

/** Memoises `compute` per key for `ttlMs`; `now` is injectable for tests. */
export function createTtlMemo<T>(
	ttlMs: number,
	now: () => number = Date.now,
): { get(key: string, compute: () => T): T; clear(): void } {
	const entries = new Map<string, { value: T; expires: number }>();
	return {
		get(key, compute) {
			const hit = entries.get(key);
			const time = now();
			if (hit && hit.expires > time) return hit.value;
			const value = compute();
			entries.set(key, { value, expires: time + ttlMs });
			return value;
		},
		clear() {
			entries.clear();
		},
	};
}

const executableOnHostMemo = createTtlMemo<boolean>(HOST_PROBE_TTL_MS);
const findOnHostMemo = createTtlMemo<string | null>(HOST_PROBE_TTL_MS);

/** Forgets cached host probes, e.g. before an explicit "Detect automatically". */
export function clearHostProbeCache(): void {
	executableOnHostMemo.clear();
	findOnHostMemo.clear();
}

/** True when `file` is an executable on the host system via flatpak-spawn. */
export function isExecutableOnHost(file: string): boolean {
	if (!canFlatpakSpawnHost()) return false;
	return executableOnHostMemo.get(file, () => probeExecutableOnHost(file));
}

function probeExecutableOnHost(file: string): boolean {
	try {
		if (file.includes("/") || file.includes("\\")) {
			execFileSync("/usr/bin/flatpak-spawn", ["--host", "test", "-x", file], {
				stdio: "ignore",
				timeout: 3000,
				windowsHide: true,
			});
			return true;
		}
		// Bare command: probe host PATH via POSIX `command -v`
		const stdout = execFileSync(
			"/usr/bin/flatpak-spawn",
			["--host", "sh", "-c", 'command -v "$1"', "_", file],
			{
				encoding: "utf8",
				timeout: 3000,
				windowsHide: true,
			},
		);
		return stdout.trim().length > 0;
	} catch {
		return false;
	}
}

/**
 * Probe host system via flatpak-spawn for a command name.
 * Checks host PATH first, then known Linux TeX directories.
 */
export function findOnHost(name: string): string | null {
	if (!canFlatpakSpawnHost()) return null;
	return findOnHostMemo.get(name, () => probeFindOnHost(name));
}

function probeFindOnHost(name: string): string | null {
	try {
		const stdout = execFileSync(
			"/usr/bin/flatpak-spawn",
			["--host", "sh", "-c", 'command -v "$1"', "_", name],
			{
				encoding: "utf8",
				timeout: 3000,
				windowsHide: true,
			},
		);
		const found = stdout.trim().split("\n")[0]?.trim();
		if (found && isExecutableOnHost(found)) {
			return found;
		}
	} catch {
		// Not on default host PATH
	}

	for (const dir of knownBinDirs("linux")) {
		for (const cand of candidateNames(name, "linux")) {
			const full = path.posix.join(dir, cand);
			if (isExecutableOnHost(full)) {
				return full;
			}
		}
	}

	return null;
}

/** Directories that TeX distributions commonly install into, per platform. */
export function knownBinDirs(platform: NodeJS.Platform = process.platform): string[] {
	if (platform === "darwin") {
		return [
			"/Library/TeX/texbin", // MacTeX / TeX Live (the usual macOS location)
			"/usr/local/texlive/2026/bin/universal-darwin",
			"/opt/homebrew/bin", // Apple-silicon Homebrew (dvisvgm)
			"/usr/local/bin", // Intel Homebrew / manual installs
			"/usr/texbin", // pre-2016 MacTeX symlink
		];
	}

	if (platform === "win32") {
		const dirs = [
			"C:\\texlive\\2026\\bin\\windows",
			"C:\\Program Files\\MiKTeX\\miktex\\bin\\x64",
			"C:\\Program Files\\MiKTeX 2.9\\miktex\\bin\\x64",
			"C:\\Program Files (x86)\\MiKTeX\\miktex\\bin",
		];
		// TeX Live year directories vary; probe a few recent ones.
		for (const year of ["2025", "2024", "2023", "2022"]) {
			dirs.push(`C:\\texlive\\${year}\\bin\\windows`);
		}
		return dirs;
	}

	const linuxDirs = [
		"/usr/bin",
		"/usr/local/bin",
		"/opt/local/bin",
	];
	for (const year of ["2026", "2025", "2024", "2023", "2022"]) {
		linuxDirs.push(
			`/opt/texlive/${year}/bin/x86_64-linux`,
			`/opt/texlive/${year}/bin/aarch64-linux`,
			`/usr/local/texlive/${year}/bin/x86_64-linux`,
			`/usr/local/texlive/${year}/bin/aarch64-linux`,
		);
	}
	return linuxDirs;
}

/** True when `file` exists and is executable by the current user. */
export function isExecutable(file: string): boolean {
	try {
		const stat = fs.statSync(file);
		if (!stat.isFile()) return false;
		fs.accessSync(file, fs.constants.X_OK);
		return true;
	} catch {
		return false;
	}
}

/** Candidate file names for a bare command on this platform. */
function candidateNames(name: string, platform: NodeJS.Platform): string[] {
	if (platform !== "win32") return [name];
	if (path.extname(name).length > 0) return [name];
	return [`${name}.exe`, `${name}.cmd`, `${name}.bat`, name];
}

/** Splits a `PATH`-style string using the platform delimiter. */
export function splitPathList(value: string | undefined): string[] {
	if (!value) return [];
	return value
		.split(path.delimiter)
		.map((entry) => entry.trim())
		.filter((entry) => entry.length > 0);
}

export interface ResolveBinaryOptions {
	/** Command name, e.g. `dvilualatex`. */
	name: string;
	/** Explicit path from settings. Empty/undefined → search. */
	override?: string;
	/** Extra directories from settings, searched before the built-ins. */
	extraDirs?: string[];
	/** `PATH` to search. Defaults to `process.env.PATH`. */
	envPath?: string;
	platform?: NodeJS.Platform;
	/** Allow host resolution via flatpak-spawn when in Flatpak. Defaults to true. */
	allowHost?: boolean;
}

export interface ResolvedBinary {
	/** Absolute path or command name. */
	path: string;
	/** Whether the binary should be spawned on the host via flatpak-spawn. */
	viaHost: boolean;
}

/** Thrown when a required binary cannot be located. */
export class BinaryNotFoundError extends Error {
	readonly binaryName: string;
	readonly searchedDirs: string[];

	constructor(binaryName: string, searchedDirs: string[]) {
		super(
			`Could not find "${binaryName}". Searched: ${
				searchedDirs.length > 0 ? searchedDirs.join(", ") : "(no directories)"
			}`,
		);
		this.name = "BinaryNotFoundError";
		this.binaryName = binaryName;
		this.searchedDirs = searchedDirs;
	}
}

/**
 * Resolves a command name to an absolute path. Layers 1 and 2 of plan §6.4:
 * an explicit override wins outright, otherwise `PATH` is searched first and
 * the known install directories after it.
 *
 * In a Flatpak container, if the binary is not found inside the sandbox,
 * it will automatically resolve via the host system using flatpak-spawn.
 */
export function resolveBinary(options: ResolveBinaryOptions): ResolvedBinary {
	const platform = options.platform ?? process.platform;

	if (options.override && options.override.trim().length > 0) {
		const override = options.override.trim();
		if (isExecutable(override)) return { path: override, viaHost: false };
		if (canFlatpakSpawnHost() && options.allowHost !== false) {
			if (isExecutableOnHost(override)) {
				return { path: override, viaHost: true };
			}
		}
		throw new BinaryNotFoundError(override, [override]);
	}

	const searched: string[] = [];
	const dirs = [
		...splitPathList(options.envPath ?? process.env.PATH),
		...(options.extraDirs ?? []).map((dir) => dir.trim()).filter((dir) => dir.length > 0),
		...knownBinDirs(platform),
	];

	for (const dir of dirs) {
		searched.push(dir);
		for (const candidate of candidateNames(options.name, platform)) {
			const full = path.join(dir, candidate);
			if (isExecutable(full)) return { path: full, viaHost: false };
		}
	}

	if (canFlatpakSpawnHost() && options.allowHost !== false) {
		searched.push("(host PATH and TeX directories)");
		const hostFound = findOnHost(options.name);
		if (hostFound) {
			return { path: hostFound, viaHost: true };
		}
	}

	throw new BinaryNotFoundError(options.name, searched);
}

/**
 * `PATH` for spawned children: the inherited value plus the extra directories
 * from settings and the known install locations. TeX engines call out to
 * helper binaries (`mktexpk`, `kpsewhich`, ...), so this matters even when the
 * engine itself was resolved by absolute path.
 */
export function buildSpawnEnv(
	extraDirs: string[] = [],
	platform: NodeJS.Platform = process.platform,
): NodeJS.ProcessEnv {
	const dirs = [
		...splitPathList(process.env.PATH),
		...extraDirs.map((dir) => dir.trim()).filter((dir) => dir.length > 0),
		...knownBinDirs(platform),
	];
	const unique = [...new Set(dirs)];
	return { ...process.env, PATH: unique.join(path.delimiter) };
}

/** Guards the login-shell probe: only ever interpolate a plain command name. */
const SAFE_COMMAND_NAME = /^[A-Za-z0-9._-]+$/;

/**
 * Layer 3 of plan §6.4: ask the user's interactive login shell where a binary
 * lives. `-lic` runs the real rc files, so this sees the `PATH` a Terminal
 * user would have — the only reliable way to autofill the settings field on
 * macOS.
 *
 * The command name is validated against {@link SAFE_COMMAND_NAME} and is a
 * constant from our own code, never vault content, so passing it to the shell
 * is safe. This probe is the *only* place a shell is involved, and it is not
 * on the compile path (AGENTS.md rule 4).
 */
export function detectBinaryViaLoginShell(name: string, timeoutMs = 10_000): Promise<string | null> {
	if (!SAFE_COMMAND_NAME.test(name)) {
		return Promise.reject(new Error(`Refusing to probe a non-command name: ${name}`));
	}
	// An explicit request should see the machine as it is now.
	clearHostProbeCache();

	if (canFlatpakSpawnHost()) {
		const quick = findOnHost(name);
		if (quick) return Promise.resolve(quick);

		const hostShell = "sh";
		const hostArgs = ["--host", hostShell, "-lic", `command -v -- ${name}`];
		return new Promise((resolve) => {
			execFile("/usr/bin/flatpak-spawn", hostArgs, { timeout: timeoutMs, windowsHide: true }, (error, stdout) => {
				if (error && !stdout) {
					resolve(null);
					return;
				}
				const lines = stdout
					.split("\n")
					.map((line) => line.trim())
					.filter((line) => line.length > 0);

				for (const line of lines.reverse()) {
					if (line.startsWith("/") || /^[A-Za-z]:[\\/]/.test(line)) {
						if (isExecutable(line) || isExecutableOnHost(line)) return resolve(line);
					}
				}
				resolve(null);
			});
		});
	}

	const shell = process.env.SHELL ?? (process.platform === "win32" ? "cmd.exe" : "/bin/zsh");
	const args =
		process.platform === "win32"
			? ["/c", `where ${name}`]
			: ["-lic", `command -v -- ${name}`];

	return new Promise((resolve) => {
		execFile(shell, args, { timeout: timeoutMs, windowsHide: true }, (error, stdout) => {
			if (error && !stdout) {
				resolve(null);
				return;
			}
			// rc files may print banners; the answer is the last line that
			// resolves to something executable.
			const lines = stdout
				.split("\n")
				.map((line) => line.trim())
				.filter((line) => line.length > 0);

			for (const line of lines.reverse()) {
				if (line.startsWith("/") || /^[A-Za-z]:[\\/]/.test(line)) {
					if (isExecutable(line)) return resolve(line);
				}
			}
			resolve(null);
		});
	});
}

/** Human-readable summary of where a binary was found, for the settings tab. */
export function describeResolution(
	options: ResolveBinaryOptions,
): { found: true; path: string; viaHost: boolean } | { found: false; error: string } {
	try {
		const res = resolveBinary(options);
		const displayPath = res.viaHost ? `${res.path} (host)` : res.path;
		return { found: true, path: displayPath, viaHost: res.viaHost };
	} catch (error) {
		return { found: false, error: error instanceof Error ? error.message : String(error) };
	}
}

/**
 * argv for running `command` on the host through `flatpak-spawn --host`.
 *
 * Extra directories are prepended to the *host's* `PATH` by a tiny constant
 * `sh` wrapper that reads them as positional parameters (never interpolated
 * into the script). Passing `--env=PATH=…` instead would replace the host
 * `PATH` with the sandbox's, hiding the very TeX install we came for. Other
 * variables go through `--env`.
 */
export function buildHostSpawn(
	command: string,
	args: string[],
	cwd: string,
	extraDirs: string[] = [],
	env: Record<string, string> = {},
): { command: string; args: string[] } {
	const dirs = [
		...extraDirs.map((dir) => dir.trim()).filter((dir) => dir.length > 0),
		...knownBinDirs("linux"),
	];
	return {
		command: "/usr/bin/flatpak-spawn",
		args: [
			"--host",
			"--watch-bus",
			`--directory=${cwd}`,
			// The host process does not inherit our environment, so settings
			// that travel as environment variables (e.g. `openin_any`) must be
			// passed explicitly.
			...Object.entries(env).map(([key, value]) => `--env=${key}=${value}`),
			"--",
			"sh",
			"-c",
			'PATH="$1:$PATH"; shift; exec "$@"',
			"_",
			[...new Set(dirs)].join(":"),
			command,
			...args,
		],
	};
}

/** Root of the per-compile scratch directories (never inside the vault). */
export function scratchRoot(): string {
	if (isFlatpak()) {
		const cacheDir = process.env.XDG_CACHE_HOME || path.join(os.homedir(), ".cache");
		return path.join(cacheDir, "obsidian-tikz");
	}
	return path.join(os.tmpdir(), "obsidian-tikz");
}
