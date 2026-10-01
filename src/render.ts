/**
 * Obsidian wiring for the `tikz` code block: loading state, cache lookup,
 * compile orchestration, error UI and SVG injection.
 *
 * This is the only module that knows about Obsidian, apart from `main.ts` and
 * `settings.ts`.
 */

import { MarkdownRenderChild, Notice } from "obsidian";
import type { MarkdownPostProcessorContext, Plugin } from "obsidian";
import { computeCacheKey, DiagramCache } from "./cache";
import {
	compileTikz,
	normalizePreamble,
	tidyTikzSource,
	type CompileFailure,
	type CompileResult,
} from "./compiler";
import type { TikzSettings } from "./settings";
import { prepareSvgForDisplay } from "./svg";

/** Fence language tag. Unchanged from the upstream plugin, on purpose. */
export const CODE_BLOCK_LANGUAGE = "tikz";

/**
 * Obsidian tags `<body>` with `theme-dark` / `theme-light`, and fires
 * `css-change` when that flips (including on a mid-session theme switch).
 *
 * Guarded because a popped-out window or an unusual host may not expose
 * `document.body`; a failure here must never cost the user their diagram.
 */
export function isDarkTheme(): boolean {
	try {
		return document.body.classList.contains("theme-dark");
	} catch {
		return false;
	}
}

export interface RenderDeps {
	getSettings(): TikzSettings;
	cache: DiagramCache;
	openSettings(): void;
	/** Opens a folder in the OS file manager. */
	revealPath(path: string): void;
}

export interface TikzRenderer {
	/** Re-applies display-time post-processing to every mounted diagram. */
	refreshAll(): void;
}

/**
 * In-flight compiles, keyed by cache key. Scrolling past several identical
 * blocks must not spawn several identical TeX processes (plan §6.6): the
 * second block with the same content shares the first one's promise.
 */
const inFlight = new Map<string, Promise<CompileResult>>();

function startCompile(
	key: string,
	source: string,
	settings: TikzSettings,
): Promise<CompileResult> {
	const existing = inFlight.get(key);
	if (existing) return existing;

	const promise = compileTikz({
		source,
		preamble: normalizePreamble(settings.defaultPreamble),
		engine: settings.engine,
		enginePath: settings.enginePath,
		dvisvgmPath: settings.dvisvgmPath,
		extraPathDirs: settings.extraPathDirs,
		allowShellEscape: settings.allowShellEscape,
		timeoutMs: settings.compileTimeoutSeconds * 1000,
	}).finally(() => {
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
	private cacheKey = "";
	private loadingTimer: number | null = null;

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
		void this.render();
	}

	onunload(): void {
		this.unloaded = true;
		this.stopLoadingTimer();
		this.onUnload();
	}

	/** Re-runs display-time post-processing from the already-compiled SVG. */
	redraw(): void {
		if (this.rawSvg) this.inject(this.rawSvg);
	}

	private stopLoadingTimer(): void {
		if (this.loadingTimer !== null) {
			window.clearInterval(this.loadingTimer);
			this.loadingTimer = null;
		}
	}

	private showLoading(): void {
		this.container.empty();
		const box = this.container.createDiv({ cls: "tikz-loading" });
		const started = Date.now();
		const label = box.createSpan({ text: "Compiling diagram…" });

		// Compiles are no longer near-instant, so show that time is passing
		// rather than letting the block look frozen.
		this.loadingTimer = window.setInterval(() => {
			const seconds = Math.round((Date.now() - started) / 1000);
			label.setText(`Compiling diagram… ${seconds}s`);
		}, 500);
	}

	private async render(): Promise<void> {
		const settings = this.deps.getSettings();
		const tidied = tidyTikzSource(this.source);
		const preamble = normalizePreamble(settings.defaultPreamble);
		this.cacheKey = computeCacheKey({
			source: tidied,
			preamble,
			engine: settings.engine,
		});

		this.showLoading();

		const cached = await this.deps.cache.get(this.cacheKey);
		if (this.unloaded) return;
		if (cached) {
			this.stopLoadingTimer();
			this.rawSvg = cached;
			this.inject(cached);
			return;
		}

		const result = await startCompile(this.cacheKey, this.source, settings);
		if (this.unloaded) return;
		this.stopLoadingTimer();

		if (result.ok) {
			await this.deps.cache.set(this.cacheKey, result.svg);
			if (this.unloaded) return;
			this.rawSvg = result.svg;
			this.inject(result.svg);
			return;
		}

		await this.deps.cache.setLog(this.cacheKey, result.log);
		if (this.unloaded) return;
		this.showError(result);
	}

	private inject(svg: string): void {
		const settings = this.deps.getSettings();
		const isDark = isDarkTheme();
		// Namespacing ids per diagram keeps multiple inline diagrams from
		// resolving each other's glyph references.
		const prefix = `tikz-${this.cacheKey.slice(0, 8)}-`;
		const prepared = prepareSvgForDisplay(svg, prefix, settings.colorAdaptation, isDark);
		this.container.classList.toggle(
			"tikz-light-canvas",
			settings.colorAdaptation === "light-canvas" && isDark,
		);
		this.container.empty();
		this.container.innerHTML = prepared;
	}

	private showError(failure: CompileFailure): void {
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
				this.deps.revealPath(failure.workDir);
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
	};
}
