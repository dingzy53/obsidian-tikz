/**
 * The Node.js modules the desktop code uses, handed over once at startup.
 *
 * Node exists only in the desktop app (AGENTS.md rule 1). It is loaded in a
 * single place, `loadNodeApi()` in `desktop.ts`, behind `Platform.isDesktop`,
 * which is also the guard Obsidian's review lint (`obsidianmd/no-nodejs-modules`)
 * looks for. `cache.ts` and `compiler/*` reach Node through {@link nodeApi}
 * instead of importing it, so they stay free of `obsidian` and testable as
 * plain Node modules (tests provide the real modules in `test/setup/`).
 *
 * This module imports Node only as types, which TypeScript erases: it never
 * loads anything at runtime.
 */

import type * as childProcess from "node:child_process";
import type * as crypto from "node:crypto";
import type * as fs from "node:fs";
import type * as fsp from "node:fs/promises";
import type * as os from "node:os";
import type * as path from "node:path";
import type * as timers from "node:timers";

export interface NodeApi {
	childProcess: typeof childProcess;
	crypto: typeof crypto;
	fs: typeof fs;
	fsp: typeof fsp;
	os: typeof os;
	path: typeof path;
	timers: typeof timers;
}

let provided: NodeApi | null = null;

export function provideNodeApi(api: NodeApi): void {
	provided = api;
}

/** For tests only: forget the provided modules. */
export function resetNodeApi(): void {
	provided = null;
}

/**
 * The Node modules. Every caller is reached through `DesktopServices`, which
 * only exists once they were provided, so this throws only on a programming
 * error (or if desktop code were ever reached on mobile).
 */
export function nodeApi(): NodeApi {
	if (!provided) throw new Error("Node.js APIs are only available in the desktop app.");
	return provided;
}
