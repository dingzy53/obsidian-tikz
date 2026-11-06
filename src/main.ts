import { Notice, Platform, Plugin } from "obsidian";
import type { DesktopServices } from "./desktop";
import { registerTikzProcessor, type TikzRenderer } from "./render";
import { DEFAULT_SETTINGS, mergeSettings, TikzSettingTab, type TikzSettings } from "./settings";
import { SharedCleanupModal, SharedSync, describeSyncReport } from "./sharedSync";
import { SharedDiagramStore } from "./sharedStore";
import { DiagramZoomModal } from "./zoomModal";

/** Delay before the once-per-session shared folder sync, so startup stays quick. */
const STARTUP_SYNC_DELAY_MS = 10_000;

export default class TikzPlugin extends Plugin {
	settings: TikzSettings = { ...DEFAULT_SETTINGS };
	/**
	 * Compiler, local cache and other Node/Electron services. Undefined on
	 * mobile, where Node does not exist: the plugin then only displays
	 * diagrams from the shared folder (AGENTS.md rule 1).
	 */
	desktop: DesktopServices | undefined;
	shared!: SharedDiagramStore;
	/** Desktop only. */
	sharedSync: SharedSync | undefined;
	private renderer: TikzRenderer | null = null;

	async onload(): Promise<void> {
		await this.loadSettings();

		// `isDesktop`, not `isDesktopApp`: Obsidian sets it only in the desktop
		// app, and mobile emulation (`dev:mobile on`) clears it again while
		// leaving `isDesktopApp` true and handing plugins `null` for every Node
		// module (checked in 1.15's app.js). It is also the guard Obsidian's
		// review lint looks for.
		if (Platform.isDesktop) {
			// A dynamic import keeps every Node `require` out of the bundle's
			// top level (see `desktop.ts`).
			const { createDesktopServices } = await import("./desktop");
			this.desktop = await createDesktopServices(this.app, this.manifest, this.settings.maxCacheEntries);
			void this.desktop.sweepScratchDirs().catch(() => undefined);
		}

		this.shared = new SharedDiagramStore(this.app, () => this.settings.sharedFolder);
		this.shared.registerEvents((ref) => this.registerEvent(ref));
		if (this.desktop) {
			this.sharedSync = new SharedSync(this.app, this.desktop, this.shared, () => this.settings);
		}

		this.addSettingTab(new TikzSettingTab(this.app, this));
		this.addSyntaxHighlighting();

		this.renderer = registerTikzProcessor(this, {
			getSettings: () => this.settings,
			desktop: this.desktop,
			shared: this.shared,
			openSettings: () => this.openSettings(),
			openZoom: (svg, lightCanvas) => new DiagramZoomModal(this.app, svg, lightCanvas).open(),
		});

		// `adaptive` colour handling depends on whether the theme is dark, so a
		// theme switch has to re-run display-time post-processing. This is a
		// string transform on already-cached SVGs — no diagram is recompiled.
		this.registerEvent(
			this.app.workspace.on("css-change", () => {
				this.refreshAllDiagrams();
			}),
		);

		// Catch up once per session: notes edited elsewhere (or while sharing
		// was handled by another desktop) leave the folder out of date.
		this.app.workspace.onLayoutReady(() => {
			const timer = window.setTimeout(() => {
				if (this.settings.shareWithMobile) void this.runSharedSync(false);
			}, STARTUP_SYNC_DELAY_MS);
			this.register(() => window.clearTimeout(timer));
		});
	}

	onunload(): void {
		this.sharedSync?.stop();
		this.removeSyntaxHighlighting();
	}

	async loadSettings(): Promise<void> {
		this.settings = mergeSettings(await this.loadData());
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
		// Mutating the existing cache keeps the renderer's reference valid.
		if (this.desktop) this.desktop.cache.maxEntries = this.settings.maxCacheEntries;
	}

	/**
	 * `data.json` changed on disk, usually because a sync service delivered
	 * settings from another device. Applied live, so for example a phone picks
	 * up a changed shared folder without a restart.
	 */
	async onExternalSettingsChange(): Promise<void> {
		const before = this.settings;
		await this.loadSettings();
		if (this.desktop) this.desktop.cache.maxEntries = this.settings.maxCacheEntries;
		if (before.shareWithMobile && !this.settings.shareWithMobile) this.sharedSync?.stop();
		if (before.sharedFolder !== this.settings.sharedFolder) this.reloadSharedDiagrams();
		this.refreshAllDiagrams();
	}

	/** Re-applies display-time post-processing (e.g. after a dark-mode toggle). */
	refreshAllDiagrams(): void {
		this.renderer?.refreshAll();
	}

	/** Mobile: the shared folder setting changed, so every block looks again. */
	reloadSharedDiagrams(): void {
		this.renderer?.reloadShared();
	}

	/** Desktop: brings the shared folder up to date. `notify` reports the result. */
	async runSharedSync(notify: boolean): Promise<void> {
		if (!this.sharedSync) return;
		try {
			const report = await this.sharedSync.syncNow();
			if (notify) new Notice(`Shared diagrams: ${describeSyncReport(report)}.`);
		} catch (error) {
			console.error("[tikz] Updating the shared diagrams failed.", error);
			new Notice("Could not update the shared diagrams; see the developer console.");
		}
	}

	/** Desktop: compiles every diagram that has no shared file yet. */
	async renderAllForMobile(): Promise<void> {
		if (!this.sharedSync) return;
		try {
			const report = await this.sharedSync.renderAllMissing();
			const parts = [`${report.rendered} rendered`];
			if (report.failed) parts.push(`${report.failed} failed (open those notes to see the error)`);
			if (report.cancelled) parts.push("stopped early");
			new Notice(`Render all for mobile: ${parts.join(", ")}.`);
		} catch (error) {
			console.error("[tikz] Rendering diagrams for mobile failed.", error);
			new Notice("Rendering diagrams for mobile failed; see the developer console.");
		}
	}

	/**
	 * Sharing was just turned off: stop any running pass, then let the user
	 * decide what happens to the files already in the vault.
	 */
	confirmSharedCleanup(onDone: () => void): void {
		this.sharedSync?.stop();
		const count = this.shared.list().length;
		if (count === 0) {
			onDone();
			return;
		}
		new SharedCleanupModal(this.app, count, this.shared.folderPath, (deleteFiles) => {
			if (!deleteFiles) {
				onDone();
				return;
			}
			void this.deleteSharedDiagrams().finally(onDone);
		}).open();
	}

	async deleteSharedDiagrams(): Promise<void> {
		const removed = await this.shared.deleteAll();
		new Notice(`Deleted ${removed} shared diagram(s).`);
	}

	private openSettings(): void {
		// `app.setting` is undocumented but is the only way to deep-link into
		// this plugin's own settings tab.
		const app = this.app as unknown as {
			setting?: { open(): void; openTabById(id: string): void };
		};
		if (app.setting) {
			app.setting.open();
			app.setting.openTabById(this.manifest.id);
		} else {
			new Notice("Open Settings → Community plugins → TikZ to change the options.");
		}
	}

	/**
	 * Gives `tikz` blocks LaTeX syntax highlighting, as the upstream plugin
	 * did. Guarded because `CodeMirror` is not guaranteed to be exposed.
	 */
	private addSyntaxHighlighting(): void {
		try {
			const codeMirror = (window as unknown as {
				CodeMirror?: { modeInfo: { name: string; mime: string; mode: string }[] };
			}).CodeMirror;
			codeMirror?.modeInfo.push({ name: "Tikz", mime: "text/x-latex", mode: "stex" });
		} catch (error) {
			console.warn("[tikz] Syntax highlighting is unavailable.", error);
		}
	}

	private removeSyntaxHighlighting(): void {
		try {
			const codeMirror = (window as unknown as {
				CodeMirror?: { modeInfo: { name: string }[] };
			}).CodeMirror;
			if (codeMirror) {
				codeMirror.modeInfo = codeMirror.modeInfo.filter((entry) => entry.name !== "Tikz");
			}
		} catch (error) {
			console.warn("[tikz] Could not remove syntax highlighting.", error);
		}
	}
}
