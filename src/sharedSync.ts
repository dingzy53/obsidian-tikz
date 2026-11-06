/**
 * Desktop side of "Share diagrams with mobile": keeps the shared folder equal
 * to the set of `tikz` blocks in the vault's notes.
 *
 * - {@link SharedSync.syncNow}: scan notes, copy renders that are already in
 *   the local cache, and prune files no block uses any more.
 * - {@link SharedSync.renderAllMissing}: compile the blocks that have never
 *   been rendered on this machine, so a phone can show them too.
 *
 * New renders are mirrored as they happen by `render.ts`. No Node imports:
 * the compiler and local cache arrive as {@link DesktopServices}.
 */

import { App, Modal, Notice, Setting } from "obsidian";
import { normalizePreamble } from "./compiler/wrapSource";
import type { DesktopServices } from "./desktop";
import { startCompile } from "./render";
import type { TikzSettings } from "./settingsModel";
import { extractTikzSources, mayContainTikz } from "./shared/scan";
import { planSync } from "./shared/plan";
import { computeSharedKey } from "./shared/sharedKey";
import type { SharedDiagramStore } from "./sharedStore";

export interface SyncReport {
	/** Distinct diagrams found in notes. */
	wanted: number;
	/** Copied from the local cache into the shared folder. */
	copied: number;
	/** Stale shared files removed. */
	removed: number;
	/** Diagrams with no render anywhere yet. */
	unrendered: number;
}

export interface RenderAllReport {
	rendered: number;
	failed: number;
	cancelled: boolean;
}

export function describeSyncReport(report: SyncReport): string {
	const parts = [`${report.wanted} diagram(s) in notes`];
	if (report.copied) parts.push(`${report.copied} added`);
	if (report.removed) parts.push(`${report.removed} removed`);
	if (report.unrendered) parts.push(`${report.unrendered} not rendered yet`);
	return parts.join(", ");
}

export class SharedSync {
	private running: Promise<SyncReport> | null = null;
	private renderAllRun: Promise<RenderAllReport> | null = null;
	/** Set by {@link stop} (sharing turned off, plugin unloading). */
	private stopped = false;
	lastReport: SyncReport | null = null;

	constructor(
		private readonly app: App,
		private readonly desktop: DesktopServices,
		private readonly store: SharedDiagramStore,
		private readonly getSettings: () => TikzSettings,
	) {}

	/** Cancels a running "render all" between compiles. */
	stop(): void {
		this.stopped = true;
	}

	private isActive(): boolean {
		return !this.stopped && this.getSettings().shareWithMobile;
	}

	/**
	 * Every distinct `tikz` block in the vault, by shared key. Only notes that
	 * can contain a block are read, and through the vault's read cache.
	 */
	async scanVault(): Promise<Map<string, string>> {
		const blocks = new Map<string, string>();
		for (const file of this.app.vault.getMarkdownFiles()) {
			let text: string;
			try {
				text = await this.app.vault.cachedRead(file);
			} catch {
				continue;
			}
			if (!mayContainTikz(text)) continue;
			for (const tidied of extractTikzSources(text)) {
				if (tidied.length === 0) continue;
				blocks.set(await computeSharedKey(tidied), tidied);
			}
		}
		return blocks;
	}

	/** One sync at a time: a second request while one runs gets its result. */
	syncNow(): Promise<SyncReport> {
		if (this.running) return this.running;
		this.stopped = false;
		this.running = this.doSync().finally(() => {
			this.running = null;
		});
		return this.running;
	}

	private async doSync(): Promise<SyncReport> {
		const blocks = await this.scanVault();
		const plan = planSync(
			blocks.keys(),
			this.store.list().map((file) => file.name),
		);

		let copied = 0;
		let unrendered = 0;
		for (const key of plan.missing) {
			if (!this.isActive()) break;
			const tidied = blocks.get(key);
			if (tidied === undefined) continue;
			const svg = await this.desktop.cache.get(this.localKey(tidied));
			if (!svg) {
				unrendered++;
				continue;
			}
			if (await this.store.write(key, svg)) copied++;
		}

		// Pruning only runs while sharing is still on: turning it off mid-sync
		// hands cleanup to the user's explicit choice in the dialog.
		const removed = this.isActive() ? await this.store.deleteNames(plan.stale) : 0;

		this.lastReport = { wanted: blocks.size, copied, removed, unrendered };
		return this.lastReport;
	}

	private localKey(tidied: string): string {
		const settings = this.getSettings();
		return this.desktop.localKey({
			source: tidied,
			preamble: normalizePreamble(settings.defaultPreamble),
			engine: settings.engine,
		});
	}

	/** Compiles every block that has no shared file yet, with a progress notice. */
	renderAllMissing(): Promise<RenderAllReport> {
		if (this.renderAllRun) return this.renderAllRun;
		this.stopped = false;
		this.renderAllRun = this.doRenderAll().finally(() => {
			this.renderAllRun = null;
		});
		return this.renderAllRun;
	}

	private async doRenderAll(): Promise<RenderAllReport> {
		const notice = new Notice("Looking for diagrams to render…", 0);
		try {
			const blocks = await this.scanVault();
			const presentKeys = new Set(
				this.store.list().map((file) => file.basename),
			);
			const todo = [...blocks].filter(([key]) => !presentKeys.has(key));

			let rendered = 0;
			let failed = 0;
			for (const [index, [key, tidied]] of todo.entries()) {
				if (!this.isActive()) return { rendered, failed, cancelled: true };
				notice.setMessage(`Rendering diagrams for mobile… ${index + 1}/${todo.length}`);
				const settings = this.getSettings();
				const localKey = this.localKey(tidied);
				const svg =
					(await this.desktop.cache.get(localKey)) ??
					(await startCompile(localKey, tidied, settings, this.desktop).then((result) =>
						result.ok ? result.svg : null,
					));
				if (svg && this.isActive()) {
					await this.store.write(key, svg);
					rendered++;
				} else if (!svg) {
					failed++;
				}
			}
			return { rendered, failed, cancelled: false };
		} finally {
			notice.hide();
		}
	}
}

/**
 * Shown when sharing is turned off: the files stay in the vault (and on every
 * synced device) until the user decides. `onDecide(true)` deletes them.
 */
export class SharedCleanupModal extends Modal {
	private decided = false;

	constructor(
		app: App,
		private readonly count: number,
		private readonly folder: string,
		private readonly onDecide: (deleteFiles: boolean) => void,
	) {
		super(app);
	}

	onOpen(): void {
		this.setTitle("Stop sharing diagrams with mobile");
		this.contentEl.createEl("p", {
			text:
				`The folder “${this.folder}” holds ${this.count} shared diagram(s). Deleting them also ` +
				"removes them from your other devices once they sync; phones will then show " +
				"“not rendered yet”. Other files in the folder are never touched.",
		});
		new Setting(this.contentEl)
			.addButton((button) =>
				button.setButtonText("Keep files").onClick(() => this.decide(false)),
			)
			.addButton((button) =>
				button
					.setButtonText(`Delete ${this.count} shared diagram(s)`)
					.setDestructive()
					.onClick(() => this.decide(true)),
			);
	}

	private decide(deleteFiles: boolean): void {
		this.decided = true;
		this.close();
		this.onDecide(deleteFiles);
	}

	onClose(): void {
		this.contentEl.empty();
		// Dismissing the dialog (Escape, click outside) keeps the files: the
		// non-destructive choice.
		if (!this.decided) this.onDecide(false);
	}
}
