/**
 * Finds the `tikz` code blocks in a note's markdown, so the desktop can work
 * out which diagrams the shared folder should hold. Pure, so it is testable
 * and runs without Obsidian.
 *
 * It must hand back the same text Obsidian passes to the code block
 * processor, because both are hashed (after `tidyTikzSource`) into the shared
 * key. Obsidian strips blockquote and callout markers and indentation before
 * calling the processor; `tidyTikzSource` trims every line, so stripping the
 * `>` markers here is enough to make the two agree.
 */

import { tidyTikzSource } from "../compiler/wrapSource";

const LANGUAGE = "tikz";

/** Blockquote / callout markers at the start of a line, with any indentation. */
const QUOTE_PREFIX = /^[ \t]*(?:>[ \t]?)*/;

const OPENING_FENCE = /^[ \t]*(`{3,}|~{3,})(.*)$/;

interface OpenFence {
	char: "`" | "~";
	length: number;
	isTikz: boolean;
	lines: string[];
}

/**
 * The info string's first word, compared case-insensitively. Matching more
 * blocks than Obsidian renders only costs an unused shared file; matching
 * fewer would let a prune delete a diagram a phone needs.
 */
function isTikzInfo(info: string): boolean {
	const word = info.trim().split(/\s+/, 1)[0] ?? "";
	return word.toLowerCase() === LANGUAGE;
}

/** Tidied sources of every `tikz` block in `markdown`, in document order. */
export function extractTikzSources(markdown: string): string[] {
	const sources: string[] = [];
	let open: OpenFence | null = null;

	for (const rawLine of markdown.split(/\r?\n/)) {
		const line = rawLine.replace(QUOTE_PREFIX, "");

		if (open) {
			const trimmed = line.trim();
			const closing =
				trimmed.length >= open.length &&
				[...trimmed].every((char) => char === open?.char);
			if (closing) {
				if (open.isTikz) sources.push(tidyTikzSource(open.lines.join("\n")));
				open = null;
			} else {
				open.lines.push(line);
			}
			continue;
		}

		const match = OPENING_FENCE.exec(line);
		if (!match) continue;
		const fence = match[1] ?? "";
		const info = match[2] ?? "";
		const char = fence[0] as "`" | "~";
		// CommonMark: a backtick fence's info string cannot contain backticks.
		if (char === "`" && info.includes("`")) continue;
		open = { char, length: fence.length, isTikz: isTikzInfo(info), lines: [] };
	}

	// An unclosed fence runs to the end of the document, as in CommonMark.
	if (open?.isTikz) sources.push(tidyTikzSource(open.lines.join("\n")));
	return sources;
}

/** Cheap pre-filter so the scan only reads notes that can contain a block. */
export function mayContainTikz(markdown: string): boolean {
	return /(`{3,}|~{3,})[ \t]*tikz/i.test(markdown);
}
