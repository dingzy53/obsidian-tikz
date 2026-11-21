import { describe, expect, it } from "vitest";
import { waitForSettled, type Settleable } from "../src/settle";

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

/** Diagrams are plain strings; `root` contains the ones it lists. */
function rootOf(...inside: string[]): { contains(node: string): boolean } {
	return { contains: (node) => inside.includes(node) };
}

/** Resolves on the next macrotask, after every pending microtask. */
const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

describe("waitForSettled", () => {
	it("resolves at once when nothing is mounted inside root", async () => {
		const outside = deferred();
		await waitForSettled(rootOf(), () => [{ container: "a", settled: outside.promise }]);
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
