import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { tidyTikzSource } from "../src/compiler/wrapSource";
import { computeSharedKey } from "../src/shared/sharedKey";

/** The same digest computed with Node's crypto, which mobile does not have. */
function nodeKey(tidied: string): string {
	return createHash("sha256").update(`tikz-shared-v1\u0000${tidied}`, "utf8").digest("hex");
}

describe("computeSharedKey", () => {
	it("matches node:crypto over the same UTF-8 bytes", async () => {
		for (const source of [
			"\\draw (0,0) -- (1,1);",
			"\\node {ü ∑ 数学 😀};",
			"",
			tidyTikzSource("  \\begin{tikzpicture}\r\n\r\n  \\draw (0,0) circle (1);\r\n\\end{tikzpicture}  "),
		]) {
			expect(await computeSharedKey(source)).toBe(nodeKey(source));
		}
	});

	it("is a stable 64-character hex name", async () => {
		const key = await computeSharedKey("\\draw (0,0) -- (1,1);");
		expect(key).toMatch(/^[0-9a-f]{64}$/);
		expect(key).toBe(nodeKey("\\draw (0,0) -- (1,1);"));
	});

	it("does not depend on line endings or indentation once tidied", async () => {
		const a = tidyTikzSource("\\begin{tikzpicture}\n  \\draw (0,0);\n\\end{tikzpicture}");
		const b = tidyTikzSource("\\begin{tikzpicture}\r\n\\draw (0,0);\r\n\r\n\\end{tikzpicture}");
		expect(await computeSharedKey(a)).toBe(await computeSharedKey(b));
	});
});
