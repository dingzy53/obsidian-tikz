import { browser, expect } from '@wdio/globals';
import { describe, it } from 'mocha';

describe('Native TikZ E2E', function () {
	it('loads the tikz plugin on desktop and mobile emulation without Node crashes', async function () {
		const info = await browser.executeObsidian(({ app, obsidian }) => {
			const plugins = (app as unknown as { plugins: { enabledPlugins: Set<string>; plugins: Record<string, unknown> } }).plugins;
			const plugin = plugins.plugins['tikz'] as { desktop?: unknown; api?: { whenSettled?: unknown } } | undefined;
			return {
				enabled: plugins.enabledPlugins.has('tikz'),
				isDesktop: obsidian.Platform.isDesktop,
				hasDesktopServices: Boolean(plugin?.desktop),
				hasApi: typeof plugin?.api?.whenSettled === 'function',
			};
		});
		expect(info.enabled).toBe(true);
		expect(info.hasApi).toBe(true);
		expect(info.hasDesktopServices).toBe(info.isDesktop);
	});

	it('renders a tikz code block container gracefully in Reading view', async function () {
		await browser.executeObsidian(async ({ app }) => {
			const file = app.vault.getFileByPath('Diagram.md');
			if (!file) throw new Error('Missing Diagram.md');
			const leaf = app.workspace.getLeaf(false);
			await leaf.openFile(file, { state: { mode: 'preview' } });
			app.workspace.setActiveLeaf(leaf, { focus: true });
		});

		await browser.waitUntil(
			async () =>
				browser.executeObsidian(({ app, obsidian }) => {
					const view = app.workspace.getActiveViewOfType(obsidian.MarkdownView);
					return Boolean(view?.previewMode?.containerEl?.querySelector('.tikz-container'));
				}),
			{ timeout: 10000, timeoutMsg: 'Expected .tikz-container to render in Reading view' },
		);

		const boxState = await browser.executeObsidian(({ app, obsidian }) => {
			const view = app.workspace.getActiveViewOfType(obsidian.MarkdownView);
			const container = view?.previewMode?.containerEl?.querySelector('.tikz-container');
			return {
				hasContainer: Boolean(container),
				hasStatusOrSvg: Boolean(
					container?.querySelector('svg, .tikz-pending, .tikz-error, .tikz-loading'),
				),
			};
		});
		expect(boxState.hasContainer).toBe(true);
		expect(boxState.hasStatusOrSvg).toBe(true);
	});

	it('shows a 3,000-deep pgfplots surf and reports a two-page block (desktop with TeX)', async function () {
		this.timeout(120000);
		const isDesktop = await browser.executeObsidian(({ obsidian }) => obsidian.Platform.isDesktop);
		if (!isDesktop) this.skip(); // mobile never compiles

		const result = await browser.executeObsidian(async ({ app, obsidian }) => {
			const file = app.vault.getFileByPath('Surface.md');
			if (!file) throw new Error('Missing Surface.md');
			const leaf = app.workspace.getLeaf(false);
			await leaf.openFile(file, { state: { mode: 'preview' } });
			app.workspace.setActiveLeaf(leaf, { focus: true });
			const view = app.workspace.getActiveViewOfType(obsidian.MarkdownView);
			const root = view?.previewMode?.containerEl;
			if (!root) throw new Error('No reading view');
			const plugin = (app as unknown as { plugins: { plugins: Record<string, { api: { whenSettled(el: HTMLElement): Promise<unknown> } }> } }).plugins.plugins['tikz'];
			const deadline = Date.now() + 100000;
			while (root.querySelectorAll('.tikz-container').length < 2 && Date.now() < deadline) {
				await new Promise((resolve) => window.setTimeout(resolve, 200));
			}
			await plugin.api.whenSettled(root);
			const [surface, pages] = Array.from(root.querySelectorAll('.tikz-container'));
			const depth = (node: Element): number => {
				let max = 0;
				const stack: [Element, number][] = [[node, 0]];
				while (stack.length) {
					const [el, d] = stack.pop() as [Element, number];
					for (const child of Array.from(el.children)) {
						const cd = child.tagName.toLowerCase() === 'g' ? d + 1 : d;
						max = Math.max(max, cd);
						stack.push([child, cd]);
					}
				}
				return max;
			};
			const svg = surface?.querySelector('svg');
			return {
				surfaceError: surface?.querySelector('.tikz-error-summary')?.textContent ?? '',
				paths: svg ? svg.querySelectorAll('path').length : 0,
				depth: svg ? depth(svg) : -1,
				pagesError: pages?.querySelector('.tikz-error-summary')?.textContent ?? '',
			};
		});

		if (/not found|Could not start/.test(result.surfaceError)) this.skip(); // no TeX here (CI)
		expect(result.surfaceError).toBe('');
		expect(result.paths).toBeGreaterThan(29 * 29);
		expect(result.depth).toBeLessThan(16);
		expect(result.pagesError).toContain('2 pages');
	});

	it('renders all diagrams for mobile in parallel, and keeps settings across a plugin reload (desktop with TeX)', async function () {
		this.timeout(180000);
		const isDesktop = await browser.executeObsidian(({ obsidian }) => obsidian.Platform.isDesktop);
		if (!isDesktop) this.skip();

		const result = await browser.executeObsidian(async ({ app }) => {
			interface TikzPlugin {
				settings: Record<string, unknown>;
				saveSettings(): Promise<void>;
				sharedSync?: { renderAllMissing(): Promise<{ rendered: number; failed: number; cancelled: boolean }> };
				shared: { list(): { name: string }[] };
			}
			const plugins = (app as unknown as {
				plugins: { plugins: Record<string, TikzPlugin>; disablePlugin(id: string): Promise<void>; enablePlugin(id: string): Promise<boolean> };
			}).plugins;
			const plugin = plugins.plugins['tikz'];
			// This runs on a throwaway copy of test-vault.
			plugin.settings = {
				...plugin.settings,
				shareWithMobile: true,
				heavyPackages: 'all',
				maxConcurrentCompiles: 3,
				maxCacheEntries: 500,
			};
			await plugin.saveSettings();
			const report = await plugin.sharedSync?.renderAllMissing();
			const shared = plugin.shared.list().map((file) => file.name);

			// A disable/enable cycle reads data.json back from disk, as a restart does.
			await plugins.disablePlugin('tikz');
			await plugins.enablePlugin('tikz');
			const reloaded = plugins.plugins['tikz'];
			const after = { ...reloaded.settings };
			reloaded.settings = { ...reloaded.settings, shareWithMobile: false };
			await reloaded.saveSettings();
			return { report, shared, after };
		});

		// Diagram.md and the surface render; the two-page block fails.
		if (result.report && result.report.rendered === 0) this.skip(); // no TeX here (CI)
		expect(result.report).toEqual({ rendered: 2, failed: 1, cancelled: false });
		expect(result.shared).toHaveLength(2);
		for (const name of result.shared) expect(name).toMatch(/^[0-9a-f]{64}\.svg$/);
		expect(result.after.shareWithMobile).toBe(true);
		expect(result.after.heavyPackages).toBe('all');
		expect(result.after.maxConcurrentCompiles).toBe(3);
		// Saved at the current settings version: 500 is a choice now, not the old default.
		expect(result.after.maxCacheEntries).toBe(500);
	});

	it('registers its settings tab', async function () {
		const hasTab = await browser.executeObsidian(({ app }) => {
			const setting = (app as unknown as { setting?: { pluginTabs?: { id: string }[] } }).setting;
			return Boolean(setting?.pluginTabs?.some((tab) => tab.id === 'tikz'));
		});
		expect(hasTab).toBe(true);
	});
});
