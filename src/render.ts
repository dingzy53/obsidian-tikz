/**
 * Obsidian wiring for the `tikz` code block: loading state, cache lookup,
 * compile orchestration, error UI and SVG injection.
 *
 * This is the only module that knows about Obsidian, apart from `main.ts` and
 * `settings.ts`.
 */

import * as os from "node:os";
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
import { Limiter, resolveConcurrency } from "./limiter";
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

/**
 * Bounds how many TeX processes run at once. The compile timeout only starts
 * when a task gets its slot, so time spent queued never counts against it.
 */
const compileLimiter = new Limiter(1);

function startCompile(
	key: string,
	source: string,
	settings: TikzSettings,
	cache: DiagramCache,
): Promise<CompileResult> {
	const existing = inFlight.get(key);
	if (existing) return existing;

	compileLimiter.setMax(resolveConcurrency(settings.maxConcurrentCompiles, os.cpus().length));

	const promise = (async (): Promise<CompileResult> => {
		const result = await compileLimiter.run(() =>
			compileTikz({
				source,
				preamble: normalizePreamble(settings.defaultPreamble),
				engine: settings.engine,
				enginePath: settings.enginePath,
				dvisvgmPath: settings.dvisvgmPath,
				extraPathDirs: settings.extraPathDirs,
				allowShellEscape: settings.allowShellEscape,
				restrictFileAccess: settings.restrictFileAccess,
				timeoutMs: settings.compileTimeoutSeconds * 1000,
			}),
		);
		// Persisted here rather than in the component: a block that scrolls
		// away or is re-rendered mid-compile must not throw away a finished
		// (and expensive) compile.
		if (result.ok) {
			await cache.set(key, result.svg).catch((error: unknown) => {
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
	private cacheKey = "";
	private loadingTimer: number | null = null;
	/** {@link displayKey} of what is currently on screen. */
	private shownKey = "";

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

	/** Everything display-time processing depends on besides the SVG itself. */
	private displayKey(settings: TikzSettings): string {
		return `${settings.colorAdaptation}|${isDarkTheme()}`;
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

		const result = await startCompile(this.cacheKey, this.source, settings, this.deps.cache);
		if (this.unloaded) return;
		this.stopLoadingTimer();

		if (result.ok) {
			this.rawSvg = result.svg;
			this.inject(result.svg);
			return;
		}

		this.showError(result);
	}

	private inject(svg: string): void {
		const settings = this.deps.getSettings();
		const isDark = isDarkTheme();
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
			element = document.importNode(doc.documentElement, true);
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
	}

	private failUnexpectedly(error: unknown): void {
		console.error("[tikz] Rendering failed unexpectedly.", error);
		this.stopLoadingTimer();
		if (this.unloaded) return;
		this.showDisplayError(error);
	}

	/** The diagram could not be shown (rejected SVG, I/O failure, internal error). */
	private showDisplayError(error: unknown): void {
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
