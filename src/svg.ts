/**
 * Pure SVG post-processing. No `import "obsidian"`, so every transform here is
 * unit-testable.
 *
 * Lives apart from `render.ts` (which is the Obsidian wiring) so the string
 * transforms can be tested without the `Plugin` lifecycle — a small, deliberate
 * deviation from the file layout in plan §11, recorded there.
 */

import { optimize } from "svgo";
import type { CustomPlugin } from "svgo";
import type { XastChild, XastParent } from "svgo/lib/types";

/** How diagram colours are made to work on both a light and a dark theme. */
export type ColorAdaptation =
	/** Mirror the lightness of every colour when the theme is dark. */
	| "adaptive"
	/** Leave colours alone; dark mode puts the diagram on a light panel. */
	| "light-canvas"
	/** Never touch colours. */
	| "off";

// ---------------------------------------------------------------------------
// Colour maths
// ---------------------------------------------------------------------------

interface Rgb {
	r: number;
	g: number;
	b: number;
}

/** Parses `#rgb` / `#rrggbb` (with or without the hash). Returns null otherwise. */
export function parseHexColor(value: string): Rgb | null {
	const hex = value.startsWith("#") ? value.slice(1) : value;
	if (hex.length === 3) {
		const parts = [...hex].map((char) => Number.parseInt(char + char, 16));
		if (parts.some((part) => Number.isNaN(part))) return null;
		return { r: parts[0], g: parts[1], b: parts[2] };
	}
	if (hex.length === 6) {
		const r = Number.parseInt(hex.slice(0, 2), 16);
		const g = Number.parseInt(hex.slice(2, 4), 16);
		const b = Number.parseInt(hex.slice(4, 6), 16);
		if ([r, g, b].some((part) => Number.isNaN(part))) return null;
		return { r, g, b };
	}
	return null;
}

interface Hsl {
	/** 0..1 */
	h: number;
	/** 0..1 */
	s: number;
	/** 0..1 */
	l: number;
}

export function rgbToHsl({ r, g, b }: Rgb): Hsl {
	const rn = r / 255;
	const gn = g / 255;
	const bn = b / 255;
	const max = Math.max(rn, gn, bn);
	const min = Math.min(rn, gn, bn);
	const l = (max + min) / 2;
	const delta = max - min;

	if (delta === 0) return { h: 0, s: 0, l };

	const s = l > 0.5 ? delta / (2 - max - min) : delta / (max + min);
	let h: number;
	if (max === rn) h = ((gn - bn) / delta + (gn < bn ? 6 : 0)) / 6;
	else if (max === gn) h = ((bn - rn) / delta + 2) / 6;
	else h = ((rn - gn) / delta + 4) / 6;
	return { h, s, l };
}

export function hslToRgb({ h, s, l }: Hsl): Rgb {
	if (s === 0) {
		const value = Math.round(l * 255);
		return { r: value, g: value, b: value };
	}
	const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
	const p = 2 * l - q;
	const channel = (offset: number): number => {
		let t = offset;
		if (t < 0) t += 1;
		if (t > 1) t -= 1;
		if (t < 1 / 6) return p + (q - p) * 6 * t;
		if (t < 1 / 2) return q;
		if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
		return p;
	};
	return {
		r: Math.round(channel(h + 1 / 3) * 255),
		g: Math.round(channel(h) * 255),
		b: Math.round(channel(h - 1 / 3) * 255),
	};
}

/** `#rrggbb`, lowercase, clamped. */
export function toHex({ r, g, b }: Rgb): string {
	const part = (value: number): string =>
		Math.max(0, Math.min(255, Math.round(value)))
			.toString(16)
			.padStart(2, "0");
	return `#${part(r)}${part(g)}${part(b)}`;
}

/** sRGB channel (0..255) to linear light (0..1). */
function toLinear(channel: number): number {
	const c = channel / 255;
	return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

function fromLinear(value: number): number {
	const c = Math.max(0, Math.min(1, value));
	return (c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055) * 255;
}

/** WCAG relative luminance (0 = black, 1 = white). */
export function relativeLuminance({ r, g, b }: Rgb): number {
	return 0.2126 * toLinear(r) + 0.7152 * toLinear(g) + 0.0722 * toLinear(b);
}

/** WCAG contrast ratio between two relative luminances. */
function contrastRatio(a: number, b: number): number {
	const hi = Math.max(a, b);
	const lo = Math.min(a, b);
	return (hi + 0.05) / (lo + 0.05);
}

/**
 * Mirror lightness (`l -> 1 - l`) while keeping hue and saturation.
 *
 * This is the base dark-mode transform, and the reason it is a mirror rather
 * than a "brighten dark colours" rule: a diagram is authored against a light
 * page, so every colour's lightness encodes its intended contrast with that
 * page. Mirroring preserves those relationships *between* colours, which
 * matters because the same colour can be ink or a background:
 *
 *   - a near-white box and the black text inside it mirror to a near-black box
 *     and light text — still readable, whereas brightening only the text would
 *     have produced light-on-light (the bug this replaced);
 *   - `red!70!black` ink, invisible on a dark page, mirrors to a light red;
 *   - mid-tones such as pure `red`/`green`/`blue` (l = 0.5) are unchanged.
 */
export function mirrorLightness(colour: Rgb): Rgb {
	const { h, s, l } = rgbToHsl(colour);
	return hslToRgb({ h, s, l: 1 - l });
}

/** Contrast every diagram element is entitled to on a dark page (WCAG AA for graphics). */
const MIN_CONTRAST = 3;

/** Relative luminance of a typical dark theme background (`#1e1e1e`). */
const DARK_PAGE_LUMINANCE = 0.013;

/** Relative luminance of a typical light theme background (white). */
const LIGHT_PAGE_LUMINANCE = 1;

/**
 * Mixes a colour toward white in linear light until it reaches `targetLuminance`.
 *
 * Linear-light luminance is a linear function of the mix factor, so this is a
 * closed form rather than a search. Hue is preserved exactly; only saturation
 * falls, which is the price of making a saturated colour bright.
 */
function liftToLuminance(colour: Rgb, targetLuminance: number): Rgb {
	const current = relativeLuminance(colour);
	if (current >= targetLuminance) return colour;
	const t = (targetLuminance - current) / (1 - current);
	return {
		r: fromLinear(toLinear(colour.r) + (1 - toLinear(colour.r)) * t),
		g: fromLinear(toLinear(colour.g) + (1 - toLinear(colour.g)) * t),
		b: fromLinear(toLinear(colour.b) + (1 - toLinear(colour.b)) * t),
	};
}

/**
 * The dark-page colour for one source colour: mirror the lightness, then make
 * sure the result is actually visible.
 *
 * Mirroring alone is not enough, and this is measured rather than theoretical.
 * HSL lightness is not perceived brightness, so a saturated colour can mirror
 * to something far darker than its counterpart. `blue!70` (`#4c4cff`) sits at
 * 5.55:1 against a white page, but its mirror `#0000b3` is only 1.31:1 against
 * `#1e1e1e` — mirroring would have made a perfectly legible curve nearly
 * invisible. So anything that was legible on the light page is lifted until it
 * clears {@link MIN_CONTRAST} on the dark one.
 *
 * The floor deliberately does **not** apply to colours that were already below
 * it: those are backgrounds and deliberately subtle strokes. A `#f0f0f0` box is
 * 1.14:1 against white, and forcing it to 3:1 would turn a barely-there panel
 * into a grey slab. Its mirror is 1.15:1 against `#1e1e1e` — the same design,
 * correctly translated.
 */
export function adaptForDarkPage(colour: Rgb): Rgb {
	const original = relativeLuminance(colour);
	const mirrored = mirrorLightness(colour);

	// Meant to be subtle on the light page: keep it subtle on the dark one.
	if (contrastRatio(original, LIGHT_PAGE_LUMINANCE) < MIN_CONTRAST) return mirrored;

	if (contrastRatio(relativeLuminance(mirrored), DARK_PAGE_LUMINANCE) >= MIN_CONTRAST) {
		return mirrored;
	}

	const target = MIN_CONTRAST * (DARK_PAGE_LUMINANCE + 0.05) - 0.05;
	return liftToLuminance(mirrored, target);
}

/**
 * Matches a colour literal in a colour-bearing position only — after
 * `fill`/`stroke`/`stop-color`/`flood-color`/`color` and either `=` (attribute)
 * or `:` (style declaration).
 *
 * Scoping it this way is what keeps the transform safe: `url(#g0-54)` inside a
 * `fill`, `fill-rule`, and `stroke-width` are all untouched, so a font id that
 * happens to look like a hex colour can never be rewritten.
 *
 * The `(\s*)` group after the optional quote is not cosmetic: dvisvgm writes
 * gradient stops as `stop-color=' #000 '`, with the whitespace *inside* the
 * quotes. Without allowing for it every `<stop>` is skipped, which silently
 * leaves gradients (ball shadings, colormaps, fadings) untranslated — caught by
 * comparing the rendered showcase against the compiled SVG.
 */
const COLOR_LITERAL =
	/((?:fill|stroke|stop-color|flood-color|color)\s*[:=]\s*)(['"]?)(\s*)(#(?:[0-9a-fA-F]{6}|[0-9a-fA-F]{3}))(?![0-9a-fA-F])/g;

/**
 * Adapts diagram colours for a dark page.
 *
 * Pure black becomes `currentColor` so axes, arrows and glyphs take the theme's
 * own text colour (which a theme tunes for contrast) instead of a hard white.
 * Everything else goes through {@link adaptForDarkPage}.
 *
 * **Not** a verbatim port of upstream's `colorSVGinDarkMode`, and it cannot be.
 * Upstream matched `("#000"|"black")` — *double*-quoted values, because TikZJax
 * emitted `fill="black"`. dvisvgm emits single-quoted short forms (`fill='#000'`)
 * which that pattern never matches, so a straight port would leave every
 * diagram black-on-black. Worse, matching only exact black and white — whatever
 * the quoting — is structurally unable to handle tints and greys: `red!70!black`
 * ink, `gray` axes and `fill=gray!12` boxes all fall through, and a near-white
 * box keeps its light fill while its black text is remapped to the light text
 * colour, i.e. light-on-light. See plan §16.13.
 */
export function adaptColorsForDarkMode(svg: string): string {
	return svg.replace(
		COLOR_LITERAL,
		(match, prefix: string, quote: string, space: string, hex: string) => {
			const rgb = parseHexColor(hex);
			if (!rgb) return match;
			if (rgb.r === 0 && rgb.g === 0 && rgb.b === 0) {
				return `${prefix}${quote}${space}currentColor`;
			}
			return `${prefix}${quote}${space}${toHex(adaptForDarkPage(rgb))}`;
		},
	);
}

// ---------------------------------------------------------------------------
// Sanitising and namespacing
// ---------------------------------------------------------------------------

/**
 * Removes anything in the SVG that could execute or load code.
 *
 * The diagram text is untrusted vault content, and dvisvgm will pass through
 * `\special{dvisvgm:raw ...}` output, so a shared or synced vault could
 * otherwise smuggle markup into the note. Injected via `innerHTML`, a
 * `<script>` would not run, but event handlers and `<foreignObject>` would.
 * dvisvgm never emits any of the removed constructs, so this cannot affect
 * legitimate output.
 */
export function sanitizeSvg(svg: string): string {
	return svg
		// Processing instructions can pull in external stylesheets, and a
		// DOCTYPE can carry entity definitions; neither is ever emitted by
		// dvisvgm, and both are pointless once the SVG is inlined in HTML.
		.replace(/<\?[\s\S]*?\?>/g, "")
		.replace(/<!DOCTYPE[\s\S]*?>/gi, "")
		.replace(
			/<\s*(script|foreignObject|iframe|object|embed|handler)\b[\s\S]*?<\s*\/\s*\1\s*>/gi,
			"",
		)
		.replace(/<\s*(script|foreignObject|iframe|object|embed|handler)\b[^>]*\/?>/gi, "")
		.replace(/\s(on[a-z]+)\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, "")
		.replace(/javascript\s*:/gi, "");
}

/**
 * Namespaces every id (and every reference to it) with a per-diagram prefix.
 *
 * dvisvgm derives ids deterministically from font and character indices
 * (`g0-54`, `g0-72`, ...), so two diagrams rendered in the same document
 * reliably define the same ids. Since `<use xlink:href="#g0-54">` resolves
 * document-wide, the second diagram would draw the *first* diagram's glyph —
 * wrong glyphs, silently. Prefixing makes each diagram's ids unique.
 *
 * Every pattern below is quote/paren-delimited, so an id that is a prefix of
 * another id cannot be matched partially.
 */
export function prefixSvgIds(svg: string, prefix: string): string {
	const ids = new Set<string>();
	const idPattern = /\bid\s*=\s*(['"])([^'"]+)\1/g;
	let match: RegExpExecArray | null;
	while ((match = idPattern.exec(svg)) !== null) {
		ids.add(match[2]);
	}
	if (ids.size === 0) return svg;

	let out = svg;
	for (const id of ids) {
		const prefixed = `${prefix}${id}`;
		out = out
			.replaceAll(`id='${id}'`, `id='${prefixed}'`)
			.replaceAll(`id="${id}"`, `id="${prefixed}"`)
			.replaceAll(`href='#${id}'`, `href='#${prefixed}'`)
			.replaceAll(`href="#${id}"`, `href="#${prefixed}"`)
			.replaceAll(`url(#${id})`, `url(#${prefixed})`);
	}
	return out;
}

/** Elements dvisvgm / PGF can legitimately produce. Everything else is dropped. */
const ALLOWED_ELEMENTS = new Set([
	"svg", "g", "defs", "use", "symbol", "title", "desc",
	"path", "rect", "circle", "ellipse", "line", "polyline", "polygon",
	"text", "tspan",
	"clipPath", "mask", "pattern", "marker",
	"linearGradient", "radialGradient", "stop",
	"image",
	"filter", "feBlend", "feColorMatrix", "feComposite", "feFlood",
	"feGaussianBlur", "feMerge", "feMergeNode", "feOffset",
]);

/** Elements whose text content is rendered or harmless; text elsewhere is dropped. */
const TEXT_PARENTS = new Set(["text", "tspan", "title", "desc"]);

const DATA_IMAGE_HREF = /^data:image\/(?:png|jpe?g|gif|webp);base64,[A-Za-z0-9+/=\s]+$/i;

/** True when an attribute value can fetch or run something outside the diagram. */
function hasExternalReference(value: string): boolean {
	return (
		/url\(\s*["']?\s*(?!#)/i.test(value) ||
		/javascript\s*:|vbscript\s*:|@import|expression\s*\(|-moz-binding|behavior\s*:/i.test(value)
	);
}

/**
 * Allowlist sanitiser, run on the parsed SVGO AST rather than on the raw
 * string. A string blocklist can always be sidestepped by markup the regexes do
 * not anticipate (`<image href="x"/onerror="…"/>` is one such case); a parsed
 * tree can only contain what the parser understood, and this keeps only the
 * element set dvisvgm produces plus attributes that cannot execute or fetch.
 */
const sanitizeTreePlugin: CustomPlugin = {
	name: "tikzSanitize",
	fn: () => ({
		doctype: { enter: (node, parent) => dropChild(node, parent) },
		instruction: { enter: (node, parent) => dropChild(node, parent) },
		cdata: { enter: (node, parent) => dropChild(node, parent) },
		text: {
			enter: (node, parent) => {
				if (parent.type !== "element" || !TEXT_PARENTS.has(parent.name)) dropChild(node, parent);
			},
		},
		element: {
			enter: (node, parent) => {
				if (!ALLOWED_ELEMENTS.has(node.name)) {
					dropChild(node, parent);
					return;
				}
				for (const [name, value] of Object.entries(node.attributes)) {
					const lower = name.toLowerCase();
					let keep = true;
					if (lower.startsWith("on") || lower === "xml:base") {
						keep = false;
					} else if (lower === "href" || lower === "xlink:href") {
						const target = value.trim();
						keep = target.startsWith("#") || (node.name === "image" && DATA_IMAGE_HREF.test(target));
					} else if (hasExternalReference(value)) {
						keep = false;
					}
					if (!keep) delete node.attributes[name];
				}
			},
		},
	}),
};

function dropChild(node: XastChild, parent: XastParent): void {
	parent.children = parent.children.filter((child) => child !== node);
}

/** Thrown when the generated SVG cannot be parsed and so cannot be vetted. */
export class SvgRejectedError extends Error {
	constructor(cause: unknown) {
		super(
			`The generated SVG could not be validated: ${cause instanceof Error ? cause.message : String(cause)}`,
		);
		this.name = "SvgRejectedError";
	}
}

/**
 * Sanitise + namespace + SVGO pass, as a normal Node dependency instead of the
 * upstream plugin's browser-shimmed build (plan §9).
 *
 * `cleanupIds` stays disabled (upstream's reason: inline diagrams in one
 * document must not collide — now additionally guaranteed by
 * {@link prefixSvgIds}) and `removeViewBox` is disabled explicitly: stripping
 * the viewBox would break scaling in the reading pane. Note the SVGO v3
 * spelling `cleanupIds` — upstream's `cleanupIDs` no longer matches.
 *
 * Fails closed: the SVG is untrusted, so one SVGO cannot parse is rejected
 * with {@link SvgRejectedError} rather than being displayed unsanitised. The
 * output is re-serialised by SVGO, so it is well-formed and escaped.
 */
export function optimizeSVG(svg: string, prefix: string): string {
	const prefixed = prefixSvgIds(sanitizeSvg(svg), prefix);
	try {
		const result = optimize(prefixed, {
			plugins: [
				sanitizeTreePlugin,
				{
					name: "preset-default",
					params: {
						overrides: {
							cleanupIds: false,
							removeViewBox: false,
						},
					},
				},
			],
		});
		if (typeof result.data === "string" && result.data.trim().length > 0) {
			return result.data;
		}
		throw new Error("the sanitiser produced no output");
	} catch (error) {
		throw new SvgRejectedError(error);
	}
}

/**
 * Full render-time pipeline: optional dark-mode colour adaptation, then
 * sanitise + namespace + optimise. Runs on the cached pre-adaptation SVG, so
 * switching themes never triggers a recompile.
 *
 * `isDark` has to be resolved by the caller (Obsidian tags `<body>` with
 * `theme-dark`); the previous design tried to stay theme-agnostic by emitting
 * only `currentColor`/`var(--background-primary)`, which is exactly what made
 * tints and greys fall through.
 */
export function prepareSvgForDisplay(
	svg: string,
	prefix: string,
	adaptation: ColorAdaptation = "off",
	isDark = false,
): string {
	const adapted = adaptation === "adaptive" && isDark ? adaptColorsForDarkMode(svg) : svg;
	return optimizeSVG(adapted, prefix);
}
