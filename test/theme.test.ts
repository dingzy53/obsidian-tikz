import { describe, expect, it } from "vitest";
import { scopedDarkTheme, type ThemeElement } from "../src/theme";

/** A minimal element tree: `closest` supports the two selectors theme.ts uses. */
class FakeElement implements ThemeElement {
	readonly nodeType = 1;
	readonly classList: { contains(token: string): boolean };

	constructor(
		readonly parentElement: FakeElement | null,
		private readonly classes: string[] = [],
		private readonly attributes: Record<string, string> = {},
	) {
		this.classList = { contains: (token) => this.classes.includes(token) };
	}

	getAttribute(name: string): string | null {
		return this.attributes[name] ?? null;
	}

	closest(selector: string): FakeElement | null {
		const matches = (el: FakeElement): boolean =>
			selector === "[data-tikz-theme]"
				? el.getAttribute("data-tikz-theme") !== null
				: el.classes.includes("theme-light") || el.classes.includes("theme-dark");
		if (matches(this)) return this;
		return this.parentElement?.closest(selector) ?? null;
	}
}

describe("scopedDarkTheme", () => {
	const darkBody = new FakeElement(null, ["theme-dark"]);
	const lightBody = new FakeElement(null, ["theme-light"]);

	it("defers to body when no ancestor sets a theme", () => {
		const diagram = new FakeElement(new FakeElement(darkBody));
		expect(scopedDarkTheme(diagram, darkBody)).toBeNull();
	});

	it("honours data-tikz-theme over a dark body", () => {
		const root = new FakeElement(darkBody, ["theme-light"], { "data-tikz-theme": "light" });
		expect(scopedDarkTheme(new FakeElement(new FakeElement(root)), darkBody)).toBe(false);
	});

	it("honours data-tikz-theme=\"dark\" over a light body", () => {
		const root = new FakeElement(lightBody, [], { "data-tikz-theme": "dark" });
		expect(scopedDarkTheme(new FakeElement(root), lightBody)).toBe(true);
	});

	it("prefers data-tikz-theme over a nearer theme class", () => {
		const root = new FakeElement(darkBody, [], { "data-tikz-theme": "light" });
		const inner = new FakeElement(root, ["theme-dark"]);
		expect(scopedDarkTheme(new FakeElement(inner), darkBody)).toBe(false);
	});

	it("ignores unknown data-tikz-theme values", () => {
		const root = new FakeElement(darkBody, [], { "data-tikz-theme": "auto" });
		expect(scopedDarkTheme(new FakeElement(root), darkBody)).toBeNull();
	});

	it("uses the nearest theme class below body", () => {
		const light = new FakeElement(darkBody, ["theme-light"]);
		expect(scopedDarkTheme(new FakeElement(light), darkBody)).toBe(false);
		const dark = new FakeElement(lightBody, ["theme-dark"]);
		expect(scopedDarkTheme(new FakeElement(dark), lightBody)).toBe(true);
	});

	it("starts from the parent of a non-element node", () => {
		const root = new FakeElement(darkBody, [], { "data-tikz-theme": "light" });
		expect(scopedDarkTheme({ nodeType: 3, parentElement: root }, darkBody)).toBe(false);
		expect(scopedDarkTheme({ nodeType: 3, parentElement: null }, darkBody)).toBeNull();
	});
});
