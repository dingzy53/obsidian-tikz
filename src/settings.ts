import { App, Notice, PluginSettingTab } from "obsidian";
import type { Setting, SettingDefinitionItem } from "obsidian";
import type TikzPlugin from "./main";
import type { DiagramCache } from "./cache";
import {
	DEFAULT_PREAMBLE,
	DEFAULT_TIMEOUT_SECONDS,
	ENGINE_IDS,
	ENGINE_SPECS,
	describeResolution,
	detectBinaryViaLoginShell,
	isFlatpak,
} from "./compiler";
import {
	MAX_CONCURRENT_COMPILES_LIMIT,
	MAX_TIMEOUT_SECONDS,
	applySettingChange,
	readSettingValue,
} from "./settingsModel";

export { DEFAULT_SETTINGS, mergeSettings, type TikzSettings } from "./settingsModel";

/**
 * Settings tab, built on Obsidian's declarative settings API (1.13+): rows are
 * described as data in {@link getSettingDefinitions}, which is what makes them
 * show up in the global settings search. Reads and writes go through
 * {@link getControlValue}/{@link setControlValue}, and anything that changes
 * what the tab shows calls `update()`.
 */
export class TikzSettingTab extends PluginSettingTab {
	plugin: TikzPlugin;

	constructor(app: App, plugin: TikzPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	get cache(): DiagramCache {
		return this.plugin.cache;
	}

	override getControlValue(key: string): unknown {
		return readSettingValue(this.plugin.settings, key);
	}

	override async setControlValue(key: string, value: unknown): Promise<void> {
		// Same validation and clamping as settings loaded from data.json.
		this.plugin.settings = applySettingChange(this.plugin.settings, key, value);
		await this.plugin.saveSettings();

		switch (key) {
			case "colorAdaptation":
				this.plugin.refreshAllDiagrams();
				break;
			case "engine":
				// The binary status rows show the chosen engine.
				this.update();
				break;
			case "allowShellEscape":
				if (value === true) {
					new Notice("Shell escape enabled. Diagrams can now run shell commands on your machine.", 6000);
				}
				break;
		}
	}

	override getSettingDefinitions(): SettingDefinitionItem[] {
		return [
			this.renderingGroup(),
			this.binariesGroup(),
			this.preambleGroup(),
			this.securityGroup(),
			this.performanceGroup(),
		];
	}

	private renderingGroup(): SettingDefinitionItem {
		return {
			type: "group",
			heading: "Rendering",
			items: [
				{
					name: "Dark mode colours",
					desc:
						"Diagrams are drawn for a light page, so on a dark theme some colours need help. " +
						"Adaptive mirrors each colour's lightness (hue preserved), which fixes dark tints, greys " +
						"and light-filled boxes. Light canvas leaves colours untouched and shows the diagram on " +
						"a light panel instead — no colour shifts at all, best when shading is the point. " +
						"Applied at display time, so changing this never recompiles a diagram.",
					control: {
						type: "dropdown",
						key: "colorAdaptation",
						options: {
							adaptive: "Adaptive (recommended)",
							"light-canvas": "Light canvas",
							off: "Off (leave colours alone)",
						},
					},
				},
				{
					name: "TeX engine",
					desc: "Which engine compiles your diagrams. LuaLaTeX is the default: it matched LaTeX on every test case and also supports system fonts (fontspec).",
					aliases: ["latex", "lualatex", "xelatex", "pdflatex"],
					control: {
						type: "dropdown",
						key: "engine",
						options: Object.fromEntries(ENGINE_IDS.map((id) => [id, ENGINE_SPECS[id].label])),
					},
				},
			],
		};
	}

	private binariesGroup(): SettingDefinitionItem {
		return {
			type: "group",
			heading: "TeX binaries",
			items: [
				{
					name: "Detected binaries",
					desc: "Where the plugin currently finds the TeX engine and dvisvgm.",
					render: (setting) => this.renderBinaryStatus(setting),
				},
				{
					name: "Running in Flatpak",
					desc: "Host TeX distributions (TeX Live, MacTeX) are discovered automatically and run through flatpak-spawn.",
					visible: () => isFlatpak(),
				},
				{
					name: "PATH on macOS",
					desc: "Apps launched from Finder or the Dock do not inherit your shell's PATH, so a TeX install that works in Terminal can still be invisible here. If a binary shows as “not found”, use “Detect automatically” or paste its full path.",
				},
				{
					name: "TeX engine path",
					desc: "Leave empty to detect automatically.",
					aliases: ["binary", "executable"],
					control: { type: "text", key: "enginePath", placeholder: "Auto-detect the engine" },
				},
				{
					name: "Detect TeX engine",
					desc: "Ask your login shell where the engine lives and fill in the path.",
					action: () => void this.detect("engine"),
				},
				{
					name: "dvisvgm path",
					desc: "Leave empty to detect automatically. dvisvgm converts the TeX output to SVG.",
					control: { type: "text", key: "dvisvgmPath", placeholder: "Auto-detect dvisvgm" },
				},
				{
					name: "Detect dvisvgm",
					desc: "Ask your login shell where dvisvgm lives and fill in the path.",
					action: () => void this.detect("dvisvgm"),
				},
				{
					name: "Extra PATH directories",
					desc: "One directory per line. Appended to the PATH used when compiling, before the built-in fallbacks.",
					control: { type: "textarea", key: "extraPathDirs", placeholder: "/usr/local/bin", rows: 3 },
				},
			],
		};
	}

	private preambleGroup(): SettingDefinitionItem {
		return {
			type: "group",
			heading: "Default preamble",
			cls: "tikz-preamble-group",
			items: [
				{
					name: "Preamble",
					desc: "Added to blocks that do not carry their own \\documentclass. This is only a default, not a restriction — any package installed in your TeX distribution can be loaded with an in-block \\usepackage.",
					aliases: ["packages", "usepackage"],
					control: { type: "textarea", key: "defaultPreamble", rows: 12 },
				},
				{
					name: "Restore default preamble",
					action: () => {
						void this.setControlValue("defaultPreamble", DEFAULT_PREAMBLE).then(() => {
							this.update();
							new Notice("Default preamble restored.");
						});
					},
				},
			],
		};
	}

	private securityGroup(): SettingDefinitionItem {
		return {
			type: "group",
			heading: "Security",
			items: [
				{
					name: "Vault content is untrusted",
					desc: "Shell escape lets a diagram run shell commands: a shared or synced note could execute anything on your machine just by being opened. Leave it off unless you specifically need a package such as minted.",
					render: (setting) => {
						setting.settingEl.addClass("tikz-settings-warning");
						setting
							.setName("Vault content is untrusted")
							.setDesc(
								"Shell escape lets a diagram run shell commands: a shared or synced note could execute anything on your machine just by being opened. Leave it off unless you specifically need a package such as minted.",
							);
					},
				},
				{
					name: "Allow shell escape (\\write18)",
					desc: "Passes -shell-escape to the TeX engine. Off by default, and it should stay off.",
					control: { type: "toggle", key: "allowShellEscape" },
				},
				{
					name: "Restrict file access",
					desc:
						"Runs TeX with openin_any=p, so a diagram cannot read files outside its build folder " +
						"(for example \\input{~/.ssh/config}). The side effect: \\includegraphics and \\input " +
						"with an absolute path stop working. Turn off only for vaults you trust.",
					control: { type: "toggle", key: "restrictFileAccess" },
				},
			],
		};
	}

	private performanceGroup(): SettingDefinitionItem {
		return {
			type: "group",
			heading: "Performance and cache",
			items: [
				{
					name: "Compile timeout",
					desc: `Seconds allowed per stage (TeX, then dvisvgm), 1–${MAX_TIMEOUT_SECONDS}. A compile that exceeds it is killed and reported instead of hanging.`,
					control: {
						type: "number",
						key: "compileTimeoutSeconds",
						min: 1,
						max: MAX_TIMEOUT_SECONDS,
						step: 1,
						defaultValue: DEFAULT_TIMEOUT_SECONDS,
						validate: (value) =>
							Number.isInteger(value) && value >= 1 && value <= MAX_TIMEOUT_SECONDS
								? undefined
								: `Enter a whole number of seconds from 1 to ${MAX_TIMEOUT_SECONDS}.`,
					},
				},
				{
					name: "Parallel compiles",
					desc: `How many diagrams may compile at once; the rest wait in a queue. 0 picks automatically (half your CPU cores, at most 4). Maximum ${MAX_CONCURRENT_COMPILES_LIMIT}.`,
					control: {
						type: "number",
						key: "maxConcurrentCompiles",
						min: 0,
						max: MAX_CONCURRENT_COMPILES_LIMIT,
						step: 1,
						validate: (value) =>
							Number.isInteger(value) && value >= 0 && value <= MAX_CONCURRENT_COMPILES_LIMIT
								? undefined
								: `Enter a whole number from 0 to ${MAX_CONCURRENT_COMPILES_LIMIT}.`,
					},
				},
				{
					name: "Maximum cached diagrams",
					desc: "Least recently used cached SVGs are dropped beyond this limit. Set to 0 for no limit.",
					control: {
						type: "number",
						key: "maxCacheEntries",
						min: 0,
						step: 1,
						validate: (value) =>
							Number.isInteger(value) && value >= 0 ? undefined : "Enter a whole number, 0 or more.",
					},
				},
				{
					name: "Cached diagrams",
					desc: "Rendered SVGs are cached by content hash, so unchanged blocks never recompile.",
					render: (setting) => {
						setting.setName("Cached diagrams").setDesc("Counting cached diagrams…");
						void this.updateCacheSummary(setting);
					},
				},
				{
					name: "Clear cached diagrams",
					action: () => {
						void this.cache.clear().then((removed) => {
							new Notice(`Cleared ${removed} cached file(s).`);
							this.update();
						});
					},
				},
				{
					name: "Reveal cache folder",
					action: () => this.plugin.revealPath(this.cache.directory),
				},
			],
		};
	}

	/** Status lines for the engine and dvisvgm, computed each time the row renders. */
	private renderBinaryStatus(setting: Setting): void {
		const settings = this.plugin.settings;
		const resolutions = [
			{
				label: settings.engine,
				resolution: describeResolution({
					name: settings.engine,
					override: settings.enginePath,
					extraDirs: settings.extraPathDirs,
				}),
			},
			{
				label: "dvisvgm",
				resolution: describeResolution({
					name: "dvisvgm",
					override: settings.dvisvgmPath,
					extraDirs: settings.extraPathDirs,
				}),
			},
		];

		setting.setName("Detected binaries").setDesc(
			createFragment((fragment) => {
				for (const { label, resolution } of resolutions) {
					fragment.createDiv({
						cls: resolution.found
							? "tikz-settings-status"
							: "tikz-settings-status tikz-settings-status-error",
						text: resolution.found ? `✓ ${label}: ${resolution.path}` : `✗ ${label}: not found`,
					});
				}
			}),
		);
	}

	/** "Detect automatically" for either binary: fills in the path on success. */
	private async detect(which: "engine" | "dvisvgm"): Promise<void> {
		const name = which === "engine" ? this.plugin.settings.engine : "dvisvgm";
		const notice = new Notice(`Looking for ${name}…`, 0);
		const found = await detectBinaryViaLoginShell(name);
		notice.hide();

		if (!found) {
			new Notice(`Could not find "${name}" in your login shell. Is a TeX distribution installed?`);
			return;
		}
		await this.setControlValue(which === "engine" ? "enginePath" : "dvisvgmPath", found);
		new Notice(`Found ${name} at ${found}`);
		this.update();
	}

	private async updateCacheSummary(setting: Setting): Promise<void> {
		const stats = await this.cache.stats();
		const kilobytes = Math.round(stats.bytes / 1024);
		setting.setDesc(
			`${stats.entries} cached diagram(s), ${kilobytes} KB. Rendered SVGs are cached by content hash, so unchanged blocks never recompile.`,
		);
	}
}
