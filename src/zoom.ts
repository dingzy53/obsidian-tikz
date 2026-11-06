/**
 * Pure maths for the diagram viewer's zoom and pan. No `import "obsidian"` and
 * no DOM, so it is unit-testable; `zoomModal.ts` is the wiring.
 *
 * `scale` is relative to the SVG's natural size, and `x`/`y` are where the
 * content's top-left corner sits inside the viewport, in CSS pixels.
 */

export interface Size {
	width: number;
	height: number;
}

export interface Point {
	x: number;
	y: number;
}

export interface ZoomState {
	scale: number;
	x: number;
	y: number;
}

export const MIN_SCALE = 0.1;
export const MAX_SCALE = 16;

/** Multiplier for one toolbar / keyboard zoom step. */
export const ZOOM_STEP = 1.25;

/** Gap kept around a fitted diagram, in CSS pixels. */
export const FIT_PADDING = 24;

export function clampScale(scale: number): number {
	if (!Number.isFinite(scale) || scale <= 0) return 1;
	return Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale));
}

/**
 * The largest scale at which the whole diagram fits. It deliberately goes above
 * 1: a small diagram should fill the viewer, since readable text is the point.
 */
export function fitScale(content: Size, viewport: Size, padding = FIT_PADDING): number {
	if (content.width <= 0 || content.height <= 0) return 1;
	const width = Math.max(1, viewport.width - 2 * padding);
	const height = Math.max(1, viewport.height - 2 * padding);
	return clampScale(Math.min(width / content.width, height / content.height));
}

/** The diagram at `scale`, centred in the viewport. */
export function centred(scale: number, content: Size, viewport: Size): ZoomState {
	const s = clampScale(scale);
	return {
		scale: s,
		x: (viewport.width - content.width * s) / 2,
		y: (viewport.height - content.height * s) / 2,
	};
}

/**
 * Zooms by `factor` while keeping the content under `point` (viewport
 * coordinates) where it is, which is what makes wheel zoom feel anchored to
 * the cursor. At a scale limit the state is returned unchanged.
 */
export function zoomAt(state: ZoomState, factor: number, point: Point): ZoomState {
	const scale = clampScale(state.scale * factor);
	const ratio = scale / state.scale;
	return {
		scale,
		x: point.x - (point.x - state.x) * ratio,
		y: point.y - (point.y - state.y) * ratio,
	};
}

/** Zooms to an absolute scale, anchored at `point`. */
export function zoomTo(state: ZoomState, scale: number, point: Point): ZoomState {
	return zoomAt(state, clampScale(scale) / state.scale, point);
}

export function pan(state: ZoomState, dx: number, dy: number): ZoomState {
	return { scale: state.scale, x: state.x + dx, y: state.y + dy };
}

/** `WheelEvent.deltaMode` values. */
const DOM_DELTA_LINE = 1;
const DOM_DELTA_PAGE = 2;

/** Pixel equivalents for line- and page-based wheel deltas. */
const LINE_PIXELS = 16;
const PAGE_PIXELS = 800;

/** How strongly one pixel of wheel delta zooms. */
const WHEEL_SENSITIVITY = 0.002;

/** Wheel events can carry huge deltas (fast flicks); one event zooms at most this much. */
const MAX_WHEEL_FACTOR = 2;

/**
 * Zoom factor for one wheel event. Scrolling up (negative `deltaY`) zooms in.
 * A trackpad pinch arrives as a `wheel` event with `ctrlKey` set and small
 * deltas, so it goes through the same path.
 */
export function wheelFactor(deltaY: number, deltaMode = 0): number {
	if (!Number.isFinite(deltaY)) return 1;
	const pixels =
		deltaMode === DOM_DELTA_LINE
			? deltaY * LINE_PIXELS
			: deltaMode === DOM_DELTA_PAGE
				? deltaY * PAGE_PIXELS
				: deltaY;
	const factor = Math.exp(-pixels * WHEEL_SENSITIVITY);
	return Math.min(MAX_WHEEL_FACTOR, Math.max(1 / MAX_WHEEL_FACTOR, factor));
}

function midpoint(a: Point, b: Point): Point {
	return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

function distance(a: Point, b: Point): number {
	return Math.hypot(a.x - b.x, a.y - b.y);
}

/**
 * Two-finger pinch on a touch screen: scales by the change in finger distance
 * and pans with the fingers' midpoint, so the content between the fingers
 * stays between them. Fingers on the same spot (distance 0) only pan.
 */
export function pinch(state: ZoomState, previous: [Point, Point], next: [Point, Point]): ZoomState {
	const before = midpoint(previous[0], previous[1]);
	const after = midpoint(next[0], next[1]);
	const startDistance = distance(previous[0], previous[1]);
	const factor = startDistance > 0 ? distance(next[0], next[1]) / startDistance : 1;
	const zoomed = zoomAt(state, Number.isFinite(factor) && factor > 0 ? factor : 1, before);
	return pan(zoomed, after.x - before.x, after.y - before.y);
}
