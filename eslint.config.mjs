import tseslint from "typescript-eslint";

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
		// do not exist. Only `desktop.ts` (loaded lazily, desktop only) and the
		// modules behind it may use them. Type-only imports are erased, so they
		// stay allowed.
		files: ["src/**/*.ts"],
		ignores: ["src/desktop.ts", "src/cache.ts", "src/compiler/engine.ts", "src/compiler/pathResolve.ts", "src/compiler/index.ts"],
		rules: {
			"@typescript-eslint/no-restricted-imports": [
				"error",
				{
					patterns: [
						{
							group: ["node:*", "electron", "fs", "fs/*", "os", "path", "child_process", "crypto"],
							message: "Node/Electron only exist on desktop: use them from src/desktop.ts (AGENTS.md rule 1).",
						},
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
