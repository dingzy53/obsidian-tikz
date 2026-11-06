/**
 * The plugin must load and work on a phone, where Node and Electron do not
 * exist (AGENTS.md rule 1). This builds the real bundle and runs it in a VM
 * whose `require` serves only a stub `obsidian` module: any Node module
 * requested on the mobile path fails the test.
 *
 * Covered, on a phone and under Obsidian's mobile emulation: module
 * evaluation, `onload()`, the settings tab on mobile, and the code block processor showing a diagram
 * from the shared folder (or "not rendered yet" without one). A small fake
 * element stands in for the DOM; the SVG still goes through the real
 * sanitiser in the bundle.
 */

import * as childProcess from "node:child_process";
import * as nodeCrypto from "node:crypto";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as timers from "node:timers";
import * as vm from "node:vm";
import esbuild from "esbuild";
import { describe, expect, it } from "vitest";
import { tidyTikzSource } from "../src/compiler/wrapSource";
import { bundleOptions } from "../esbuild.shared.mjs";

const ROOT = path.resolve(__dirname, "..");

/** The shipped bundle options (`esbuild.shared.mjs`), built in memory. */
async function buildBundle(): Promise<string> {
	const result = await esbuild.build({
		...bundleOptions,
		entryPoints: [path.join(ROOT, "src/main.ts")],
		write: false,
		logLevel: "silent",
	});
	const file = result.outputFiles[0];
	if (!file) throw new Error("esbuild produced no output");
	return file.text;
}

/** The document every fake element belongs to (`el.doc`), and the VM's `document`. */
const fakeDocument = {
	importNode: (node: { markup: string }): FakeElement => {
		const el = new FakeElement({ cls: "imported-svg" });
		el.imported = node.markup;
		return el;
	},
	body: { classList: { contains: (): boolean => false } },
};

// --- A minimal DOM stand-in -------------------------------------------------

class FakeElement {
	children: FakeElement[] = [];
	classes = new Set<string>();
	attributes = new Map<string, string>();
	text = "";
	imported: string | null = null;
	listeners: Record<string, (evt: unknown) => void> = {};

	/** Obsidian's `Node.doc`: the element's own window document. */
	get doc(): typeof fakeDocument {
		return fakeDocument;
	}

	constructor(options?: { cls?: string; text?: string }) {
		if (options?.cls) for (const cls of options.cls.split(" ")) this.classes.add(cls);
		if (options?.text) this.text = options.text;
	}
	createDiv(options?: { cls?: string; text?: string }): FakeElement {
		const child = new FakeElement(options);
		this.children.push(child);
		return child;
	}
	createSpan(options?: { cls?: string; text?: string }): FakeElement {
		return this.createDiv(options);
	}
	createEl(_tag: string, options?: { cls?: string; text?: string }): FakeElement {
		return this.createDiv(options);
	}
	empty(): void {
		this.children = [];
	}
	setText(text: string): void {
		this.text = text;
	}
	appendChild(child: FakeElement): void {
		this.children.push(child);
	}
	toggleClass(cls: string, on: boolean): void {
		if (on) this.classes.add(cls);
		else this.classes.delete(cls);
	}
	addClass(cls: string): void {
		this.classes.add(cls);
	}
	get classList(): { toggle(c: string, on?: boolean): void; remove(c: string): void; contains(c: string): boolean } {
		return {
			toggle: (c, on) => this.toggleClass(c, on ?? !this.classes.has(c)),
			remove: (c) => this.classes.delete(c),
			contains: (c) => this.classes.has(c),
		};
	}
	setAttribute(name: string, value: string): void {
		this.attributes.set(name, value);
	}
	removeAttribute(name: string): void {
		this.attributes.delete(name);
	}
	/** Every descendant, depth first. */
	all(): FakeElement[] {
		return this.children.flatMap((child) => [child, ...child.all()]);
	}
}

// --- A stub `obsidian` module -----------------------------------------------

interface Harness {
	obsidian: Record<string, unknown>;
	processors: Map<string, (source: string, el: FakeElement, ctx: unknown) => void>;
	files: Map<string, string>;
	notices: string[];
}

function createHarness(platform: PlatformFlags): Harness {
	const processors = new Map<string, (source: string, el: FakeElement, ctx: unknown) => void>();
	const files = new Map<string, string>();
	const notices: string[] = [];

	class Component {
		private callbacks: (() => void)[] = [];
		load(): void {
			(this as unknown as { onload?: () => void }).onload?.();
		}
		unload(): void {
			(this as unknown as { onunload?: () => void }).onunload?.();
			for (const callback of this.callbacks) callback();
		}
		register(callback: () => void): void {
			this.callbacks.push(callback);
		}
		registerEvent(): void {}
		registerDomEvent(el: FakeElement, type: string, callback: (evt: unknown) => void): void {
			el.listeners[type] = callback;
		}
	}
	class Plugin extends Component {
		constructor(
			public app: unknown,
			public manifest: unknown,
		) {
			super();
		}
		async loadData(): Promise<unknown> {
			return null;
		}
		async saveData(): Promise<void> {}
		addSettingTab(tab: unknown): void {
			(this as unknown as { tab: unknown }).tab = tab;
		}
		registerMarkdownCodeBlockProcessor(
			language: string,
			handler: (source: string, el: FakeElement, ctx: unknown) => void,
		): void {
			processors.set(language, handler);
		}
	}
	class MarkdownRenderChild extends Component {
		constructor(public containerEl: FakeElement) {
			super();
		}
	}
	class Modal {
		constructor(public app: unknown) {}
		open(): void {}
		close(): void {}
	}
	class PluginSettingTab {
		constructor(
			public app: unknown,
			public plugin: unknown,
		) {}
		update(): void {}
	}
	class Notice {
		constructor(message: string) {
			notices.push(message);
		}
		hide(): void {}
		setMessage(): void {}
	}
	class TAbstractFile {
		constructor(public path: string) {}
		get name(): string {
			return this.path.split("/").pop() ?? "";
		}
	}
	class TFile extends TAbstractFile {
		get basename(): string {
			return this.name.replace(/\.[^.]*$/, "");
		}
	}
	class TFolder extends TAbstractFile {
		children: TFile[] = [];
	}

	const obsidian = {
		Plugin,
		MarkdownRenderChild,
		Modal,
		PluginSettingTab,
		Notice,
		Setting: class {},
		TFile,
		TFolder,
		FileSystemAdapter: class {
			constructor(private readonly basePath: string) {}
			getBasePath(): string {
				return this.basePath;
			}
		},
		Platform: platform,
		normalizePath: (p: string) => p.replace(/\/{2,}/g, "/").replace(/^\/|\/$/g, ""),
		setIcon: () => undefined,
		setTooltip: () => undefined,
	};
	return { obsidian, processors, files, notices };
}

function createApp(harness: Harness, vaultPath = "/nonexistent-vault"): unknown {
	const { TFile, TFolder, FileSystemAdapter } = harness.obsidian as {
		TFile: new (path: string) => { path: string };
		TFolder: new (path: string) => { path: string; children: unknown[] };
		FileSystemAdapter: new (basePath: string) => unknown;
	};
	return {
		vault: {
			adapter: new FileSystemAdapter(vaultPath),
			configDir: ".obsidian",
			getFileByPath: (p: string) => (harness.files.has(p) ? new TFile(p) : null),
			getFolderByPath: (p: string) => {
				const prefix = `${p}/`;
				const names = [...harness.files.keys()].filter((f) => f.startsWith(prefix));
				if (names.length === 0) return null;
				const folder = new TFolder(p);
				folder.children = names.map((n) => new TFile(n));
				return folder;
			},
			cachedRead: async (file: { path: string }) => harness.files.get(file.path) ?? "",
			getMarkdownFiles: () => [],
			on: () => ({}),
		},
		workspace: {
			on: () => ({}),
			onLayoutReady: (callback: () => void) => callback(),
		},
	};
}

/**
 * Loads the bundle in a VM; returns what it exported and every module it asked
 * for. Without `nodeModules` (a phone) any module but `obsidian` throws.
 */
function loadBundle(
	code: string,
	harness: Harness,
	nodeModules?: Record<string, unknown>,
): { Plugin: new (app: unknown, manifest: unknown) => unknown; requested: string[] } {
	const requested: string[] = [];
	const module = { exports: {} as Record<string, unknown> };
	const timers = {
		setTimeout: () => 0,
		clearTimeout: () => undefined,
		setInterval: () => 0,
		clearInterval: () => undefined,
	};
	class FakeDOMParser {
		parseFromString(markup: string): unknown {
			return { getElementsByTagName: () => [], documentElement: { markup } };
		}
	}
	const document = fakeDocument;
	const context = vm.createContext({
		module,
		exports: module.exports,
		require: (name: string) => {
			requested.push(name);
			if (name === "obsidian") return harness.obsidian;
			if (nodeModules && name in nodeModules) return nodeModules[name];
			throw new Error(`Cannot find module '${name}' (mobile has no Node)`);
		},
		console,
		crypto: globalThis.crypto,
		TextEncoder,
		TextDecoder,
		window: { ...timers },
		...timers,
		document,
		activeDocument: document,
		DOMParser: FakeDOMParser,
		navigator: {},
		createFragment: () => new FakeElement(),
	});
	vm.runInContext(code, context, { filename: "main.js" });
	const exported = module.exports as { default?: unknown };
	const Plugin = (exported.default ?? module.exports) as new (app: unknown, manifest: unknown) => unknown;
	return { Plugin, requested };
}

function nodeRequests(requested: string[]): string[] {
	// Strict: even a probe inside try/catch counts, since Obsidian's mobile
	// emulation reports each one to the user.
	return requested.filter((name) => name !== "obsidian");
}

/** Waits for an async render (WebCrypto digests run off the main thread). */
async function waitFor(condition: () => boolean, timeoutMs = 5000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!condition()) {
		if (Date.now() > deadline) throw new Error("timed out waiting for the render");
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}

function sharedKey(tidied: string): string {
	return createHash("sha256").update(`tikz-shared-v1\u0000${tidied}`, "utf8").digest("hex");
}

interface PlatformFlags {
	isDesktop: boolean;
	isDesktopApp: boolean;
	isMobile: boolean;
	isMobileApp: boolean;
}

/**
 * A phone, and Obsidian's mobile emulation on desktop (`dev:mobile on`), which
 * flips `isMobile`/`isDesktop` but leaves `isDesktopApp` true while refusing
 * Node modules to plugins (Obsidian 1.15 `loadPlugin`).
 */
const PLATFORMS: [string, PlatformFlags][] = [
	["phone", { isDesktop: false, isDesktopApp: false, isMobile: true, isMobileApp: true }],
	["desktop mobile emulation", { isDesktop: false, isDesktopApp: true, isMobile: true, isMobileApp: false }],
];

describe("mobile load path (no Node)", () => {
	const SVG =
		`<svg xmlns='http://www.w3.org/2000/svg' width='10pt' height='10pt' viewBox='0 0 10 10'>` +
		`<defs><path id='g0-1' d='M0 0h5v5H0z'/></defs><g fill='#000'><use xlink:href='#g0-1' ` +
		`xmlns:xlink='http://www.w3.org/1999/xlink'/></g><script>alert(1)</script></svg>`;
	const SOURCE = "\\begin{tikzpicture}\n  \\draw (0,0) rectangle (1,1);\n\\end{tikzpicture}";

	it.each(PLATFORMS)("%s: evaluates, loads, and shows a shared diagram without requesting any Node module", async (_name, platform) => {
		const code = await buildBundle();
		const harness = createHarness(platform);
		const { Plugin, requested } = loadBundle(code, harness);
		expect(nodeRequests(requested)).toEqual([]);

		const key = sharedKey(tidyTikzSource(SOURCE));
		harness.files.set(`TikZ cache/${key}.svg`, SVG);

		const plugin = new Plugin(createApp(harness), { id: "tikz", dir: ".obsidian/plugins/tikz" }) as {
			onload(): Promise<void>;
			desktop: unknown;
			tab: { getSettingDefinitions(): unknown[] };
		};
		await plugin.onload();
		expect(plugin.desktop).toBeUndefined();
		expect(nodeRequests(requested)).toEqual([]);

		// The processor renders from the shared folder.
		const processor = harness.processors.get("tikz");
		expect(processor).toBeDefined();
		const host = new FakeElement();
		const children: { load(): void }[] = [];
		processor?.(SOURCE, host, { addChild: (child: { load(): void }) => { children.push(child); child.load(); } });
		await waitFor(() => host.all().some((el) => el.imported !== null || el.classes.has("tikz-pending") || el.classes.has("tikz-error")));

		const svg = host.all().find((el) => el.imported !== null);
		expect(svg?.imported).toContain("<svg");
		// Synced files are untrusted: the real sanitiser ran (script gone, ids
		// namespaced) even though nothing was compiled here.
		expect(svg?.imported).not.toContain("script");
		expect(svg?.imported).toMatch(/id="tikz-[0-9a-f]{8}-g0-1"/);
		expect(host.all().some((el) => el.classes.has("tikz-pending"))).toBe(false);

		// A block with no shared file yet says so, without an error.
		const missing = new FakeElement();
		processor?.("\\draw (5,5) circle (1);", missing, { addChild: (child: { load(): void }) => child.load() });
		await waitFor(() => missing.all().some((el) => el.classes.has("tikz-pending") || el.classes.has("tikz-error")));
		expect(missing.all().some((el) => el.classes.has("tikz-pending"))).toBe(true);
		expect(missing.all().some((el) => el.classes.has("tikz-error"))).toBe(false);

		// The settings tab only shows rows that work here, and building it
		// touches nothing desktop-only.
		const definitions = plugin.tab.getSettingDefinitions() as {
			heading?: string;
			visible?: boolean | (() => boolean);
			items?: { name: string; visible?: boolean | (() => boolean) }[];
		}[];
		const shown = (item: { visible?: boolean | (() => boolean) }): boolean =>
			typeof item.visible === "function" ? item.visible() : item.visible !== false;
		// Obsidian runs every row's `render`, hidden or not (1.15), so none may
		// reach for desktop services; a throw would abort the whole tab.
		const fakeSetting = (): unknown => {
			const setting: Record<string, unknown> = new Proxy(
				{ settingEl: new FakeElement(), controlEl: new FakeElement() },
				{ get: (target, prop) => (prop in target ? target[prop as keyof typeof target] : () => setting) },
			);
			return setting;
		};
		for (const group of definitions as { items?: { render?: (setting: unknown) => void }[] }[]) {
			for (const item of group.items ?? []) expect(() => item.render?.(fakeSetting())).not.toThrow();
		}
		const visibleGroups = definitions.filter(shown).map((group) => group.heading);
		expect(visibleGroups).toEqual(["Rendering", "Mobile"]);
		const mobileRows = definitions
			.find((group) => group.heading === "Mobile")
			?.items?.filter(shown)
			.map((item) => item.name);
		// "Delete shared diagrams" shows because the folder holds a file.
		expect(mobileRows).toEqual(["Diagrams on this device", "Shared folder", "Shared diagrams", "Delete shared diagrams"]);
		expect(nodeRequests(requested)).toEqual([]);
	}, 60_000);
});

/** Everything `loadNodeApi()` in `desktop.ts` requires, and nothing else. */
const NODE_MODULES = [
	"node:child_process",
	"node:crypto",
	"node:fs",
	"node:fs/promises",
	"node:os",
	"node:path",
	"node:timers",
];

describe("Node.js loading (AGENTS.md rule 1)", () => {
	it("loads Node only in loadNodeApi, after its Platform.isDesktop guard, and never with import()", async () => {
		const code = await buildBundle();
		// A native dynamic import of a Node module fails in Obsidian's renderer;
		// it must go through the plugin's `require`.
		expect(code).not.toMatch(/\bimport\(\s*["']node:/);

		const requires = [...code.matchAll(/\brequire\(\s*["'](node:[^"']+)["']\s*\)/g)].map((m) => m[1]);
		expect([...requires].sort()).toEqual(NODE_MODULES);

		const start = code.indexOf("function loadNodeApi()");
		expect(start).toBeGreaterThan(-1);
		const body = code.slice(start, code.indexOf("return api;", start));
		const guard = body.search(/if \(!import_obsidian\d*\.Platform\.isDesktop\)/);
		expect(guard).toBeGreaterThan(-1);
		for (const name of NODE_MODULES) {
			const at = body.indexOf(`require("${name}")`);
			expect(at, name).toBeGreaterThan(guard);
		}
	}, 60_000);

	it("desktop: loads the desktop services through the plugin's require", async () => {
		const code = await buildBundle();
		const harness = createHarness({ isDesktop: true, isDesktopApp: true, isMobile: false, isMobileApp: false });
		const scratch = await fsp.mkdtemp(path.join(os.tmpdir(), "tikz-desktop-load-"));
		try {
			// `tmpdir` is redirected so the scratch-directory sweep at startup
			// only ever sees this test's own folder.
			const sandboxOs = { ...os, tmpdir: () => scratch };
			const { Plugin, requested } = loadBundle(code, harness, {
				"node:child_process": childProcess,
				"node:crypto": nodeCrypto,
				"node:fs": fs,
				"node:fs/promises": fsp,
				"node:os": sandboxOs,
				"node:path": path,
				"node:timers": timers,
			});
			// Nothing is requested at bundle load, even on desktop.
			expect(nodeRequests(requested)).toEqual([]);

			const vault = path.join(scratch, "vault");
			const plugin = new Plugin(createApp(harness, vault), { id: "tikz", dir: ".obsidian/plugins/tikz" }) as {
				onload(): Promise<void>;
				desktop?: { pluginDir: string; cache: { directory: string } };
			};
			await plugin.onload();

			expect(plugin.desktop?.pluginDir).toBe(path.join(vault, ".obsidian/plugins/tikz"));
			expect(fs.existsSync(plugin.desktop?.cache.directory ?? "")).toBe(true);
			expect([...new Set(nodeRequests(requested))].sort()).toEqual(NODE_MODULES);
		} finally {
			await fsp.rm(scratch, { recursive: true, force: true });
		}
	}, 60_000);
});
