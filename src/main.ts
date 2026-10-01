import { FileSystemAdapter, Notice, Plugin } from "obsidian";
import * as path from "node:path";
import { DiagramCache } from "./cache";
import { sweepScratchDirs } from "./compiler";
import { registerTikzProcessor, type TikzRenderer } from "./render";
import { DEFAULT_SETTINGS, mergeSettings, TikzSettingTab, type TikzSettings } from "./settings";

export default class TikzPlugin extends Plugin {
	settings: TikzSettings = { ...DEFAULT_SETTINGS };
	cache!: DiagramCache;
	/** Absolute path of this plugin's own folder. */
	pluginDir = "";
	private renderer: TikzRenderer | null = null;

	async onload(): Promise<void> {
		await this.loadSettings();

		this.pluginDir = this.resolvePluginDir();
		this.cache = new DiagramCache(
			path.join(this.pluginDir, "cache"),
			this.settings.maxCacheEntries,
		);
		await this.cache.ensureDir().catch((error: unknown) => {
			console.error("[tikz] Could not create the cache directory.", error);
		});
		void this.cache.purgeLegacyLogs().catch(() => undefined);

		// Scratch directories from an interrupted session are not in use any
		// more (plan §6.3). Failures are kept for the "Reveal build folder"
		// affordance, so only stale ones are removed.
		void sweepScratchDirs().catch(() => undefined);

		this.addSettingTab(new TikzSettingTab(this.app, this));
		this.addSyntaxHighlighting();

		this.renderer = registerTikzProcessor(this, {
			getSettings: () => this.settings,
			cache: this.cache,
			openSettings: () => this.openSettings(),
			revealPath: (target) => this.revealPath(target),
		});

		// `adaptive` colour handling depends on whether the theme is dark, so a
		// theme switch has to re-run display-time post-processing. This is a
		// string transform on already-cached SVGs — no diagram is recompiled.
		this.registerEvent(
			this.app.workspace.on("css-change", () => {
				this.refreshAllDiagrams();
			}),
		);
	}

	onunload(): void {
		this.removeSyntaxHighlighting();
	}

	async loadSettings(): Promise<void> {
		this.settings = mergeSettings(await this.loadData());
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
		// Mutating the existing cache keeps the renderer's reference valid.
		this.cache.maxEntries = this.settings.maxCacheEntries;
	}

	/** Re-applies display-time post-processing (e.g. after a dark-mode toggle). */
	refreshAllDiagrams(): void {
		this.renderer?.refreshAll();
	}

	/**
	 * The plugin folder is the only place this plugin is allowed to write
	 * (AGENTS.md rule 2). `manifest.dir` is vault-relative, so it is joined
	 * with the vault's absolute base path.
	 */
	private resolvePluginDir(): string {
		const adapter = this.app.vault.adapter;
		const relative = this.manifest.dir ?? `.obsidian/plugins/${this.manifest.id}`;
		if (adapter instanceof FileSystemAdapter) {
			return path.join(adapter.getBasePath(), relative);
		}
		// Desktop-only plugin: anything else means an unexpected environment.
		console.warn("[tikz] Unexpected vault adapter; falling back to the relative plugin path.");
		return relative;
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

	/** Opens a file or folder in the OS file manager. */
	revealPath(target: string): void {
		try {
			// `electron` only exists in the desktop host, so require it lazily
			// and defensively: a top-level import would turn any resolution
			// failure into a plugin that refuses to load at all.
			// eslint-disable-next-line @typescript-eslint/no-require-imports -- `electron` resolves only inside Obsidian's desktop host, so it cannot be a static import
			const electron = require("electron") as { shell?: { openPath(path: string): Promise<string> } };
			void electron.shell?.openPath(target);
		} catch (error) {
			console.error("[tikz] Could not open the path.", error);
			new Notice(`Path: ${target}`);
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
