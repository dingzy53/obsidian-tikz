import { App, Notice, Platform, PluginSettingTab, TextAreaComponent } from "obsidian";
import type { Setting, SettingDefinitionItem } from "obsidian";
import type TikzPlugin from "./main";
import { DEFAULT_TIMEOUT_SECONDS, ENGINE_IDS, ENGINE_SPECS } from "./compiler/engineSpecs";
import { DEFAULT_PREAMBLE } from "./compiler/wrapSource";
import type { DesktopServices } from "./desktop";
import { validateSharedFolder } from "./shared/folder";
import { describeSyncReport } from "./sharedSync";
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
 *
 * On mobile there is no compiler, so the compiler, preamble, security and
 * cache rows are hidden (`visible`). Obsidian still runs their `render`
 * callbacks, so those return early when `plugin.desktop` is undefined.
 */
export class TikzSettingTab extends PluginSettingTab {
	plugin: TikzPlugin;

	constructor(app: App, plugin: TikzPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	/**
	 * Undefined on mobile. Obsidian runs a row's `render` even while the row is
	 * hidden, so desktop-only rows must cope with that rather than throw (a
	 * throw aborts the whole tab).
	 */
	private get desktop(): DesktopServices | undefined {
		return this.plugin.desktop;
	}

	private readonly isDesktop = (): boolean => this.plugin.desktop !== undefined;

	override getControlValue(key: string): unknown {
		return readSettingValue(this.plugin.settings, key);
	}

	override async setControlValue(key: string, value: unknown): Promise<void> {
		// Same validation and clamping as settings loaded from data.json.
		this.plugin.settings = applySettingChange(this.plugin.settings, key, value);
		await this.plugin.saveSettings();

		switch (key) {
			case "shareWithMobile":
				if (value === true) {
					this.update();
					await this.plugin.runSharedSync(true);
					this.update();
				} else {
					this.plugin.confirmSharedCleanup(() => this.update());
					this.update();
				}
				break;
			case "sharedFolder":
				this.plugin.reloadSharedDiagrams();
				this.update();
				break;
			case "colorAdaptation":
			case "zoomOnClick":
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
			this.mobileGroup(),
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
					name: "Dark mode colors",
					desc: "Choose how light-page diagrams adapt on dark Obsidian themes without recompiling.",
					control: {
						type: "dropdown",
						key: "colorAdaptation",
						options: {
							adaptive: "Adaptive (recommended)",
							"light-canvas": "Light canvas",
							off: "Off (leave colors alone)",
						},
					},
				},
				{
					name: "Click to enlarge diagrams",
					desc: "Clicking a diagram or pressing Enter on it opens the zoomable viewer.",
					control: { type: "toggle", key: "zoomOnClick" },
				},
				{
					name: "TeX engine",
					visible: this.isDesktop,
					desc: "TeX engine used to compile diagrams (LuaLaTeX recommended).",
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
		const isFlatpak = (): boolean => this.plugin.desktop?.isFlatpak() ?? false;
		return {
			type: "group",
			heading: "TeX binaries",
			visible: this.isDesktop,
			items: [
				{
					name: "Detected binaries",
					desc: "Where the plugin currently finds the TeX engine and dvisvgm.",
					render: (setting) => this.renderBinaryStatus(setting),
				},
				{
					name: "Environment",
					desc: "Platform notes for locating TeX binaries.",
					visible: () => this.isDesktop() && (Platform.isMacOS || isFlatpak()),
					render: (setting) => this.renderEnvironmentInfo(setting, isFlatpak()),
				},
				{
					name: "TeX engine path",
					desc: "Leave empty to auto-detect.",
					aliases: ["binary", "executable"],
					control: { type: "text", key: "enginePath", placeholder: "Auto-detect the engine" },
				},
				{
					name: "Detect TeX engine",
					desc: "Look up the TeX engine path using your login shell.",
					action: () => void this.detect("engine"),
				},
				{
					name: "dvisvgm path",
					desc: "Leave empty to auto-detect the DVI-to-SVG converter.",
					control: { type: "text", key: "dvisvgmPath", placeholder: "Auto-detect dvisvgm" },
				},
				{
					name: "Detect dvisvgm",
					desc: "Look up the dvisvgm path using your login shell.",
					action: () => void this.detect("dvisvgm"),
				},
				{
					name: "Extra PATH directories",
					desc: "Extra directories appended to PATH when compiling, one per line.",
					control: { type: "textarea", key: "extraPathDirs", placeholder: "/usr/local/bin", rows: 3 },
				},
			],
		};
	}

	private preambleGroup(): SettingDefinitionItem {
		return {
			type: "group",
			heading: "Default preamble",
			visible: this.isDesktop,
			cls: "tikz-preamble-group",
			items: [
				{
					name: "Preamble",
					desc: "Loaded for blocks without a custom \\documentclass.",
					aliases: ["packages", "usepackage", "restore", "default preamble"],
					render: (setting) => this.renderPreamble(setting),
				},
			],
		};
	}

	private securityGroup(): SettingDefinitionItem {
		return {
			type: "group",
			heading: "Security",
			visible: this.isDesktop,
			items: [
				{
					name: "Vault content is untrusted",
					desc: "Shell escape lets diagrams run arbitrary shell commands and should stay off for untrusted notes.",
					render: (setting) => {
						if (!this.isDesktop()) return;
						setting.settingEl.addClass("tikz-settings-warning");
						setting
							.setName("Vault content is untrusted")
							.setDesc(
								"Shell escape lets diagrams run arbitrary shell commands and should stay off for untrusted notes.",
							);
					},
				},
				{
					name: "Allow shell escape (\\write18)",
					desc: "Pass -shell-escape to the TeX engine.",
					control: { type: "toggle", key: "allowShellEscape" },
				},
			],
		};
	}

	private performanceGroup(): SettingDefinitionItem {
		return {
			type: "group",
			heading: "Performance and cache",
			visible: this.isDesktop,
			items: [
				{
					name: "Compile timeout",
					desc: `Seconds allowed per stage (1–${MAX_TIMEOUT_SECONDS}) before a compile is aborted.`,
					control: {
						type: "number",
						key: "compileTimeoutSeconds",
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
					desc: `Maximum simultaneous compiles (0 = automatic, max ${MAX_CONCURRENT_COMPILES_LIMIT}).`,
					control: {
						type: "number",
						key: "maxConcurrentCompiles",
						step: 1,
						validate: (value) =>
							Number.isInteger(value) && value >= 0 && value <= MAX_CONCURRENT_COMPILES_LIMIT
								? undefined
								: `Enter a whole number from 0 to ${MAX_CONCURRENT_COMPILES_LIMIT}.`,
					},
				},
				{
					name: "Maximum cached diagrams",
					desc: "Maximum cached SVGs before evicting the least recently used (0 = unlimited).",
					control: {
						type: "number",
						key: "maxCacheEntries",
						step: 1,
						validate: (value) =>
							Number.isInteger(value) && value >= 0 ? undefined : "Enter a whole number, 0 or more.",
					},
				},
				{
					name: "Cached diagrams",
					desc: "Rendered SVGs are cached locally by content hash.",
					render: (setting) => {
						if (!this.isDesktop()) return;
						setting.setName("Cached diagrams").setDesc("Counting cached diagrams…");
						void this.updateCacheSummary(setting);
					},
				},
				{
					name: "Clear cached diagrams",
					action: () => {
						void this.desktop?.cache.clear().then((removed) => {
							new Notice(`Cleared ${removed} cached file(s).`);
							this.update();
						});
					},
				},
				{
					name: "Reveal cache folder",
					action: () => {
						const desktop = this.desktop;
						if (desktop) desktop.revealPath(desktop.cache.directory);
					},
				},
			],
		};
	}

	private mobileGroup(): SettingDefinitionItem {
		const sharing = (): boolean => this.plugin.settings.shareWithMobile;
		return {
			type: "group",
			heading: "Mobile",
			items: [
				{
					name: "Share diagrams with mobile",
					desc: "Mirror compiled SVGs into a visible vault folder so phones and tablets can display them.",
					aliases: ["phone", "sync", "ios", "android", "tablet"],
					visible: this.isDesktop,
					control: { type: "toggle", key: "shareWithMobile" },
				},
				{
					name: "Diagrams on this device",
					desc: "Mobile displays shared SVGs from a desktop; unshared blocks show as not rendered yet.",
					visible: () => !this.isDesktop(),
				},
				{
					name: "Shared folder",
					desc: "Visible vault folder outside the config folder for shared SVGs.",
					control: {
						type: "text",
						key: "sharedFolder",
						placeholder: "TikZ cache",
						disabled: sharing,
						validate: (value) => {
							const check = validateSharedFolder(value, this.app.vault.configDir);
							return check.ok ? undefined : check.error;
						},
					},
				},
				{
					name: "Shared diagrams",
					desc: "Diagrams currently in the shared folder.",
					render: (setting) => this.renderSharedStatus(setting),
				},
				{
					name: "Update shared diagrams now",
					desc: "Copy cached renders to the shared folder and prune unused SVGs.",
					visible: () => this.isDesktop() && sharing(),
					action: () => {
						void this.plugin.runSharedSync(true).then(() => this.update());
					},
				},
				{
					name: "Render all for mobile",
					desc: "Compile any missing diagrams in your vault so mobile devices can display them.",
					visible: () => this.isDesktop() && sharing(),
					action: () => {
						void this.plugin.renderAllForMobile().then(() => this.update());
					},
				},
				{
					name: "Delete shared diagrams",
					desc: "Remove shared SVGs from the vault while keeping any unrelated files.",
					visible: () => !sharing() && this.plugin.shared.list().length > 0,
					action: () => {
						void this.plugin.deleteSharedDiagrams().then(() => this.update());
					},
				},
			],
		};
	}

	private renderEnvironmentInfo(setting: Setting, flatpak: boolean): void {
		if (!this.isDesktop()) return;
		const notes: string[] = [];
		if (flatpak) {
			notes.push("Flatpak detected: host TeX binaries are run through flatpak-spawn.");
		}
		if (Platform.isMacOS) {
			notes.push("macOS GUI apps omit shell PATH: click Detect or paste full paths if binaries show as missing.");
		}
		setting.setDesc(notes.join(" "));
	}

	private renderPreamble(setting: Setting): void {
		if (!this.isDesktop()) return;
		setting.settingEl.addClass("tikz-preamble-row");
		let textArea: TextAreaComponent | undefined;
		setting.addButton((button) =>
			button.setButtonText("Restore default").onClick(() => {
				void this.setControlValue("defaultPreamble", DEFAULT_PREAMBLE).then(() => {
					textArea?.setValue(DEFAULT_PREAMBLE);
					new Notice("Default preamble restored.");
				});
			}),
		);
		setting.addTextArea((area) => {
			textArea = area;
			area.inputEl.rows = 12;
			area.inputEl.spellcheck = false;
			area.setValue(this.plugin.settings.defaultPreamble).onChange((value) => {
				void this.setControlValue("defaultPreamble", value);
			});
		});
	}

	private renderSharedStatus(setting: Setting): void {
		const count = this.plugin.shared.list().length;
		const folder = this.plugin.shared.folderPath;
		const report = this.plugin.sharedSync?.lastReport;
		const summary = `${count} diagram(s) in “${folder}”.`;
		setting
			.setName("Shared diagrams")
			.setDesc(report ? `${summary} Last update: ${describeSyncReport(report)}.` : summary);
	}

	/** Status lines for the engine and dvisvgm, computed each time the row renders. */
	private renderBinaryStatus(setting: Setting): void {
		const desktop = this.desktop;
		if (!desktop) return;
		const settings = this.plugin.settings;
		const { describeResolution } = desktop;
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
		const desktop = this.desktop;
		if (!desktop) return;
		const name = which === "engine" ? this.plugin.settings.engine : "dvisvgm";
		const notice = new Notice(`Looking for ${name}…`, 0);
		const found = await desktop.detectBinaryViaLoginShell(name);
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
		const desktop = this.desktop;
		if (!desktop) return;
		const stats = await desktop.cache.stats();
		const kilobytes = Math.round(stats.bytes / 1024);
		setting.setDesc(
			`${stats.entries} cached diagram(s), ${kilobytes} KB. Rendered SVGs are cached by content hash, so unchanged blocks never recompile.`,
		);
	}
}
