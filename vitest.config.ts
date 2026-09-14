import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
	resolve: {
		alias: {
			"@core": r("./src/core"),
			"@content": r("./src/content"),
			"@ui": r("./src/ui"),
			"@output": r("./src/output"),
			"@tests": r("./tests"),
		},
	},
	test: {
		environment: "happy-dom",
		include: ["tests/**/*.test.ts"],
		exclude: ["tests/e2e/**"],
		// Saved CodeStitch pages reference analytics/iframes; tests must never
		// hit the network to parse a fixture.
		environmentOptions: {
			happyDOM: {
				settings: {
					disableJavaScriptFileLoading: true,
					disableJavaScriptEvaluation: true,
					disableCSSFileLoading: true,
					// Stitch markup can contain third-party iframes (an embedded map
					// in a contact form, for instance). They must survive into the
					// component, so they are not stripped — but nothing may try to
					// fetch them, or the failures drown out real test output.
					navigation: {
						disableMainFrameNavigation: true,
						disableChildFrameNavigation: true,
						disableChildPageNavigation: true,
					},
				},
			},
		},
	},
});
