import { App, Notice, PluginSettingTab, Setting } from "obsidian";
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
	type EngineId,
} from "./compiler";
import type { ColorAdaptation } from "./svg";
import {
	MAX_CONCURRENT_COMPILES_LIMIT,
	sanitizeMaxConcurrentCompiles,
	sanitizeTimeoutSeconds,
} from "./settingsModel";

export { DEFAULT_SETTINGS, mergeSettings, type TikzSettings } from "./settingsModel";

export class TikzSettingTab extends PluginSettingTab {
	plugin: TikzPlugin;

	constructor(app: App, plugin: TikzPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	get cache(): DiagramCache {
		return this.plugin.cache;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		this.renderRenderingSection(containerEl);
		this.renderBinarySection(containerEl);
		this.renderPreambleSection(containerEl);
		this.renderSecuritySection(containerEl);
		this.renderPerformanceSection(containerEl);
	}

	private async persist(): Promise<void> {
		await this.plugin.saveSettings();
	}

	private renderRenderingSection(containerEl: HTMLElement): void {
		new Setting(containerEl).setName("Rendering").setHeading();

		new Setting(containerEl)
			.setName("Dark mode colours")
			.setDesc(
				"Diagrams are drawn for a light page, so on a dark theme some colours need help. " +
					"Adaptive mirrors each colour's lightness (hue preserved), which fixes dark tints, greys " +
					"and light-filled boxes. Light canvas leaves colours untouched and shows the diagram on " +
					"a light panel instead — no colour shifts at all, best when shading is the point. " +
					"Applied at display time, so changing this never recompiles a diagram.",
			)
			.addDropdown((dropdown) => {
				dropdown.addOption("adaptive", "Adaptive (recommended)");
				dropdown.addOption("light-canvas", "Light canvas");
				dropdown.addOption("off", "Off (leave colours alone)");
				dropdown.setValue(this.plugin.settings.colorAdaptation);
				dropdown.onChange(async (value) => {
					this.plugin.settings.colorAdaptation = value as ColorAdaptation;
					await this.persist();
					this.plugin.refreshAllDiagrams();
				});
			});

		new Setting(containerEl)
			.setName("TeX engine")
			.setDesc(
				"Which engine compiles your diagrams. LuaLaTeX is the default: it matched LaTeX on every test case and also supports system fonts (fontspec).",
			)
			.addDropdown((dropdown) => {
				for (const id of ENGINE_IDS) {
					dropdown.addOption(id, ENGINE_SPECS[id].label);
				}
				dropdown.setValue(this.plugin.settings.engine);
				dropdown.onChange(async (value) => {
					this.plugin.settings.engine = value as EngineId;
					await this.persist();
					this.display();
				});
			});
	}

	private renderBinarySection(containerEl: HTMLElement): void {
		new Setting(containerEl).setName("TeX binaries").setHeading();

		const statusEl = containerEl.createDiv({ cls: "tikz-settings-status" });
		const settings = this.plugin.settings;

		const engineResolution = describeResolution({
			name: settings.engine,
			override: settings.enginePath,
			extraDirs: settings.extraPathDirs,
		});
		const dvisvgmResolution = describeResolution({
			name: "dvisvgm",
			override: settings.dvisvgmPath,
			extraDirs: settings.extraPathDirs,
		});

		const describe = (label: string, resolution: ReturnType<typeof describeResolution>): void => {
			const line = statusEl.createDiv();
			if (resolution.found) {
				line.setText(`✓ ${label}: ${resolution.path}`);
			} else {
				line.addClass("tikz-settings-status-error");
				line.setText(`✗ ${label}: not found`);
			}
		};
		describe(settings.engine, engineResolution);
		describe("dvisvgm", dvisvgmResolution);

		if (isFlatpak()) {
			containerEl.createEl("p", {
				cls: "setting-item-description",
				text: "Obsidian is running in Flatpak. Host TeX distributions (TeX Live / MacTeX) are automatically discovered and executed via flatpak-spawn.",
			});
		}

		containerEl.createEl("p", {
			cls: "setting-item-description",
			text:
				"Apps launched from Finder or the Dock do not inherit your shell's PATH, so a TeX install that works in Terminal can still be invisible here. If a binary shows as “not found”, use Detect automatically or paste its full path.",
		});

		new Setting(containerEl)
			.setName("TeX engine path")
			.setDesc("Leave empty to detect automatically.")
			.addText((text) =>
				text
					.setPlaceholder(`auto-detect ${settings.engine}`)
					.setValue(settings.enginePath)
					.onChange(async (value) => {
						this.plugin.settings.enginePath = value.trim();
						await this.persist();
					}),
			)
			.addButton((button) =>
				button.setButtonText("Detect automatically").onClick(async () => {
					button.setDisabled(true);
					button.setButtonText("Detecting…");
					const found = await detectBinaryViaLoginShell(this.plugin.settings.engine);
					button.setDisabled(false);
					button.setButtonText("Detect automatically");
					if (found) {
						this.plugin.settings.enginePath = found;
						await this.persist();
						new Notice(`Found ${this.plugin.settings.engine} at ${found}`);
						this.display();
					} else {
						new Notice(
							`Could not find "${this.plugin.settings.engine}" in your login shell. Is a TeX distribution installed?`,
						);
					}
				}),
			);

		new Setting(containerEl)
			.setName("dvisvgm path")
			.setDesc("Leave empty to detect automatically. dvisvgm converts the TeX output to SVG.")
			.addText((text) =>
				text
					.setPlaceholder("auto-detect dvisvgm")
					.setValue(settings.dvisvgmPath)
					.onChange(async (value) => {
						this.plugin.settings.dvisvgmPath = value.trim();
						await this.persist();
					}),
			)
			.addButton((button) =>
				button.setButtonText("Detect automatically").onClick(async () => {
					button.setDisabled(true);
					button.setButtonText("Detecting…");
					const found = await detectBinaryViaLoginShell("dvisvgm");
					button.setDisabled(false);
					button.setButtonText("Detect automatically");
					if (found) {
						this.plugin.settings.dvisvgmPath = found;
						await this.persist();
						new Notice(`Found dvisvgm at ${found}`);
						this.display();
					} else {
						new Notice("Could not find \"dvisvgm\" in your login shell.");
					}
				}),
			);

		new Setting(containerEl)
			.setName("Extra PATH directories")
			.setDesc(
				"One directory per line. Appended to the PATH used when compiling, before the built-in fallbacks.",
			)
			.addTextArea((area) =>
				area
					.setPlaceholder("/usr/local/bin")
					.setValue(settings.extraPathDirs.join("\n"))
					.onChange(async (value) => {
						this.plugin.settings.extraPathDirs = value
							.split("\n")
							.map((line) => line.trim())
							.filter((line) => line.length > 0);
						await this.persist();
					}),
			);
	}

	private renderPreambleSection(containerEl: HTMLElement): void {
		new Setting(containerEl).setName("Default preamble").setHeading();

		containerEl.createEl("p", {
			cls: "setting-item-description",
			text:
				"Added to blocks that do not carry their own \\documentclass. This is only a default, not a restriction — any package installed in your TeX distribution can be loaded with an in-block \\usepackage.",
		});

		new Setting(containerEl).addTextArea((area) => {
			area.inputEl.rows = 12;
			area.inputEl.addClass("tikz-preamble-input");
			area.setValue(this.plugin.settings.defaultPreamble).onChange(async (value) => {
				this.plugin.settings.defaultPreamble = value;
				await this.persist();
			});
		});

		new Setting(containerEl).addButton((button) =>
			button.setButtonText("Restore default preamble").onClick(async () => {
				this.plugin.settings.defaultPreamble = DEFAULT_PREAMBLE;
				await this.persist();
				this.display();
				new Notice("Default preamble restored.");
			}),
		);
	}

	private renderSecuritySection(containerEl: HTMLElement): void {
		new Setting(containerEl).setName("Security").setHeading();

		const warning = containerEl.createDiv({ cls: "tikz-settings-warning" });
		warning.setText(
			"Shell escape lets a diagram run shell commands. Vault content is untrusted — a shared or synced note could execute anything on your machine just by being opened. Leave this off unless you specifically need a package such as minted.",
		);

		new Setting(containerEl)
			.setName("Allow shell escape (\\write18)")
			.setDesc("Passes -shell-escape to the TeX engine. Off by default, and it should stay off.")
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.allowShellEscape).onChange(async (value) => {
					this.plugin.settings.allowShellEscape = value;
					await this.persist();
					if (value) {
						new Notice(
							"Shell escape enabled. Diagrams can now run shell commands on your machine.",
							6000,
						);
					}
				}),
			);

		new Setting(containerEl)
			.setName("Restrict file access")
			.setDesc(
				"Runs TeX with openin_any=p, so a diagram cannot read files outside its build folder " +
					"(for example \\input{~/.ssh/config}). The side effect: \\includegraphics and \\input " +
					"with an absolute path stop working. Turn off only for vaults you trust.",
			)
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.restrictFileAccess).onChange(async (value) => {
					this.plugin.settings.restrictFileAccess = value;
					await this.persist();
				}),
			);
	}

	private renderPerformanceSection(containerEl: HTMLElement): void {
		new Setting(containerEl).setName("Performance and cache").setHeading();

		new Setting(containerEl)
			.setName("Compile timeout")
			.setDesc(
				"Seconds allowed per stage (TeX, then dvisvgm), 1–3600. A compile that exceeds it is killed and reported instead of hanging.",
			)
			.addText((text) =>
				text
					.setPlaceholder(String(DEFAULT_TIMEOUT_SECONDS))
					.setValue(String(this.plugin.settings.compileTimeoutSeconds))
					.onChange(async (value) => {
						const parsed = Number.parseInt(value, 10);
						if (Number.isFinite(parsed) && parsed > 0) {
							this.plugin.settings.compileTimeoutSeconds = sanitizeTimeoutSeconds(parsed);
							await this.persist();
						}
					}),
			);

		new Setting(containerEl)
			.setName("Parallel compiles")
			.setDesc(
				`How many diagrams may compile at once; the rest wait in a queue. 0 picks automatically (half your CPU cores, at most 4). Maximum ${MAX_CONCURRENT_COMPILES_LIMIT}.`,
			)
			.addText((text) =>
				text
					.setPlaceholder("0")
					.setValue(String(this.plugin.settings.maxConcurrentCompiles))
					.onChange(async (value) => {
						const parsed = Number.parseInt(value, 10);
						if (Number.isFinite(parsed) && parsed >= 0) {
							this.plugin.settings.maxConcurrentCompiles = sanitizeMaxConcurrentCompiles(parsed);
							await this.persist();
						}
					}),
			);

		new Setting(containerEl)
			.setName("Maximum cached diagrams")
			.setDesc("Oldest cached SVGs are dropped beyond this limit. Set to 0 for no limit.")
			.addText((text) =>
				text
					.setPlaceholder("500")
					.setValue(String(this.plugin.settings.maxCacheEntries))
					.onChange(async (value) => {
						const parsed = Number.parseInt(value, 10);
						if (Number.isFinite(parsed) && parsed >= 0) {
							this.plugin.settings.maxCacheEntries = parsed;
							await this.persist();
						}
					}),
			);

		const cacheSetting = new Setting(containerEl)
			.setName("Cached diagrams")
			.setDesc("Rendered SVGs are cached by content hash, so unchanged blocks never recompile.")
			.addButton((button) =>
				button
					.setIcon("trash")
					.setTooltip("Clear cached diagrams")
					.onClick(async () => {
						const removed = await this.cache.clear();
						new Notice(`Cleared ${removed} cached file(s).`);
						void this.updateCacheSummary(cacheSetting);
					}),
			)
			.addButton((button) =>
				button.setButtonText("Reveal cache folder").onClick(() => {
					this.plugin.revealPath(this.cache.directory);
				}),
			);

		void this.updateCacheSummary(cacheSetting);
	}

	private async updateCacheSummary(setting: Setting): Promise<void> {
		const stats = await this.cache.stats();
		const kilobytes = Math.round(stats.bytes / 1024);
		setting.setDesc(
			`${stats.entries} cached diagram(s), ${kilobytes} KB. Rendered SVGs are cached by content hash, so unchanged blocks never recompile.`,
		);
	}
}
