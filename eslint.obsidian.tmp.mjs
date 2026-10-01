import obsidianmd from "/tmp/claude-0/-home-user-obsidian-tikz/c06b1379-35b7-5ab0-a36c-d475c7428dc3/scratchpad/lint/node_modules/eslint-plugin-obsidianmd/dist/lib/index.js";
import tseslint from "/tmp/claude-0/-home-user-obsidian-tikz/c06b1379-35b7-5ab0-a36c-d475c7428dc3/scratchpad/lint/node_modules/typescript-eslint/dist/index.js";

export default [
	{ ignores: ["main.js", "node_modules/**", "test/**", "*.config.*", "eslint.obsidian.tmp.mjs"] },
	...tseslint.configs.recommended,
	...obsidianmd.configs.recommended,
	{
		files: ["src/**/*.ts"],
		languageOptions: { parserOptions: { project: "./tsconfig.json", tsconfigRootDir: import.meta.dirname } },
	},
];
