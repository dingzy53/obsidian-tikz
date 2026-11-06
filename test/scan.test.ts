import { describe, expect, it } from "vitest";
import { tidyTikzSource } from "../src/compiler/wrapSource";
import { extractTikzSources, mayContainTikz } from "../src/shared/scan";

const BODY = "\\begin{tikzpicture}\n\\draw (0,0) -- (1,1);\n\\end{tikzpicture}";

describe("extractTikzSources", () => {
	it("finds a plain backtick block, tidied like the renderer does", () => {
		const md = `# Title\n\n\`\`\`tikz\n  ${BODY}\n\n\`\`\`\n\ntext`;
		expect(extractTikzSources(md)).toEqual([tidyTikzSource(BODY)]);
	});

	it("finds tilde and longer fences, and needs a matching close", () => {
		const md = [
			"~~~tikz",
			"\\draw (0,0);",
			"```",
			"~~~",
			"````tikz",
			"\\draw (1,1);",
			"```",
			"````",
		].join("\n");
		expect(extractTikzSources(md)).toEqual(["\\draw (0,0);\n```", "\\draw (1,1);\n```"]);
	});

	it("ignores other languages and inline code", () => {
		const md = "```python\nprint('tikz')\n```\n`tikz` inline\n```latex\n\\draw;\n```";
		expect(extractTikzSources(md)).toEqual([]);
	});

	it("accepts extra info words and any case", () => {
		const md = "```tikz title\n\\draw (0,0);\n```\n```TikZ\n\\draw (2,2);\n```";
		expect(extractTikzSources(md)).toEqual(["\\draw (0,0);", "\\draw (2,2);"]);
	});

	it("strips callout and nested blockquote markers", () => {
		const md = [
			"> [!note] A diagram",
			"> ```tikz",
			"> \\begin{tikzpicture}",
			">   \\draw (0,0) -- (1,1);",
			"> \\end{tikzpicture}",
			"> ```",
			"",
			"> > ```tikz",
			"> > \\draw (3,3);",
			"> > ```",
		].join("\n");
		expect(extractTikzSources(md)).toEqual([tidyTikzSource(BODY), "\\draw (3,3);"]);
	});

	it("handles list indentation and CRLF line endings", () => {
		const md = "- item\r\n    ```tikz\r\n    \\draw (0,0);\r\n    ```\r\n";
		expect(extractTikzSources(md)).toEqual(["\\draw (0,0);"]);
	});

	it("runs an unclosed fence to the end of the note", () => {
		expect(extractTikzSources("```tikz\n\\draw (0,0);")).toEqual(["\\draw (0,0);"]);
	});

	it("does not treat a backtick info string with backticks as a fence", () => {
		expect(extractTikzSources("```tikz`x\n\\draw;\n```")).toEqual([]);
	});

	it("finds several blocks in order", () => {
		const md = "```tikz\nA\n```\n\n```tikz\nB\n```";
		expect(extractTikzSources(md)).toEqual(["A", "B"]);
	});
});

describe("mayContainTikz", () => {
	it("pre-filters notes cheaply", () => {
		expect(mayContainTikz("```tikz\n")).toBe(true);
		expect(mayContainTikz("> ~~~ TikZ\n")).toBe(true);
		expect(mayContainTikz("no diagrams here, just tikz in prose")).toBe(false);
	});
});
