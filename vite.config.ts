import { defineConfig } from "vite";
import { crx } from "@crxjs/vite-plugin";
import { fileURLToPath } from "node:url";
import manifest from "./manifest.config.ts";
import { asciiOutput } from "./build/ascii-output.ts";

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
	plugins: [crx({ manifest }), asciiOutput()],
	resolve: {
		alias: {
			"@core": r("./src/core"),
			"@content": r("./src/content"),
			"@ui": r("./src/ui"),
			"@output": r("./src/output"),
			"@tests": r("./tests"),
		},
	},
	build: {
		target: "chrome120",
		emptyOutDir: true,
	},
});
