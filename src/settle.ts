/**
 * Waiting for the diagrams inside one element to finish (pure, no obsidian
 * import). Backs `plugin.api.whenSettled`, which other plugins (Folder to
 * PDF) call before printing a rendered note.
 */

/** `plugin.api`, read by other plugins through `app.plugins.plugins.tikz.api`. */
export interface TikzApi {
	/**
	 * Resolves once every diagram inside `root` has finished rendering, with
	 * the number of diagrams that show an error.
	 */
	whenSettled(root: HTMLElement): Promise<{ errors: number }>;
}

/** A mounted diagram: where it is, and its current render. */
export interface Settleable<N> {
	readonly container: N;
	/** Resolves (never rejects) when the current render has finished. */
	readonly settled: Promise<void>;
}

/**
 * Resolves once every diagram inside `root` has finished rendering. Checks
 * again after each wait, because embeds can mount new diagrams late and a
 * diagram can start a new render (for example when a shared file arrives).
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
