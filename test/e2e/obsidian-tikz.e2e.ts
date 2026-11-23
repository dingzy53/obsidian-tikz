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

	it('registers its settings tab', async function () {
		const hasTab = await browser.executeObsidian(({ app }) => {
			const setting = (app as unknown as { setting?: { pluginTabs?: { id: string }[] } }).setting;
			return Boolean(setting?.pluginTabs?.some((tab) => tab.id === 'tikz'));
		});
		expect(hasTab).toBe(true);
	});
});
