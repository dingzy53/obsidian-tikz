import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		environment: "node",
		include: ["test/**/*.test.ts"],
		// The default worker-thread pool is blocked in some sandboxed/CI
		// environments; child processes work everywhere.
		pool: "forks",
		// The M1 integration matrix compiles real LaTeX documents.
		testTimeout: 90_000,
	},
});
