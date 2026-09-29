import { defineManifest } from "@crxjs/vite-plugin";
import pkg from "./package.json" with { type: "json" };

/**
 * Production manifest — CodeStitch only.
 *
 * The E2E suite uses Playwright request interception against real CodeStitch
 * origins so it exercises the same host match patterns users install.
 */
export default defineManifest({
	manifest_version: 3,
	name: "Componentize — CodeStitch to Astro",
	version: pkg.version,
	description:
		"Convert CodeStitch snippets into kit-ready Astro components in one click.",
	icons: {
		16: "icons/icon-16.png",
		48: "icons/icon-48.png",
		128: "icons/icon-128.png",
	},
	content_scripts: [
		{
			// Keep the apex host for existing bookmarks while allowing the app (and
			// future CodeStitch app subdomains) to receive the panel.
			matches: [
				"https://codestitch.app/app/dashboard/stitches/*",
				"https://*.codestitch.app/app/dashboard/stitches/*",
			],
			// /stitches/<id>/rendered is the live preview of the stitch and holds
			// no code fields; the panel has nothing to do there.
			exclude_matches: [
				"https://codestitch.app/app/dashboard/stitches/*/rendered",
				"https://codestitch.app/app/dashboard/stitches/*/rendered/*",
				"https://codestitch.app/app/dashboard/stitches/*/*",
				"https://*.codestitch.app/app/dashboard/stitches/*/rendered",
				"https://*.codestitch.app/app/dashboard/stitches/*/rendered/*",
				"https://*.codestitch.app/app/dashboard/stitches/*/*",
			],
			js: ["src/content/content-script.ts"],
			run_at: "document_idle",
		},
	],
	background: {
		service_worker: "src/background/worker.ts",
		type: "module",
	},
	permissions: ["storage"],
	// Asset downloading only. Exact hosts are re-checked in the worker; the
	// wildcard here is the narrowest pattern Chrome accepts for both CDN hosts.
	host_permissions: ["https://*.digitaloceanspaces.com/*"],
});
