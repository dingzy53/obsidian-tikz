/**
 * Obsidian wiring for the `tikz` code block: loading state, cache lookup,
 * compile orchestration, error UI and SVG injection.
 *
 * Runs on both platforms. On desktop (`deps.desktop` set) a block is compiled
 * and cached locally, and mirrored into the shared folder when sharing is on.
 * On mobile there is no compiler: a block is shown from the shared folder, or
 * as "not rendered yet" until a desktop puts it there. No Node imports here
 * (AGENTS.md rule 1); the desktop services arrive through `deps`.
 */

import { MarkdownRenderChild, Notice } from "obsidian";
import type { MarkdownPostProcessorContext, Plugin } from "obsidian";
import type { CompileFailure, CompileResult } from "./compiler/engineSpecs";
import { normalizePreamble, tidyTikzSource } from "./compiler/wrapSource";
import type { DesktopServices } from "./desktop";
import { Limiter, resolveConcurrency } from "./limiter";
import type { TikzSettings } from "./settingsModel";
import { computeSharedKey } from "./shared/sharedKey";
import type { SharedDiagramStore } from "./sharedStore";
import { prepareSvgForDisplay } from "./svg";

/** Fence language tag. Unchanged from the upstream plugin, on purpose. */
export const CODE_BLOCK_LANGUAGE = "tikz";

/**
 * Obsidian tags `<body>` with `theme-dark` / `theme-light`, and fires
 * `css-change` when that flips (including on a mid-session theme switch).
 *
 * Read from the diagram's own window (`el.doc`), never `activeDocument`: when
 * the theme is switched in Obsidian 1.15's separate Settings window, that is
 * the active one, and its class flips before the note window's, so
 * `css-change` would redraw every diagram for the old theme.
 *
 * Guarded because an unusual host may not expose `body`; a failure here must
 * never cost the user their diagram.
 */
export function isDarkTheme(el: Node): boolean {
	try {
		return el.doc.body.classList.contains("theme-dark");
	} catch {
		return false;
	}
}

export interface RenderDeps {
	getSettings(): TikzSettings;
	/** Compiler and local cache; undefined on mobile. */
	desktop: DesktopServices | undefined;
	/** The shared (synced) folder: written on desktop, read on mobile. */
	shared: SharedDiagramStore;
	openSettings(): void;
	/**
	 * Opens the zoomable viewer. `svg` is already sanitised by
	 * `prepareSvgForDisplay` (AGENTS.md rule 7).
	 */
	openZoom(svg: string, lightCanvas: boolean): void;
}

export interface TikzRenderer {
	/** Re-applies display-time post-processing to every mounted diagram. */
	refreshAll(): void;
	/** Mobile: re-reads every diagram from the shared folder (it moved). */
	reloadShared(): void;
}

/**
 * In-flight compiles, keyed by cache key. Scrolling past several identical
 * blocks must not spawn several identical TeX processes (plan §6.6): the
 * second block with the same content shares the first one's promise.
 */
const inFlight = new Map<string, Promise<CompileResult>>();

/**
 * Bounds how many TeX processes run at once. The compile timeout only starts
 * when a task gets its slot, so time spent queued never counts against it.
 */
const compileLimiter = new Limiter(1);

/**
 * Compiles `source` (once per `key` at a time, within the concurrency limit)
 * and stores a success in the local cache. Shared by the renderer and the
 * "Render all for mobile" pass.
 */
export function startCompile(
	key: string,
	source: string,
	settings: TikzSettings,
	desktop: DesktopServices,
): Promise<CompileResult> {
	const existing = inFlight.get(key);
	if (existing) return existing;

	compileLimiter.setMax(resolveConcurrency(settings.maxConcurrentCompiles, desktop.cpuCount()));

	const promise = (async (): Promise<CompileResult> => {
		const result = await compileLimiter.run(() =>
			desktop.compile({
				source,
				preamble: normalizePreamble(settings.defaultPreamble),
				engine: settings.engine,
				enginePath: settings.enginePath,
				dvisvgmPath: settings.dvisvgmPath,
				extraPathDirs: settings.extraPathDirs,
				allowShellEscape: settings.allowShellEscape,
				timeoutMs: settings.compileTimeoutSeconds * 1000,
			}),
		);
		// Persisted here rather than in the component: a block that scrolls
		// away or is re-rendered mid-compile must not throw away a finished
		// (and expensive) compile.
		if (result.ok) {
			await desktop.cache.set(key, result.svg).catch((error: unknown) => {
				console.warn("[tikz] Could not write the diagram cache.", error);
			});
		}
		return result;
	})().finally(() => {
		inFlight.delete(key);
	});

	inFlight.set(key, promise);
	return promise;
}

/**
 * Extends `MarkdownRenderChild` because that is what
 * `MarkdownPostProcessorContext.addChild` accepts, and it ties this
 * component's lifetime to the rendered block: a note closed mid-compile
 * unloads it, so the async compile cannot touch a detached element.
 */
class DiagramRenderComponent extends MarkdownRenderChild {
	private unloaded = false;
	private readonly container: HTMLElement;
	private rawSvg: string | null = null;
	/** Local cache key on desktop, shared key on mobile; also names the SVG ids. */
	private cacheKey = "";
	/** Key of this block in the shared folder; computed lazily on desktop. */
	private sharedKey = "";
	private loadingTimer: number | null = null;
	/** {@link displayKey} of what is currently on screen. */
	private shownKey = "";
	/** True only while a diagram (not a spinner or an error) is on screen. */
	private zoomable = false;

	constructor(
		containerEl: HTMLElement,
		private readonly source: string,
		private readonly deps: RenderDeps,
		private readonly onUnload: () => void,
	) {
		super(containerEl);
		this.container = containerEl.createDiv({ cls: "tikz-container" });
	}

	onload(): void {
		// Registered once on the container, which outlives every re-render;
		// the handlers check `zoomable` so a spinner or an error never opens
		// the viewer.
		this.registerDomEvent(this.container, "click", (evt) => {
			if (!this.canZoom()) return;
			// In Live Preview a click on the widget would otherwise move the
			// cursor into the code block and reveal its source.
			evt.preventDefault();
			evt.stopPropagation();
			this.openZoom();
		});
		this.registerDomEvent(this.container, "keydown", (evt) => {
			if (evt.key !== "Enter" && evt.key !== " ") return;
			if (!this.canZoom() || evt.target !== this.container) return;
			evt.preventDefault();
			evt.stopPropagation();
			this.openZoom();
		});

		// On a phone, a diagram that a desktop renders (or re-renders) shows
		// up as soon as sync delivers the file, without reopening the note.
		if (!this.deps.desktop) {
			this.register(
				this.deps.shared.onChange((key) => {
					if (this.unloaded || key !== this.sharedKey) return;
					this.renderFromShared(false).catch((error: unknown) => this.failUnexpectedly(error));
				}),
			);
		}

		// `render()` handles its own failures; this catch is the last line of
		// defence so a bug can never leave the loading spinner running.
		this.render().catch((error: unknown) => this.failUnexpectedly(error));
	}

	onunload(): void {
		this.unloaded = true;
		this.stopLoadingTimer();
		this.onUnload();
	}

	/**
	 * Re-runs display-time post-processing from the already-compiled SVG.
	 *
	 * `css-change` fires for far more than theme switches (any snippet or
	 * accent change), and the SVGO pass is not free, so this is a no-op unless
	 * something the output depends on actually changed.
	 */
	redraw(): void {
		if (!this.rawSvg) return;
		if (this.displayKey(this.deps.getSettings()) === this.shownKey) return;
		this.inject(this.rawSvg);
	}

	/** Mobile: the shared folder changed, so look the diagram up again. */
	reloadShared(): void {
		if (this.deps.desktop || this.unloaded || !this.sharedKey) return;
		this.rawSvg = null;
		this.renderFromShared(true).catch((error: unknown) => this.failUnexpectedly(error));
	}

	/** Everything display-time processing depends on besides the SVG itself. */
	private displayKey(settings: TikzSettings): string {
		return `${settings.colorAdaptation}|${isDarkTheme(this.container)}|${settings.zoomOnClick}`;
	}

	private stopLoadingTimer(): void {
		if (this.loadingTimer !== null) {
			window.clearInterval(this.loadingTimer);
			this.loadingTimer = null;
		}
	}

	private canZoom(): boolean {
		return this.zoomable && this.rawSvg !== null && this.deps.getSettings().zoomOnClick;
	}

	/** Makes the container a button only while it shows a diagram and the setting is on. */
	private setZoomable(zoomable: boolean): void {
		this.zoomable = zoomable;
		const on = zoomable && this.deps.getSettings().zoomOnClick;
		this.container.toggleClass("tikz-zoomable", on);
		if (on) {
			this.container.setAttribute("role", "button");
			this.container.setAttribute("tabindex", "0");
			this.container.setAttribute("aria-label", "Open diagram viewer");
		} else {
			this.container.removeAttribute("role");
			this.container.removeAttribute("tabindex");
			this.container.removeAttribute("aria-label");
		}
	}

	/**
	 * Rebuilt from the raw SVG on every open, so the viewer follows the
	 * current theme and colour setting. The id prefix differs from the inline
	 * copy's because both are in the document while the viewer is open.
	 */
	private openZoom(): void {
		if (!this.rawSvg) return;
		const settings = this.deps.getSettings();
		const isDark = isDarkTheme(this.container);
		let prepared: string;
		try {
			prepared = prepareSvgForDisplay(
				this.rawSvg,
				`tikz-zoom-${this.cacheKey.slice(0, 8)}-`,
				settings.colorAdaptation,
				isDark,
			);
		} catch (error) {
			console.error("[tikz] Could not prepare the diagram for the viewer.", error);
			new Notice("Could not open the diagram viewer.");
			return;
		}
		this.deps.openZoom(prepared, settings.colorAdaptation === "light-canvas" && isDark);
	}

	private showLoading(text = "Compiling diagram…"): void {
		this.stopLoadingTimer();
		this.setZoomable(false);
		this.container.empty();
		const box = this.container.createDiv({ cls: "tikz-loading" });
		const started = Date.now();
		const label = box.createSpan({ text });

		// Compiles are no longer near-instant, so show that time is passing
		// rather than letting the block look frozen.
		this.loadingTimer = window.setInterval(() => {
			const seconds = Math.round((Date.now() - started) / 1000);
			label.setText(`${text} ${seconds}s`);
		}, 500);
	}

	private async render(): Promise<void> {
		const desktop = this.deps.desktop;
		if (!desktop) {
			this.sharedKey = await computeSharedKey(tidyTikzSource(this.source));
			this.cacheKey = this.sharedKey;
			await this.renderFromShared(true);
			return;
		}

		const settings = this.deps.getSettings();
		const tidied = tidyTikzSource(this.source);
		const preamble = normalizePreamble(settings.defaultPreamble);
		this.cacheKey = desktop.localKey({
			source: tidied,
			preamble,
			engine: settings.engine,
		});

		this.showLoading();

		const cached = await desktop.cache.get(this.cacheKey);
		if (this.unloaded) return;
		if (cached) {
			this.stopLoadingTimer();
			this.rawSvg = cached;
			this.inject(cached);
			this.share(tidied, cached, true);
			return;
		}

		const result = await startCompile(this.cacheKey, this.source, settings, desktop);
		if (this.unloaded) return;
		this.stopLoadingTimer();

		if (result.ok) {
			this.rawSvg = result.svg;
			this.inject(result.svg);
			this.share(tidied, result.svg, false);
			return;
		}

		this.showError(result);
	}

	/**
	 * Desktop with sharing on: mirrors the render into the shared folder. A
	 * cache hit only fills a gap; a fresh compile also replaces an outdated
	 * file (the store skips identical content). Fire and forget: sharing must
	 * never break rendering.
	 */
	private share(tidied: string, svg: string, onlyIfMissing: boolean): void {
		if (!this.deps.getSettings().shareWithMobile) return;
		const shared = this.deps.shared;
		void (async () => {
			const key = await computeSharedKey(tidied);
			if (onlyIfMissing && (await shared.has(key))) return;
			await shared.write(key, svg);
		})().catch((error: unknown) => {
			console.warn("[tikz] Could not write the shared diagram.", error);
		});
	}

	/** Mobile: show the diagram a desktop put in the shared folder. */
	private async renderFromShared(showSpinner: boolean): Promise<void> {
		if (showSpinner) this.showLoading("Loading diagram…");
		const svg = await this.deps.shared.read(this.sharedKey);
		if (this.unloaded) return;
		this.stopLoadingTimer();
		if (svg) {
			if (svg === this.rawSvg) return;
			this.rawSvg = svg;
			this.inject(svg);
			return;
		}
		if (this.rawSvg) return;
		this.showPending();
	}

	/**
	 * Mobile, no shared file yet. Not an error: nothing was compiled, there is
	 * just no render to show until a desktop provides one.
	 */
	private showPending(): void {
		this.setZoomable(false);
		this.container.empty();
		this.container.classList.remove("tikz-light-canvas");
		const box = this.container.createDiv({ cls: "tikz-pending" });
		box.createDiv({ cls: "tikz-pending-summary", text: "TikZ diagram not rendered yet" });
		box.createDiv({
			cls: "tikz-pending-hint",
			text:
				"Phones cannot compile TikZ. Turn on “Share diagrams with mobile” on a desktop, then open " +
				"this note there or use “Render all for mobile”. The diagram appears here once it syncs.",
		});
	}

	private inject(svg: string): void {
		const settings = this.deps.getSettings();
		const isDark = isDarkTheme(this.container);
		// Namespacing ids per diagram keeps multiple inline diagrams from
		// resolving each other's glyph references.
		const prefix = `tikz-${this.cacheKey.slice(0, 8)}-`;
		this.shownKey = this.displayKey(settings);

		let element: Element;
		try {
			const prepared = prepareSvgForDisplay(svg, prefix, settings.colorAdaptation, isDark);
			// Parse as XML and adopt the nodes, instead of `innerHTML`: the HTML
			// parser and an XML serialiser can disagree about the same markup,
			// which is the classic way a sanitised SVG turns hostile again.
			const doc = new DOMParser().parseFromString(prepared, "image/svg+xml");
			if (doc.getElementsByTagName("parsererror").length > 0) {
				throw new Error("the sanitised SVG is not well-formed XML");
			}
			// The diagram's own window (`doc`), which may be a popout.
			element = this.container.doc.importNode(doc.documentElement, true);
		} catch (error) {
			this.showDisplayError(error);
			return;
		}

		this.container.classList.toggle(
			"tikz-light-canvas",
			settings.colorAdaptation === "light-canvas" && isDark,
		);
		this.container.empty();
		this.container.appendChild(element);
		this.setZoomable(true);
	}

	private failUnexpectedly(error: unknown): void {
		console.error("[tikz] Rendering failed unexpectedly.", error);
		this.stopLoadingTimer();
		if (this.unloaded) return;
		this.showDisplayError(error);
	}

	/** The diagram could not be shown (rejected SVG, I/O failure, internal error). */
	private showDisplayError(error: unknown): void {
		this.setZoomable(false);
		this.container.empty();
		this.container.classList.remove("tikz-light-canvas");
		const box = this.container.createDiv({ cls: "tikz-error" });
		box.createDiv({
			cls: "tikz-error-summary",
			text: "TikZ diagram could not be displayed",
		});
		box.createDiv({
			cls: "tikz-error-hint",
			text: error instanceof Error ? error.message : String(error),
		});
	}

	private showError(failure: CompileFailure): void {
		this.setZoomable(false);
		this.container.empty();
		const box = this.container.createDiv({ cls: "tikz-error" });

		box.createDiv({
			cls: "tikz-error-summary",
			text: `TikZ compile failed — ${failure.summary}`,
		});

		if (failure.hint) {
			box.createDiv({ cls: "tikz-error-hint", text: failure.hint });
		}

		const logDetails = box.createEl("details");
		logDetails.createEl("summary", { text: "Show compiler log" });
		logDetails.createEl("pre", { cls: "tikz-log", text: failure.log });

		const sourceDetails = box.createEl("details");
		sourceDetails.createEl("summary", { text: "Show generated LaTeX" });
		sourceDetails.createEl("pre", { cls: "tikz-log", text: failure.tex });

		const actions = box.createDiv({ cls: "tikz-error-actions" });

		actions.createEl("button", { text: "Copy log" }).onclick = () => {
			void navigator.clipboard
				.writeText(failure.log)
				.then(() => new Notice("Compiler log copied."))
				.catch(() => new Notice("Could not copy the log to the clipboard."));
		};

		actions.createEl("button", { text: "Open settings" }).onclick = () => {
			this.deps.openSettings();
		};

		if (failure.workDir) {
			actions.createEl("button", { text: "Reveal build folder" }).onclick = () => {
				this.deps.desktop?.revealPath(failure.workDir);
			};
		}
	}
}

export function registerTikzProcessor(plugin: Plugin, deps: RenderDeps): TikzRenderer {
	const mounted = new Set<DiagramRenderComponent>();

	plugin.registerMarkdownCodeBlockProcessor(CODE_BLOCK_LANGUAGE, (source, el, ctx: MarkdownPostProcessorContext) => {
		// Managed by the post-processor context so a note closed mid-compile
		// cannot leave an update pointing at a detached element (plan §6.6).
		const component = new DiagramRenderComponent(el, source, deps, () => {
			mounted.delete(component);
		});
		mounted.add(component);
		ctx.addChild(component);
	});

	return {
		refreshAll(): void {
			for (const component of mounted) component.redraw();
		},
		reloadShared(): void {
			for (const component of mounted) component.reloadShared();
		},
	};
}
