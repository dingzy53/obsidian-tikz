import { describe, expect, it } from "vitest";
import {
	countShownErrors,
	isElementShown,
	waitForSettled,
	type Settleable,
	type ShowableElement,
} from "../src/settle";

interface Deferred {
	promise: Promise<void>;
	resolve(): void;
}

function deferred(): Deferred {
	let resolve: () => void = () => undefined;
	const promise = new Promise<void>((r) => {
		resolve = r;
	});
	return { promise, resolve };
}

/** Diagrams are plain values; `root` contains the ones it lists. */
function rootOf<N>(...inside: N[]): { contains(node: N): boolean } {
	return { contains: (node) => inside.includes(node) };
}

/** Resolves on the next macrotask, after every pending microtask. */
const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

describe("waitForSettled", () => {
	it("resolves at once when nothing is mounted inside root", async () => {
		const outside = deferred();
		await waitForSettled(rootOf<string>(), () => [{ container: "a", settled: outside.promise }]);
	});

	it("waits for every diagram inside root", async () => {
		const a = deferred();
		const b = deferred();
		const mounted: Settleable<string>[] = [
			{ container: "a", settled: a.promise },
			{ container: "b", settled: b.promise },
		];
		let done = false;
		const wait = waitForSettled(rootOf("a", "b"), () => mounted).then(() => {
			done = true;
		});
		a.resolve();
		await tick();
		expect(done).toBe(false);
		b.resolve();
		await wait;
		expect(done).toBe(true);
	});

	it("still waits for hidden diagrams inside root", async () => {
		const hiddenContainer: ShowableElement = { checkVisibility: () => false };
		const hidden = deferred();
		let done = false;
		const wait = waitForSettled(rootOf(hiddenContainer), () => [
			{ container: hiddenContainer, settled: hidden.promise },
		]).then(() => {
			done = true;
		});
		await tick();
		expect(done).toBe(false);
		hidden.resolve();
		await wait;
		expect(done).toBe(true);
	});

	it("also waits for diagrams mounted, or re-rendered, while it waits", async () => {
		const first = deferred();
		const late = deferred();
		const rerender = deferred();
		const a = { container: "a", settled: first.promise };
		const mounted: Settleable<string>[] = [a];
		let done = false;
		const wait = waitForSettled(rootOf("a", "b"), () => mounted).then(() => {
			done = true;
		});
		mounted.push({ container: "b", settled: late.promise });
		a.settled = rerender.promise;
		first.resolve();
		await tick();
		late.resolve();
		await tick();
		expect(done).toBe(false);
		rerender.resolve();
		await wait;
		expect(done).toBe(true);
	});
});

describe("isElementShown", () => {
	it("prefers checkVisibility() when available, including for position: fixed elements", () => {
		expect(isElementShown({ checkVisibility: () => true, isShown: () => false, offsetParent: null })).toBe(true);
		expect(isElementShown({ checkVisibility: () => false, isShown: () => true, offsetParent: {} })).toBe(false);
	});

	it("falls back to Obsidian's isShown() when checkVisibility is unavailable", () => {
		expect(isElementShown({ isShown: () => true, offsetParent: null })).toBe(true);
		expect(isElementShown({ isShown: () => false, offsetParent: {} })).toBe(false);
	});

	it("falls back to offsetParent when neither method exists", () => {
		expect(isElementShown({ offsetParent: {} })).toBe(true);
		expect(isElementShown({ offsetParent: null })).toBe(false);
		expect(isElementShown({})).toBe(false);
	});
});

describe("countShownErrors", () => {
	it("skips a hidden container next to a visible one inside the same root", () => {
		// Reproduces Reading view with an inactive Live Preview copy in document.body.
		const visiblePreview: ShowableElement = { checkVisibility: () => true };
		const hiddenSource: ShowableElement = { checkVisibility: () => false };
		const mounted = [
			{ container: visiblePreview, hasError: true },
			{ container: hiddenSource, hasError: true },
		];
		expect(countShownErrors(rootOf(visiblePreview, hiddenSource), mounted)).toBe(1);
	});

	it("counts errors in a visible print root and ignores non-errors and diagrams outside root", () => {
		const printErr: ShowableElement = { isShown: () => true };
		const printOk: ShowableElement = { isShown: () => true };
		const outsideErr: ShowableElement = { isShown: () => true };
		const hiddenErr: ShowableElement = { isShown: () => false };
		const mounted = [
			{ container: printErr, hasError: true },
			{ container: printOk, hasError: false },
			{ container: outsideErr, hasError: true },
			{ container: hiddenErr, hasError: true },
		];
		expect(countShownErrors(rootOf(printErr, printOk, hiddenErr), mounted)).toBe(1);
	});

	it("returns zero when only hidden diagrams have errors", () => {
		const hiddenA: ShowableElement = { offsetParent: null };
		const hiddenB: ShowableElement = { checkVisibility: () => false };
		const mounted = [
			{ container: hiddenA, hasError: true },
			{ container: hiddenB, hasError: true },
		];
		expect(countShownErrors(rootOf(hiddenA, hiddenB), mounted)).toBe(0);
	});
});
