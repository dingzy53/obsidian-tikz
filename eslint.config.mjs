import obsidianmd from "eslint-plugin-obsidianmd";
import tseslint from "typescript-eslint";

/** Electron exists only in the desktop host; `desktop.ts` requires it lazily. */
const ELECTRON = {
	group: ["electron"],
	allowTypeImports: true,
	message: "Electron only exists on desktop: require it lazily in src/desktop.ts (AGENTS.md rule 1).",
};

export default tseslint.config(
	{
		ignores: ["main.js", "node_modules/**", "cache/**"],
	},
	...tseslint.configs.recommended,
	{
		files: ["**/*.ts"],
		rules: {
			// The codebase should not need `any`; AGENTS.md requires a comment
			// justifying any that appears.
			"@typescript-eslint/no-explicit-any": "error",
			"@typescript-eslint/no-unused-vars": [
				"error",
				{ argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
			],
		},
	},
	{
		// AGENTS.md rule 1: the plugin loads on mobile, where Node and Electron
		// do not exist. Node is loaded only by `loadNodeApi()` in `desktop.ts`,
		// with `require()` guarded by `Platform.isDesktop`, and every other
		// module reaches it through `nodeApi()`; `import type` stays allowed.
		// This is the rule Obsidian's community scanner runs, set as for
		// `isDesktopOnly: false` whatever manifest.json says today.
		files: ["src/**/*.ts"],
		plugins: { obsidianmd },
		rules: {
			"obsidianmd/no-nodejs-modules": ["error", { isDesktopOnly: false }],
			"@typescript-eslint/no-restricted-imports": ["error", { patterns: [ELECTRON] }],
		},
	},
	{
		// Only `desktop.ts` (loaded lazily, desktop only) may reach the modules
		// that run Node, so they stay out of the mobile load path.
		files: ["src/**/*.ts"],
		ignores: ["src/desktop.ts", "src/cache.ts", "src/compiler/engine.ts", "src/compiler/pathResolve.ts", "src/compiler/index.ts"],
		rules: {
			"@typescript-eslint/no-restricted-imports": [
				"error",
				{
					patterns: [
						ELECTRON,
						{
							// Exact module names: the pure siblings (`compiler/engineSpecs`,
							// `compiler/wrapSource`) stay importable.
							regex: "(^|/)(cache|desktop|compiler(/index|/engine|/pathResolve)?)$",
							allowTypeImports: true,
							message: "This module pulls Node into the mobile bundle path; reach it through DesktopServices (src/desktop.ts).",
						},
					],
				},
			],
		},
	},
);
