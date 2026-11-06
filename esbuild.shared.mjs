import { builtinModules } from "node:module";

// Both spellings: `fs` and `node:fs` are the same module to Node.
const builtins = [...builtinModules, ...builtinModules.map((name) => `node:${name}`)];

/**
 * sax (via svgo) probes `require("stream")` at load time inside a try/catch,
 * only for its streaming API, which svgo never uses; without it sax falls back
 * to a no-op base class. Resolving it to an empty module keeps that probe out
 * of the bundle, so the mobile load path requests no Node module at all (on
 * Obsidian's mobile emulation the probe would show a "NodeJS package" notice).
 */
const emptySaxStream = {
	name: "empty-sax-stream",
	setup(build) {
		build.onResolve({ filter: /^stream$/ }, (args) =>
			/[\\/]sax[\\/]/.test(args.importer) ? { path: "stream", namespace: "empty-sax-stream" } : undefined,
		);
		build.onLoad({ filter: /.*/, namespace: "empty-sax-stream" }, () => ({
			contents: "module.exports = {};",
			loader: "js",
		}));
	},
};

/**
 * Bundle options shared by `esbuild.config.mjs` and `test/mobileLoad.test.ts`,
 * so the test exercises exactly what ships.
 *
 * This plugin shells out to a local TeX distribution on desktop, so it is a
 * Node (not browser) bundle: `child_process`, `fs`, `os` and `path` are real
 * requires at runtime there, reached only through the lazily loaded
 * `src/desktop.ts`. `obsidian` and `electron` are provided by the host app.
 */
export const bundleOptions = {
	entryPoints: ["src/main.ts"],
	bundle: true,
	external: ["obsidian", "electron", "@codemirror/*", ...builtins],
	plugins: [emptySaxStream],
	format: "cjs",
	platform: "node",
	target: "es2022",
	treeShaking: true,
};
