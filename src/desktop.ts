/**
 * Everything that needs Node or Electron, behind one door (AGENTS.md rule 1).
 *
 * Mobile has neither: requiring a Node module there throws, and under
 * Obsidian's mobile emulation it yields `null`. Two layers keep Node off that
 * path:
 *
 * 1. `main.ts` imports this module only when `Platform.isDesktop`, with a
 *    dynamic `import()` that esbuild turns into a lazy initialiser, so on
 *    mobile neither this file nor the compiler and cache modules it reaches
 *    are ever evaluated.
 * 2. Node itself is loaded in exactly one place, {@link loadNodeApi}, whose
 *    first statement is the `Platform.isDesktop` guard that Obsidian's review
 *    lint (`obsidianmd/no-nodejs-modules`) recognises. Every other module gets
 *    the modules through `nodeApi()` and imports Node only as types.
 *
 * `require()`, not `import()`: esbuild leaves `import("node:fs")` as a native
 * dynamic import, which fails in Obsidian's renderer ("Failed to fetch
 * dynamically imported module"), while `require` goes through the plugin
 * loader's own `require`.
 *
 * Enforced by `eslint.config.mjs` and `test/mobileLoad.test.ts`.
 */

import { FileSystemAdapter, Notice, Platform } from "obsidian";
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
import { nodeApi, provideNodeApi, type NodeApi } from "./nodeApi";

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

/** The one place Node.js is loaded (see the file comment). */
function loadNodeApi(): NodeApi {
	if (!Platform.isDesktop) {
		throw new Error("Node.js APIs are only available in the desktop app.");
	}
	/* eslint-disable @typescript-eslint/no-require-imports -- a require() guarded by Platform.isDesktop is how Obsidian's review lint wants Node loaded; import() fails in the renderer */
	const api: NodeApi = {
		childProcess: require("node:child_process") as NodeApi["childProcess"],
		crypto: require("node:crypto") as NodeApi["crypto"],
		fs: require("node:fs") as NodeApi["fs"],
		fsp: require("node:fs/promises") as NodeApi["fsp"],
		os: require("node:os") as NodeApi["os"],
		path: require("node:path") as NodeApi["path"],
		timers: require("node:timers") as NodeApi["timers"],
	};
	/* eslint-enable @typescript-eslint/no-require-imports -- end of the guarded require() block */
	return api;
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
		return nodeApi().path.join(adapter.getBasePath(), relative);
	}
	console.warn("[tikz] Unexpected vault adapter; falling back to the relative plugin path.");
	return relative;
}

function revealPath(target: string): void {
	if (!Platform.isDesktop) return;
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
	// First: everything below, and every service returned, may use Node.
	provideNodeApi(loadNodeApi());
	const { os, path } = nodeApi();
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
