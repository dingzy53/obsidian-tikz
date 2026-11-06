/**
 * The shared diagram folder, as Obsidian vault files.
 *
 * Uses the Vault API rather than the adapter (plugin guidelines: it caches and
 * serialises operations), so the files are ordinary indexed vault files that
 * Obsidian Sync, git or Syncthing carry like any image. Works on mobile: no
 * Node imports.
 *
 * Only `<64 hex>.svg` files are ever written, read or deleted here
 * ({@link isSharedFileName}), so anything else in the folder is left alone.
 */

import { normalizePath, TFile, TFolder } from "obsidian";
import type { App, EventRef } from "obsidian";
import { isSharedFileName, keyOfSharedFile, sharedFileName } from "./shared/plan";

export type SharedChangeListener = (key: string) => void;

export class SharedDiagramStore {
	private readonly listeners = new Set<SharedChangeListener>();

	constructor(
		private readonly app: App,
		private readonly folder: () => string,
	) {}

	get folderPath(): string {
		return normalizePath(this.folder());
	}

	private filePath(key: string): string {
		return normalizePath(`${this.folder()}/${sharedFileName(key)}`);
	}

	/** The shared SVG for `key`, or null if there is none (yet). */
	async read(key: string): Promise<string | null> {
		const file = this.app.vault.getFileByPath(this.filePath(key));
		if (!file) return null;
		try {
			const svg = await this.app.vault.cachedRead(file);
			return svg.trim().length > 0 ? svg : null;
		} catch {
			return null;
		}
	}

	async has(key: string): Promise<boolean> {
		return this.app.vault.getFileByPath(this.filePath(key)) !== null;
	}

	/**
	 * Creates or updates the file for `key`. An unchanged file is not touched,
	 * so re-rendering a diagram does not make every sync service re-upload it.
	 * Returns whether anything was written.
	 */
	async write(key: string, svg: string): Promise<boolean> {
		await this.ensureFolder();
		const path = this.filePath(key);
		const existing = this.app.vault.getFileByPath(path);
		if (existing) {
			const current = await this.app.vault.cachedRead(existing).catch(() => null);
			if (current === svg) return false;
			await this.app.vault.modify(existing, svg);
			return true;
		}
		try {
			await this.app.vault.create(path, svg);
		} catch (error) {
			// Raced with another write of the same diagram (two blocks with the
			// same source, or a sync delivering it): that is fine.
			if (this.app.vault.getFileByPath(path)) return false;
			throw error;
		}
		return true;
	}

	private async ensureFolder(): Promise<void> {
		const path = this.folderPath;
		if (this.app.vault.getFolderByPath(path)) return;
		try {
			await this.app.vault.createFolder(path);
		} catch (error) {
			if (!this.app.vault.getFolderByPath(path)) throw error;
		}
	}

	/** Our files in the folder (not recursive). */
	list(): TFile[] {
		const folder = this.app.vault.getFolderByPath(this.folderPath);
		if (!folder) return [];
		return folder.children.filter(
			(child): child is TFile => child instanceof TFile && isSharedFileName(child.name),
		);
	}

	/** Moves the named files to the trash, respecting the user's trash setting. */
	async deleteNames(names: Iterable<string>): Promise<number> {
		const wanted = new Set(names);
		let removed = 0;
		for (const file of this.list()) {
			if (!wanted.has(file.name)) continue;
			try {
				await this.app.fileManager.trashFile(file);
				removed++;
			} catch (error) {
				console.warn("[tikz] Could not delete a shared diagram.", error);
			}
		}
		return removed;
	}

	/**
	 * Deletes every shared diagram, then the folder if nothing else is left in
	 * it. Files that are not ours keep the folder alive.
	 */
	async deleteAll(): Promise<number> {
		const removed = await this.deleteNames(this.list().map((file) => file.name));
		const folder = this.app.vault.getFolderByPath(this.folderPath);
		if (folder instanceof TFolder && folder.children.length === 0) {
			await this.app.fileManager.trashFile(folder).catch(() => undefined);
		}
		return removed;
	}

	/** Called with the key whenever a shared file appears or changes. */
	onChange(listener: SharedChangeListener): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	/**
	 * Vault events for files in the folder. On a phone this is how a diagram
	 * shows up the moment Sync delivers it, without reopening the note.
	 */
	registerEvents(register: (ref: EventRef) => void): void {
		const notify = (file: unknown): void => {
			if (!(file instanceof TFile)) return;
			if (file.parent?.path !== this.folderPath) return;
			const key = keyOfSharedFile(file.name);
			if (key === null) return;
			for (const listener of this.listeners) listener(key);
		};
		register(this.app.vault.on("create", notify));
		register(this.app.vault.on("modify", notify));
		register(this.app.vault.on("rename", notify));
	}
}
