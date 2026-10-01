import { describe, expect, it } from "vitest";
import { Limiter, resolveConcurrency } from "../src/limiter";

function deferred(): { promise: Promise<void>; resolve: () => void } {
	let resolve!: () => void;
	const promise = new Promise<void>((r) => (resolve = r));
	return { promise, resolve };
}

describe("Limiter", () => {
	it("never runs more than `max` tasks at once", async () => {
		const limiter = new Limiter(2);
		let active = 0;
		let peak = 0;
		const gates = Array.from({ length: 5 }, () => deferred());
		const results = gates.map((gate) =>
			limiter.run(async () => {
				active++;
				peak = Math.max(peak, active);
				await gate.promise;
				active--;
			}),
		);

		await Promise.resolve();
		expect(limiter.running).toBe(2);
		expect(limiter.queued).toBe(3);

		for (const gate of gates) {
			gate.resolve();
			await Promise.resolve();
		}
		await Promise.all(results);
		expect(peak).toBe(2);
		expect(limiter.running).toBe(0);
	});

	it("starts queued tasks in order", async () => {
		const limiter = new Limiter(1);
		const order: number[] = [];
		await Promise.all([1, 2, 3].map((n) => limiter.run(async () => void order.push(n))));
		expect(order).toEqual([1, 2, 3]);
	});

	it("frees the slot when a task rejects", async () => {
		const limiter = new Limiter(1);
		await expect(limiter.run(() => Promise.reject(new Error("boom")))).rejects.toThrow("boom");
		await expect(limiter.run(async () => "next")).resolves.toBe("next");
	});

	it("frees the slot when a task throws synchronously", async () => {
		const limiter = new Limiter(1);
		const failing = limiter.run((): Promise<void> => {
			throw new Error("sync");
		});
		await expect(failing).rejects.toThrow("sync");
		expect(limiter.running).toBe(0);
		await expect(limiter.run(async () => "after")).resolves.toBe("after");
	});

	it("raising the limit releases queued tasks", async () => {
		const limiter = new Limiter(1);
		const gate = deferred();
		const first = limiter.run(() => gate.promise);
		let secondStarted = false;
		const second = limiter.run(async () => void (secondStarted = true));
		await Promise.resolve();
		expect(secondStarted).toBe(false);

		limiter.setMax(2);
		await second;
		expect(secondStarted).toBe(true);
		gate.resolve();
		await first;
	});
});

describe("resolveConcurrency", () => {
	it("honours an explicit setting", () => {
		expect(resolveConcurrency(3, 16)).toBe(3);
	});

	it("auto = half the cores, between 1 and 4", () => {
		expect(resolveConcurrency(0, 1)).toBe(1);
		expect(resolveConcurrency(0, 4)).toBe(2);
		expect(resolveConcurrency(0, 64)).toBe(4);
	});
});
