/**
 * The diagram viewer: a modal that shows one diagram large, with zoom and pan.
 * The maths lives in `zoom.ts`; this is only the Obsidian and DOM wiring.
 */

import { Modal, setIcon, setTooltip } from "obsidian";
import type { App } from "obsidian";
import {
	ZOOM_STEP,
	centred,
	fitScale,
	pan,
	wheelFactor,
	zoomAt,
	zoomTo,
	type Point,
	type Size,
	type ZoomState,
} from "./zoom";

/** Double-click zooms to this scale when the diagram is fitted, and back otherwise. */
const DOUBLE_CLICK_SCALE = 2;

export class DiagramZoomModal extends Modal {
	private viewport: HTMLElement | null = null;
	private stage: HTMLElement | null = null;
	private svg: SVGSVGElement | null = null;
	private zoomLabel: HTMLElement | null = null;
	private natural: Size = { width: 1, height: 1 };
	private state: ZoomState = { scale: 1, x: 0, y: 0 };
	/** Once the user zooms or pans, a window resize stops re-fitting. */
	private touched = false;
	private resizeObserver: ResizeObserver | null = null;
	private drag: { pointerId: number; x: number; y: number } | null = null;

	/**
	 * @param svgMarkup Output of `prepareSvgForDisplay`, i.e. already
	 *   sanitised, with ids prefixed differently from the inline copy.
	 * @param lightCanvas Show the diagram on a white panel, as the inline
	 *   diagram does in "light canvas" mode on a dark theme.
	 */
	constructor(
		app: App,
		private readonly svgMarkup: string,
		private readonly lightCanvas: boolean,
	) {
		super(app);
	}

	onOpen(): void {
		this.modalEl.addClass("tikz-zoom-modal");
		this.contentEl.empty();

		this.buildToolbar(this.contentEl.createDiv({ cls: "tikz-zoom-toolbar" }));

		const viewport = this.contentEl.createDiv({ cls: "tikz-zoom-viewport" });
		const stage = viewport.createDiv({ cls: "tikz-zoom-stage" });
		stage.toggleClass("tikz-light-canvas", this.lightCanvas);
		this.viewport = viewport;
		this.stage = stage;

		// Same adoption path as the inline diagram (`render.ts`): parse as XML
		// and import the nodes, never `innerHTML` (AGENTS.md rule 7).
		const doc = new DOMParser().parseFromString(this.svgMarkup, "image/svg+xml");
		const root = doc.documentElement;
		if (doc.getElementsByTagName("parsererror").length > 0 || root.localName !== "svg") {
			viewport.empty();
			viewport.createDiv({ cls: "tikz-error-hint", text: "The diagram could not be displayed." });
			return;
		}
		const svg = document.importNode(root, true) as unknown as SVGSVGElement;
		stage.appendChild(svg);
		this.svg = svg;
		this.natural = naturalSize(svg);

		this.registerInput(viewport);
		this.registerKeys();

		this.resizeObserver = new ResizeObserver(() => {
			if (!this.touched) this.fit();
		});
		this.resizeObserver.observe(viewport);
		this.fit();
	}

	onClose(): void {
		this.resizeObserver?.disconnect();
		this.resizeObserver = null;
		this.contentEl.empty();
		this.viewport = this.stage = this.svg = this.zoomLabel = null;
	}

	private buildToolbar(toolbar: HTMLElement): void {
		const button = (icon: string, label: string, action: () => void): void => {
			const el = toolbar.createEl("button", { cls: "clickable-icon tikz-zoom-button" });
			setIcon(el, icon);
			el.setAttribute("aria-label", label);
			setTooltip(el, label);
			el.addEventListener("click", action);
		};

		button("zoom-out", "Zoom out (−)", () => this.zoomBy(1 / ZOOM_STEP));
		this.zoomLabel = toolbar.createSpan({ cls: "tikz-zoom-level" });
		button("zoom-in", "Zoom in (+)", () => this.zoomBy(ZOOM_STEP));
		button("scan", "Fit to window (0)", () => this.fit());

		const actual = toolbar.createEl("button", { cls: "tikz-zoom-actual", text: "100%" });
		actual.setAttribute("aria-label", "Actual size (1)");
		setTooltip(actual, "Actual size (1)");
		actual.addEventListener("click", () => this.actualSize());
	}

	private registerInput(viewport: HTMLElement): void {
		// Not passive: the default would scroll the modal instead of zooming.
		viewport.addEventListener(
			"wheel",
			(evt) => {
				evt.preventDefault();
				this.touched = true;
				this.apply(zoomAt(this.state, wheelFactor(evt.deltaY, evt.deltaMode), this.localPoint(evt)));
			},
			{ passive: false },
		);

		viewport.addEventListener("pointerdown", (evt) => {
			if (evt.button !== 0) return;
			this.drag = { pointerId: evt.pointerId, x: evt.clientX, y: evt.clientY };
			viewport.setPointerCapture(evt.pointerId);
			viewport.addClass("is-dragging");
		});
		viewport.addEventListener("pointermove", (evt) => {
			if (!this.drag || evt.pointerId !== this.drag.pointerId) return;
			const dx = evt.clientX - this.drag.x;
			const dy = evt.clientY - this.drag.y;
			this.drag.x = evt.clientX;
			this.drag.y = evt.clientY;
			if (dx === 0 && dy === 0) return;
			this.touched = true;
			this.apply(pan(this.state, dx, dy));
		});
		const endDrag = (evt: PointerEvent): void => {
			if (!this.drag || evt.pointerId !== this.drag.pointerId) return;
			this.drag = null;
			if (viewport.hasPointerCapture(evt.pointerId)) viewport.releasePointerCapture(evt.pointerId);
			viewport.removeClass("is-dragging");
		};
		viewport.addEventListener("pointerup", endDrag);
		viewport.addEventListener("pointercancel", endDrag);

		viewport.addEventListener("dblclick", (evt) => {
			evt.preventDefault();
			this.touched = true;
			const fitted = fitScale(this.natural, this.viewportSize());
			const target = Math.abs(this.state.scale - fitted) < 0.01 ? Math.max(DOUBLE_CLICK_SCALE, fitted * 2) : fitted;
			if (target === fitted) {
				this.fit();
			} else {
				this.apply(zoomTo(this.state, target, this.localPoint(evt)));
			}
		});
	}

	private registerKeys(): void {
		// `null` modifiers: match the key whatever modifiers are held, so `+`
		// works with or without Shift on any layout. Returning false stops the
		// event from reaching the editor underneath.
		for (const key of ["+", "="]) {
			this.scope.register(null, key, () => {
				this.zoomBy(ZOOM_STEP);
				return false;
			});
		}
		for (const key of ["-", "_"]) {
			this.scope.register(null, key, () => {
				this.zoomBy(1 / ZOOM_STEP);
				return false;
			});
		}
		this.scope.register(null, "0", () => {
			this.fit();
			return false;
		});
		this.scope.register(null, "1", () => {
			this.actualSize();
			return false;
		});
	}

	private fit(): void {
		const viewport = this.viewportSize();
		this.apply(centred(fitScale(this.natural, viewport), this.natural, viewport));
		// A fit is not a user adjustment, but an explicit one (button or key)
		// after zooming should resume following window resizes.
		this.touched = false;
	}

	private actualSize(): void {
		this.touched = true;
		this.apply(centred(1, this.natural, this.viewportSize()));
	}

	/** Toolbar and keyboard zoom, anchored at the viewport centre. */
	private zoomBy(factor: number): void {
		this.touched = true;
		const { width, height } = this.viewportSize();
		this.apply(zoomAt(this.state, factor, { x: width / 2, y: height / 2 }));
	}

	private apply(state: ZoomState): void {
		this.state = state;
		if (!this.svg || !this.stage) return;
		// Zoom by resizing the SVG rather than with a CSS `scale()`: the browser
		// then re-renders the vectors, while a scaled layer can stay blurry.
		// These are per-frame computed values, so they cannot be CSS classes.
		this.svg.setCssStyles({
			width: `${this.natural.width * state.scale}px`,
			height: `${this.natural.height * state.scale}px`,
		});
		this.stage.setCssStyles({ transform: `translate(${state.x}px, ${state.y}px)` });
		this.zoomLabel?.setText(`${Math.round(state.scale * 100)}%`);
	}

	private viewportSize(): Size {
		// `clientWidth` ignores the modal's open animation (a CSS transform),
		// where `getBoundingClientRect()` would not.
		return {
			width: this.viewport?.clientWidth ?? 0,
			height: this.viewport?.clientHeight ?? 0,
		};
	}

	private localPoint(evt: MouseEvent): Point {
		const rect = this.viewport?.getBoundingClientRect();
		if (!rect || !this.viewport || rect.width === 0) return { x: 0, y: 0 };
		// Convert from (possibly transformed) screen pixels to layout pixels.
		const sx = this.viewport.clientWidth / rect.width;
		const sy = this.viewport.clientHeight / rect.height;
		return { x: (evt.clientX - rect.left) * sx, y: (evt.clientY - rect.top) * sy };
	}
}

/**
 * The SVG's size at 100%, in CSS pixels. dvisvgm writes `width`/`height` in pt;
 * `baseVal.value` converts absolute units to px without needing layout (which
 * the modal's open animation would distort). Falls back to the viewBox.
 */
function naturalSize(svg: SVGSVGElement): Size {
	const fromAttributes = (): Size | null => {
		try {
			const width = svg.width.baseVal;
			const height = svg.height.baseVal;
			const percent = SVGLength.SVG_LENGTHTYPE_PERCENTAGE;
			if (width.unitType === percent || height.unitType === percent) return null;
			if (width.value > 0 && height.value > 0) return { width: width.value, height: height.value };
		} catch {
			// Not an SVG element with lengths; use the viewBox.
		}
		return null;
	};
	const sized = fromAttributes();
	if (sized) return sized;
	const box = svg.viewBox?.baseVal;
	if (box && box.width > 0 && box.height > 0) return { width: box.width, height: box.height };
	return { width: 300, height: 150 };
}
