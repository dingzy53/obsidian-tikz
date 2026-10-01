/**
 * Content-addressed disk cache for rendered diagrams.
 *
 * Pure Node module: no `import "obsidian"` (AGENTS.md). Callers pass in the
 * cache directory (which lives under the plugin's own hidden folder, so
 * nothing ever appears in the vault's file explorer).
 *
 * Why flat files instead of the upstream plugin's IndexedDB/localForage
 * (plan §6.5): that choice existed to fit the browser sandbox. On a
 * desktop-only, Node-capable plugin a flat file cache is simpler,
 * human-inspectable and trivially clearable.
 */

import { createHash } from "node:crypto";
import * as fsp from "node:fs/promises";
import * as path from "node:path";

/**
 * Bumped whenever the *rendering pipeline* changes in a way that invalidates
 * previously cached SVGs (dvisvgm flags, pgf driver injection, post-processing
 * conventions). Without this, users would keep stale output forever, since the
 * cache key is otherwise purely content-addressed.
 */
export const CACHE_VERSION = 1;

export interface CacheKeyInput {
	/** Tidied block source. */
	source: string;
	/** Resolved preamble. */
	preamble: string;
	/** Engine id (implies the pgf driver / dvisvgm flags in use). */
	engine: string;
}

/**
 * SHA-256 over the content that determines the rendered output.
 *
 * Dark-mode toggling is deliberately *not* part of the key: the cached value
 * is the pre-dark-mode SVG and the colour remap is a render-time
 * post-process, so flipping that setting never forces a recompile.
 */
export function computeCacheKey(input: CacheKeyInput): string {
	const hash = createHash("sha256");
	hash.update(`v${CACHE_VERSION}\u0000`);
	hash.update(`${input.engine}\u0000`);
	hash.update(`${input.source}\u0000`);
	hash.update(input.preamble);
	return hash.digest("hex");
}

export interface CacheStats {
	entries: number;
	bytes: number;
}

export class DiagramCache {
	constructor(
		private readonly dir: string,
		/** 0 = unlimited. Mutable so the settings tab can change it live. */
		public maxEntries: number = 0,
	) {}

	get directory(): string {
		return this.dir;
	}

	async ensureDir(): Promise<void> {
		await fsp.mkdir(this.dir, { recursive: true });
	}

	private svgPath(key: string): string {
		return path.join(this.dir, `${key}.svg`);
	}

	private logPath(key: string): string {
		return path.join(this.dir, `${key}.log`);
	}

	/** Returns the cached SVG, or null on a miss. */
	async get(key: string): Promise<string | null> {
		try {
			const svg = await fsp.readFile(this.svgPath(key), "utf8");
			return svg.trim().length > 0 ? svg : null;
		} catch {
			return null;
		}
	}

	async set(key: string, svg: string): Promise<void> {
		await this.ensureDir();
		await fsp.writeFile(this.svgPath(key), svg, "utf8");
		// A previous failure left a log next to this key; the render now
		// succeeded, so it is stale.
		await fsp.rm(this.logPath(key), { force: true }).catch(() => undefined);
		await this.sweep();
	}

	/** Caches a failure log so a past failure can be inspected later. */
	async setLog(key: string, log: string): Promise<void> {
		await this.ensureDir();
		await fsp.writeFile(this.logPath(key), log, "utf8");
	}

	async getLog(key: string): Promise<string | null> {
		try {
			return await fsp.readFile(this.logPath(key), "utf8");
		} catch {
			return null;
		}
	}

	/** Deletes every cached SVG and log. Returns the number of files removed. */
	async clear(): Promise<number> {
		let names: string[];
		try {
			names = await fsp.readdir(this.dir);
		} catch {
			return 0;
		}

		let removed = 0;
		for (const name of names) {
			if (!name.endsWith(".svg") && !name.endsWith(".log")) continue;
			try {
				await fsp.rm(path.join(this.dir, name), { force: true });
				removed++;
			} catch {
				// Ignore: another process may have removed it already.
			}
		}
		return removed;
	}

	async stats(): Promise<CacheStats> {
		let names: string[];
		try {
			names = await fsp.readdir(this.dir);
		} catch {
			return { entries: 0, bytes: 0 };
		}

		let entries = 0;
		let bytes = 0;
		for (const name of names) {
			if (!name.endsWith(".svg") && !name.endsWith(".log")) continue;
			try {
				const stat = await fsp.stat(path.join(this.dir, name));
				bytes += stat.size;
				if (name.endsWith(".svg")) entries++;
			} catch {
				// Raced with a sweep.
			}
		}
		return { entries, bytes };
	}

	/**
	 * Enforces the max-entries setting (plan §6.5) by dropping the least
	 * recently written SVGs, along with their failure logs.
	 */
	async sweep(): Promise<void> {
		if (this.maxEntries <= 0) return;

		let names: string[];
		try {
			names = await fsp.readdir(this.dir);
		} catch {
			return;
		}

		const svgs: { name: string; mtimeMs: number }[] = [];
		for (const name of names) {
			if (!name.endsWith(".svg")) continue;
			try {
				const stat = await fsp.stat(path.join(this.dir, name));
				svgs.push({ name, mtimeMs: stat.mtimeMs });
			} catch {
				// Raced with a sweep.
			}
		}

		if (svgs.length <= this.maxEntries) return;
		svgs.sort((a, b) => b.mtimeMs - a.mtimeMs);

		for (const stale of svgs.slice(this.maxEntries)) {
			const key = stale.name.replace(/\.svg$/, "");
			await fsp.rm(this.svgPath(key), { force: true }).catch(() => undefined);
			await fsp.rm(this.logPath(key), { force: true }).catch(() => undefined);
		}
	}
}
