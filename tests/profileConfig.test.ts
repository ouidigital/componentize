import { describe, expect, it } from "vitest";

// The profile builder is an executable Node script, so it intentionally has no
// generated TypeScript declaration file. Its static parsing helpers are still
// imported directly to keep the config matrix unit-testable.
// @ts-expect-error No declaration file is needed for this test-only script import.
import { discoverImageLayout, parseImageLayoutConfig } from "../scripts/build-kit-profiles.mjs";

describe("kit image config discovery", () => {
	it("searches mjs, then ts, then js and parses a missing layout as null", async () => {
		const seen: string[] = [];
		const layout = await discoverImageLayout(async (path: string) => {
			seen.push(path);
			if (path === "astro.config.ts") return "export default defineConfig({});";
			return undefined;
		});

		expect(seen).toEqual(["astro.config.mjs", "astro.config.ts"]);
		expect(layout).toBe(null);
	});

	it("accepts every supported literal layout", () => {
		for (const layout of ["constrained", "full-width", "fixed", "none"] as const) {
			expect(
				parseImageLayoutConfig(
					`export default defineConfig({ image: { layout: "${layout}" } });`,
				),
			).toBe(layout);
		}
	});

	it("fails when no config is reachable", async () => {
		await expect(discoverImageLayout(async () => undefined)).rejects.toThrow(
			/astro\.config\.mjs.*astro\.config\.ts.*astro\.config\.js/,
		);
	});

	it("fails on dynamic, invalid, and unparseable layout values", () => {
		expect(() =>
			parseImageLayoutConfig(
				`const layout = "fixed"; export default defineConfig({ image: { layout } });`,
			),
		).toThrow(/dynamic|literal/);
		expect(() =>
			parseImageLayoutConfig(
				`export default defineConfig({ image: { layout: "responsive" } });`,
			),
		).toThrow(/supported string literal|constrained/);
		expect(() =>
			parseImageLayoutConfig("export default defineConfig({ image: { layout: });"),
		).toThrow(/parse/);
	});
});
