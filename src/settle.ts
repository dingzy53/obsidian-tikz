/**
 * Waiting for the diagrams inside one element to finish, and counting shown
 * errors (pure, no obsidian import). Backs `plugin.api.whenSettled`, which
 * other plugins (Folder to PDF) call before printing a rendered note.
 */

/** `plugin.api`, read by other plugins through `app.plugins.plugins.tikz.api`. */
export interface TikzApi {
	/**
	 * Resolves once every mounted diagram inside `root` (including hidden
	 * ones) has finished rendering, with the number of shown diagrams that
	 * show an error.
	 */
	whenSettled(root: HTMLElement): Promise<{ errors: number }>;
}

/** Minimal DOM surface to check whether a diagram container is shown. */
export interface ShowableElement {
	checkVisibility?: () => boolean;
	isShown?: () => boolean;
	readonly offsetParent?: unknown;
}

/** A mounted diagram: where it is, and its current render. */
export interface Settleable<N> {
	readonly container: N;
	/** Resolves (never rejects) when the current render has finished. */
	readonly settled: Promise<void>;
}

/** A mounted diagram's container and whether it currently displays an error. */
export interface ErrorReportable<N> {
	readonly container: N;
	/** True while the diagram currently displays a compile or display error. */
	readonly hasError: boolean;
}

/**
 * True when `el` is attached and not hidden by `display: none` (such as the
 * inactive Live Preview copy of a note in Reading view, or a background tab).
 *
 * Prefers `checkVisibility()` (which also works on `position: fixed`), then
 * Obsidian's `isShown()`, then `offsetParent !== null`.
 */
export function isElementShown(el: ShowableElement): boolean {
	if (typeof el.checkVisibility === "function") return el.checkVisibility();
	if (typeof el.isShown === "function") return el.isShown();
	return el.offsetParent != null;
}

/**
 * Resolves once every diagram inside `root` (including hidden ones) has
 * finished rendering. Checks again after each wait, because embeds can mount
 * new diagrams late and a diagram can start a new render (for example when a
 * shared file arrives).
 */
export async function waitForSettled<N>(
	root: { contains(node: N): boolean },
	mounted: () => Iterable<Settleable<N>>,
): Promise<void> {
	const done = new Set<Promise<void>>();
	for (;;) {
		const pending: Promise<void>[] = [];
		for (const diagram of mounted()) {
			if (done.has(diagram.settled)) continue;
			if (!root.contains(diagram.container)) continue;
			pending.push(diagram.settled);
		}
		if (pending.length === 0) return;
		await Promise.allSettled(pending);
		for (const promise of pending) done.add(promise);
	}
}

/**
 * Counts mounted diagrams inside `root` that are currently shown and showing
 * an error. Hidden copies (such as the inactive Live Preview view while
 * Reading view is active) are skipped.
 */
export function countShownErrors<N extends ShowableElement>(
	root: { contains(node: NoInfer<N>): boolean },
	mounted: Iterable<ErrorReportable<N>>,
): number {
	let errors = 0;
	for (const diagram of mounted) {
		if (!diagram.hasError) continue;
		if (!root.contains(diagram.container)) continue;
		if (!isElementShown(diagram.container)) continue;
		errors++;
	}
	return errors;
}
