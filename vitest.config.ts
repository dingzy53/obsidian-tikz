import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		environment: "node",
		include: ["test/**/*.test.ts"],
		exclude: ["test/e2e/**", ".obsidian-cache/**", "node_modules/**"],
		setupFiles: ["test/setup/nodeApi.ts"],
		pool: "forks",
		testTimeout: 90_000,
	},
});
