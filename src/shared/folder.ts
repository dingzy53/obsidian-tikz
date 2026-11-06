/**
 * Validation of the shared folder path. Pure (no `obsidian` import), so it
 * mirrors what `normalizePath` does for the cases that matter here.
 *
 * Obsidian Sync never syncs a file or folder whose name starts with `.`, and
 * inside the config folder it syncs only a fixed set of files per plugin
 * (`manifest.json`, `main.js`, `styles.css`, `data.json`; checked against
 * Obsidian 1.15's `allowSyncFile`). A shared folder in either place would
 * silently never reach a phone, so both are rejected.
 */

export const DEFAULT_SHARED_FOLDER = "TikZ cache";

export type FolderCheck = { ok: true; path: string } | { ok: false; error: string };

export function normalizeFolderPath(raw: string): string {
	return raw
		.trim()
		.replace(/\\/g, "/")
		.replace(/\/{2,}/g, "/")
		.replace(/^\/+|\/+$/g, "")
		.split("/")
		.map((segment) => segment.trim())
		.join("/");
}

export function validateSharedFolder(raw: unknown, configDir = ".obsidian"): FolderCheck {
	if (typeof raw !== "string") return { ok: false, error: "Enter a folder path." };
	const normalized = normalizeFolderPath(raw);
	if (normalized.length === 0) {
		return { ok: false, error: "Enter a folder inside the vault; the vault root is not allowed." };
	}
	const segments = normalized.split("/");
	if (segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")) {
		return { ok: false, error: "Use a plain vault-relative path, without . or .. segments." };
	}
	if (normalized === configDir || normalized.startsWith(`${configDir}/`)) {
		return { ok: false, error: "Sync does not carry this folder: choose one outside the config folder." };
	}
	if (segments.some((segment) => segment.startsWith("."))) {
		return { ok: false, error: "Sync skips folders whose name starts with a dot: choose a visible folder." };
	}
	return { ok: true, path: normalized };
}
