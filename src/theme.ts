/**
 * Theme lookup for one diagram (pure, no obsidian import).
 *
 * A container can override the window's theme for the diagrams inside it,
 * for example another plugin's light print root while Obsidian is dark:
 *
 * 1. the nearest `[data-tikz-theme="light" | "dark"]` ancestor;
 * 2. else the nearest `.theme-light` / `.theme-dark` ancestor below `<body>`;
 * 3. else `<body>`'s `theme-dark` class.
 */

/** The DOM surface this needs, so tests can pass plain objects. */
export interface ThemeNode {
	readonly nodeType: number;
	readonly parentElement: ThemeElement | null;
}

export interface ThemeElement extends ThemeNode {
	closest(selector: string): ThemeElement | null;
	getAttribute(name: string): string | null;
	readonly classList: { contains(token: string): boolean };
}

const ELEMENT_NODE = 1;

/** Attribute that forces a theme for the diagrams inside an element. */
export const THEME_ATTRIBUTE = "data-tikz-theme";

/**
 * True or false when an ancestor of `node` sets the theme, `null` when only
 * `body` can tell. `body` itself is skipped here so the caller keeps reading
 * it from the diagram's own window.
 */
export function scopedDarkTheme(node: ThemeNode, body: ThemeElement | null): boolean | null {
	const element = node.nodeType === ELEMENT_NODE ? (node as ThemeElement) : node.parentElement;
	if (!element) return null;

	const forced = element.closest(`[${THEME_ATTRIBUTE}]`)?.getAttribute(THEME_ATTRIBUTE);
	if (forced === "light") return false;
	if (forced === "dark") return true;

	const themed = element.closest(".theme-light, .theme-dark");
	if (themed && themed !== body) return !themed.classList.contains("theme-light");
	return null;
}
