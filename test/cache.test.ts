import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { CACHE_VERSION, DiagramCache, computeCacheKey } from "../src/cache";

describe("computeCacheKey", () => {
	const base = { source: "\\draw (0,0);", preamble: "\\usepackage{tikz}", engine: "dvilualatex" };

	it("is stable for identical input", () => {
		expect(computeCacheKey(base)).toBe(computeCacheKey({ ...base }));
	});

	it("changes when the source changes", () => {
		expect(computeCacheKey(base)).not.toBe(computeCacheKey({ ...base, source: "\\draw (0,1);" }));
	});

	it("changes when the preamble changes", () => {
		expect(computeCacheKey(base)).not.toBe(computeCacheKey({ ...base, preamble: "\\usepackage{array}" }));
	});

	it("changes when the engine changes", () => {
		expect(computeCacheKey(base)).not.toBe(computeCacheKey({ ...base, engine: "pdflatex" }));
	});

	it("is a hex sha-256 digest", () => {
		expect(computeCacheKey(base)).toMatch(/^[0-9a-f]{64}$/);
	});

	it("carries a cache version so pipeline changes invalidate old entries", () => {
		expect(CACHE_VERSION).toBeGreaterThan(0);
	});
});

describe("DiagramCache", () => {
	let dir: string;

	beforeEach(async () => {
		dir = await fsp.mkdtemp(path.join(os.tmpdir(), "tikz-cache-test-"));
	});

	afterEach(async () => {
		await fsp.rm(dir, { recursive: true, force: true });
	});

	it("round-trips an SVG", async () => {
		const cache = new DiagramCache(dir);
		await cache.set("abc", "<svg/>");
		expect(await cache.get("abc")).toBe("<svg/>");
	});

	it("misses on an unknown key", async () => {
		const cache = new DiagramCache(dir);
		expect(await cache.get("nope")).toBeNull();
	});

	it("round-trips a failure log", async () => {
		const cache = new DiagramCache(dir);
		await cache.setLog("abc", "! Undefined control sequence.");
		expect(await cache.getLog("abc")).toContain("Undefined control sequence");
	});

	it("drops a stale failure log once the same key succeeds", async () => {
		const cache = new DiagramCache(dir);
		await cache.setLog("abc", "old failure");
		await cache.set("abc", "<svg/>");
		expect(await cache.getLog("abc")).toBeNull();
	});

	it("reports stats", async () => {
		const cache = new DiagramCache(dir);
		await cache.set("a", "<svg/>");
		await cache.set("b", "<svg/>");
		await cache.setLog("c", "log");
		const stats = await cache.stats();
		expect(stats.entries).toBe(2);
		expect(stats.bytes).toBeGreaterThan(0);
	});

	it("clears everything and reports how much was removed", async () => {
		const cache = new DiagramCache(dir);
		await cache.set("a", "<svg/>");
		await cache.set("b", "<svg/>");
		expect(await cache.clear()).toBe(2);
		expect(await cache.stats()).toEqual({ entries: 0, bytes: 0 });
	});

	it("clear is safe when the directory does not exist", async () => {
		const cache = new DiagramCache(path.join(dir, "missing"));
		expect(await cache.clear()).toBe(0);
	});

	it("sweeps the oldest entries beyond maxEntries", async () => {
		const cache = new DiagramCache(dir, 2);
		await cache.set("oldest", "<svg/>");
		await new Promise((resolve) => setTimeout(resolve, 10));
		await cache.set("middle", "<svg/>");
		await new Promise((resolve) => setTimeout(resolve, 10));
		await cache.set("newest", "<svg/>");

		expect(await cache.get("oldest")).toBeNull();
		expect(await cache.get("middle")).toBe("<svg/>");
		expect(await cache.get("newest")).toBe("<svg/>");
	});

	it("does not sweep when the limit is zero (unlimited)", async () => {
		const cache = new DiagramCache(dir, 0);
		await cache.set("a", "<svg/>");
		await cache.set("b", "<svg/>");
		await cache.set("c", "<svg/>");
		expect((await cache.stats()).entries).toBe(3);
	});
});
