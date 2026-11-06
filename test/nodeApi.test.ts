import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { nodeApi, provideNodeApi, resetNodeApi, type NodeApi } from "../src/nodeApi";

describe("nodeApi", () => {
	const original = nodeApi();
	afterEach(() => provideNodeApi(original));

	it("throws until the desktop app has provided the modules", () => {
		resetNodeApi();
		expect(() => nodeApi()).toThrow("Node.js APIs are only available in the desktop app.");
	});

	it("returns what was provided", () => {
		const api = { ...original, path } as NodeApi;
		provideNodeApi(api);
		expect(nodeApi()).toBe(api);
	});
});
