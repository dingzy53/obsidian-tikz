/**
 * Everything that needs Node or Electron, behind one door.
 *
 * Mobile has neither (the bundle's top-level `require("node:fs")` would throw
 * and the plugin would fail to load), so `main.ts` loads this module only on
 * desktop, with a dynamic `import()`. esbuild then wraps it, and every module
 * only it reaches, in a lazy `__esm` initialiser: the `require` calls run on
 * first import, never at bundle load. Verified on the built `main.js`, and
 * enforced by the `no-restricted-imports` rule in `eslint.config.mjs` (only
 * this file may import `./cache` or `./compiler`) and `test/mobileLoad.test.ts`.
 */

import * as os from "node:os";
import * as path from "node:path";
import { FileSystemAdapter, Notice } from "obsidian";
import type { App, PluginManifest } from "obsidian";
import { computeCacheKey, DiagramCache, type CacheKeyInput } from "./cache";
import {
	compileTikz,
	describeResolution,
	detectBinaryViaLoginShell,
	isFlatpak,
	sweepScratchDirs,
	type CompileOptions,
	type CompileResult,
} from "./compiler";

export interface DesktopServices {
	/** Absolute path of this plugin's own folder. */
	pluginDir: string;
	/** The local, unsynced render cache under the plugin folder. */
	cache: DiagramCache;
	/** Key of a render in {@link cache}: source + preamble + engine. */
	localKey(input: CacheKeyInput): string;
	compile(options: CompileOptions): Promise<CompileResult>;
	cpuCount(): number;
	sweepScratchDirs(): Promise<number>;
	describeResolution: typeof describeResolution;
	detectBinaryViaLoginShell: typeof detectBinaryViaLoginShell;
	isFlatpak(): boolean;
	/** Opens a file or folder in the OS file manager. */
	revealPath(target: string): void;
}

/**
 * The plugin folder is where the local cache lives (AGENTS.md rule 2).
 * `manifest.dir` is vault-relative, so it is joined with the vault's
 * absolute base path.
 */
function resolvePluginDir(app: App, manifest: PluginManifest): string {
	const adapter = app.vault.adapter;
	const relative = manifest.dir ?? `${app.vault.configDir}/plugins/${manifest.id}`;
	if (adapter instanceof FileSystemAdapter) {
		return path.join(adapter.getBasePath(), relative);
	}
	console.warn("[tikz] Unexpected vault adapter; falling back to the relative plugin path.");
	return relative;
}

function revealPath(target: string): void {
	try {
		// `electron` only exists in the desktop host, so require it lazily and
		// defensively: a top-level import would turn any resolution failure
		// into a plugin that refuses to load at all.
		// eslint-disable-next-line @typescript-eslint/no-require-imports -- `electron` resolves only inside Obsidian's desktop host, so it cannot be a static import
		const electron = require("electron") as { shell?: { openPath(path: string): Promise<string> } };
		void electron.shell?.openPath(target);
	} catch (error) {
		console.error("[tikz] Could not open the path.", error);
		new Notice(`Path: ${target}`);
	}
}

export async function createDesktopServices(
	app: App,
	manifest: PluginManifest,
	maxCacheEntries: number,
): Promise<DesktopServices> {
	const pluginDir = resolvePluginDir(app, manifest);
	const cache = new DiagramCache(path.join(pluginDir, "cache"), maxCacheEntries);
	await cache.ensureDir().catch((error: unknown) => {
		console.error("[tikz] Could not create the cache directory.", error);
	});
	void cache.purgeLegacyLogs().catch(() => undefined);

	return {
		pluginDir,
		cache,
		localKey: computeCacheKey,
		compile: compileTikz,
		cpuCount: () => os.cpus().length,
		// Scratch directories from an interrupted session are not in use any
		// more. Failures are kept for the "Reveal build folder" affordance, so
		// only stale ones are removed.
		sweepScratchDirs: () => sweepScratchDirs(),
		describeResolution,
		detectBinaryViaLoginShell,
		isFlatpak,
		revealPath,
	};
}
