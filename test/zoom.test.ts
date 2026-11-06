import { describe, expect, it } from "vitest";
import {
	FIT_PADDING,
	MAX_SCALE,
	MIN_SCALE,
	centred,
	clampScale,
	fitScale,
	pan,
	pinch,
	wheelFactor,
	zoomAt,
	zoomTo,
	type Point,
	type ZoomState,
} from "../src/zoom";

/** Viewport point -> content point (at scale 1) under a given state. */
function toContent(state: ZoomState, point: Point): Point {
	return { x: (point.x - state.x) / state.scale, y: (point.y - state.y) / state.scale };
}

describe("clampScale", () => {
	it("keeps scales inside the limits", () => {
		expect(clampScale(0.001)).toBe(MIN_SCALE);
		expect(clampScale(1000)).toBe(MAX_SCALE);
		expect(clampScale(2)).toBe(2);
	});

	it("resets nonsense to 1", () => {
		expect(clampScale(Number.NaN)).toBe(1);
		expect(clampScale(Number.POSITIVE_INFINITY)).toBe(1);
		expect(clampScale(0)).toBe(1);
		expect(clampScale(-3)).toBe(1);
	});
});

describe("fitScale", () => {
	const viewport = { width: 1000 + 2 * FIT_PADDING, height: 500 + 2 * FIT_PADDING };

	it("fits the limiting axis of a wide diagram", () => {
		expect(fitScale({ width: 2000, height: 100 }, viewport)).toBeCloseTo(0.5);
	});

	it("fits the limiting axis of a tall diagram", () => {
		expect(fitScale({ width: 100, height: 1000 }, viewport)).toBeCloseTo(0.5);
	});

	it("enlarges a small diagram to fill the viewer", () => {
		expect(fitScale({ width: 100, height: 50 }, viewport)).toBeCloseTo(10);
	});

	it("caps a tiny diagram at the maximum scale", () => {
		expect(fitScale({ width: 1, height: 1 }, viewport)).toBe(MAX_SCALE);
	});

	it("respects a custom padding", () => {
		expect(fitScale({ width: 100, height: 100 }, { width: 300, height: 300 }, 50)).toBeCloseTo(2);
	});

	it("returns 1 for an empty diagram or viewport rather than dividing by zero", () => {
		expect(fitScale({ width: 0, height: 0 }, viewport)).toBe(1);
		expect(Number.isFinite(fitScale({ width: 100, height: 100 }, { width: 0, height: 0 }))).toBe(true);
	});
});

describe("centred", () => {
	it("centres the scaled diagram", () => {
		expect(centred(2, { width: 100, height: 50 }, { width: 400, height: 300 })).toEqual({
			scale: 2,
			x: 100,
			y: 100,
		});
	});

	it("allows negative offsets when the diagram overflows", () => {
		const state = centred(1, { width: 600, height: 50 }, { width: 400, height: 300 });
		expect(state.x).toBe(-100);
	});
});

describe("zoomAt", () => {
	const start: ZoomState = { scale: 1.5, x: 40, y: -20 };
	const cursor: Point = { x: 310, y: 125 };

	it("keeps the content under the cursor fixed", () => {
		const before = toContent(start, cursor);
		for (const factor of [1.25, 0.8, 3, 0.2]) {
			const after = toContent(zoomAt(start, factor, cursor), cursor);
			expect(after.x).toBeCloseTo(before.x);
			expect(after.y).toBeCloseTo(before.y);
		}
	});

	it("multiplies the scale", () => {
		expect(zoomAt(start, 2, cursor).scale).toBeCloseTo(3);
	});

	it("stops at the limits and still keeps the anchor fixed", () => {
		const before = toContent(start, cursor);
		const huge = zoomAt(start, 1e6, cursor);
		expect(huge.scale).toBe(MAX_SCALE);
		expect(toContent(huge, cursor).x).toBeCloseTo(before.x);
		const tiny = zoomAt(start, 1e-6, cursor);
		expect(tiny.scale).toBe(MIN_SCALE);
		expect(toContent(tiny, cursor).y).toBeCloseTo(before.y);
	});

	it("is a no-op at a limit", () => {
		const atMax: ZoomState = { scale: MAX_SCALE, x: 5, y: 6 };
		expect(zoomAt(atMax, 2, cursor)).toEqual(atMax);
	});
});

describe("zoomTo", () => {
	it("reaches an absolute scale around the anchor", () => {
		const start: ZoomState = { scale: 0.7, x: 12, y: 34 };
		const point = { x: 200, y: 100 };
		const next = zoomTo(start, 2, point);
		expect(next.scale).toBeCloseTo(2);
		expect(toContent(next, point).x).toBeCloseTo(toContent(start, point).x);
	});
});

describe("pan", () => {
	it("moves without changing the scale", () => {
		expect(pan({ scale: 2, x: 1, y: 2 }, 10, -5)).toEqual({ scale: 2, x: 11, y: -3 });
	});
});

describe("wheelFactor", () => {
	it("zooms in when scrolling up and out when scrolling down", () => {
		expect(wheelFactor(-100)).toBeGreaterThan(1);
		expect(wheelFactor(100)).toBeLessThan(1);
		expect(wheelFactor(0)).toBe(1);
	});

	it("is symmetric, so up then down returns to the same scale", () => {
		expect(wheelFactor(-50) * wheelFactor(50)).toBeCloseTo(1);
	});

	it("treats line and page deltas as larger pixel deltas", () => {
		expect(wheelFactor(1, 1)).toBeCloseTo(wheelFactor(16, 0));
		expect(wheelFactor(1, 1)).toBeLessThan(wheelFactor(1, 0));
		expect(wheelFactor(1, 2)).toBeLessThan(wheelFactor(1, 1));
	});

	it("bounds one event's zoom", () => {
		expect(wheelFactor(-1e6)).toBe(2);
		expect(wheelFactor(1e6)).toBe(0.5);
		expect(wheelFactor(Number.NaN)).toBe(1);
	});
});

describe("pinch", () => {
	const start: ZoomState = { scale: 1.5, x: 20, y: -10 };

	it("keeps the content between the fingers between them", () => {
		const prev: [Point, Point] = [{ x: 100, y: 100 }, { x: 200, y: 140 }];
		const next: [Point, Point] = [{ x: 60, y: 90 }, { x: 260, y: 170 }];
		const midBefore = { x: 150, y: 120 };
		const midAfter = { x: 160, y: 130 };
		const anchored = toContent(start, midBefore);
		const after = pinch(start, prev, next);
		const moved = toContent(after, midAfter);
		expect(moved.x).toBeCloseTo(anchored.x);
		expect(moved.y).toBeCloseTo(anchored.y);
		expect(after.scale).toBeCloseTo(start.scale * 2);
	});

	it("only pans when the fingers keep their distance", () => {
		const after = pinch(start, [{ x: 0, y: 0 }, { x: 10, y: 0 }], [{ x: 5, y: 7 }, { x: 15, y: 7 }]);
		expect(after).toEqual({ scale: start.scale, x: start.x + 5, y: start.y + 7 });
	});

	it("clamps the scale and survives fingers on the same spot", () => {
		const huge = pinch(start, [{ x: 0, y: 0 }, { x: 1, y: 0 }], [{ x: 0, y: 0 }, { x: 1e6, y: 0 }]);
		expect(huge.scale).toBe(MAX_SCALE);
		const same = pinch(start, [{ x: 3, y: 3 }, { x: 3, y: 3 }], [{ x: 4, y: 4 }, { x: 4, y: 4 }]);
		expect(same.scale).toBe(start.scale);
		expect(Number.isFinite(same.x)).toBe(true);
	});
});
