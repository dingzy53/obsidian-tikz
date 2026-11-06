import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		environment: "node",
		include: ["test/**/*.test.ts"],
		// The desktop modules reach Node through `nodeApi()` (AGENTS.md rule 1);
		// tests provide the real modules, as `desktop.ts` does in Obsidian.
		setupFiles: ["test/setup/nodeApi.ts"],
		// The default worker-thread pool is blocked in some sandboxed/CI
		// environments; child processes work everywhere.
		pool: "forks",
		// The M1 integration matrix compiles real LaTeX documents.
		testTimeout: 90_000,
	},
});
