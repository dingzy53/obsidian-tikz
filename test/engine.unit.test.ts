import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { compileTikz } from "../src/compiler";

/**
 * Exercises the process plumbing with stand-in executables, so the failure
 * paths (never-throw, timeout, bad exit) are covered on machines — and CI —
 * with no TeX installation.
 */
const posix = process.platform !== "win32";
const dir = mkdtempSync(path.join(tmpdir(), "tikz-fake-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function script(name: string, body: string): string {
	const file = path.join(dir, name);
	writeFileSync(file, `#!/bin/sh\n${body}\n`);
	chmodSync(file, 0o755);
	return file;
}

const okEngine = script("ok-engine", `echo "fake" > diagram.dvi`);
const okDvisvgm = script("ok-dvisvgm", `echo "<svg xmlns='http://www.w3.org/2000/svg'/>" > diagram.svg`);
const base = { source: "\\draw (0,0)--(1,1);", preamble: "", engine: "latex" as const };

describe.skipIf(!posix)("compileTikz process handling", () => {
	it("returns the svg when both stages succeed", async () => {
		const result = await compileTikz({ ...base, enginePath: okEngine, dvisvgmPath: okDvisvgm });
		expect(result.ok).toBe(true);
	});

	it("reports a compile error with the real log", async () => {
		const engine = script("bad-engine", `printf '! Undefined control sequence.\\nl.4 \\\\foo\\n' > diagram.log\nexit 1`);
		const result = await compileTikz({ ...base, enginePath: engine, dvisvgmPath: okDvisvgm });
		expect(result).toMatchObject({ ok: false, kind: "compile-error" });
		if (!result.ok) expect(result.log).toContain("Undefined control sequence");
	});

	it("kills a hung engine and reports a timeout", async () => {
		const engine = script("hung-engine", "sleep 30");
		const started = Date.now();
		const result = await compileTikz({ ...base, enginePath: engine, dvisvgmPath: okDvisvgm, timeoutMs: 300 });
		expect(result).toMatchObject({ ok: false, kind: "timeout" });
		expect(Date.now() - started).toBeLessThan(5000);
	});

	it("reports a missing binary instead of throwing", async () => {
		const result = await compileTikz({ ...base, enginePath: path.join(dir, "nope"), dvisvgmPath: okDvisvgm });
		expect(result).toMatchObject({ ok: false, kind: "binary-not-found" });
	});

	it("turns an unexpected exception into a failure result", async () => {
		// A non-string `source` makes the wrapper throw before any process runs.
		const result = await compileTikz({
			...base,
			source: undefined as unknown as string,
			enginePath: okEngine,
			dvisvgmPath: okDvisvgm,
		});
		expect(result).toMatchObject({ ok: false, kind: "internal" });
	});
});
