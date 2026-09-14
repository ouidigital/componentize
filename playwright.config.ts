import { defineConfig } from "@playwright/test";

export default defineConfig({
	testDir: "./tests/e2e",
	fullyParallel: false,
	workers: 1,
	reporter: [["list"]],
	timeout: 60_000,
	use: {
		// Extensions require a persistent context, created per test.
		headless: true,
	},
});
