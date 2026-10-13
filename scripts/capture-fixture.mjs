#!/usr/bin/env node
/**
 * Captures a CodeStitch stitch page into tests/fixtures/.
 *
 * Usage: npm run fixtures -- <stitchId> [slug] [--page-only]
 *
 * Works against the logged-out demo dashboard, so fixtures are reproducible
 * without credentials. Writes the code fields plus the full page HTML (the
 * latter feeds the scraper tests).
 *
 * --page-only writes only tests/fixtures/pages/stitch-<id>.html. The derived
 * fixture folders feed the conversion snapshots, so refreshing the page a
 * scraper reads should not silently rewrite what every snapshot is built from.
 *
 * Since the October 2026 redesign the stitch arrives as inline JSON,
 * `window.GET_CODE = {...};`, with core styles in hidden textareas.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { parseHTML } from "linkedom";
import { codeFiles, extractGetCode, lf } from "./lib/get-code.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(__dirname, "..", "tests", "fixtures");

const args = process.argv.slice(2);
const pageOnly = args.includes("--page-only");
const [stitchId, slugArg] = args.filter((a) => !a.startsWith("--"));
if (!stitchId || !/^\d+$/.test(stitchId)) {
	console.error("Usage: npm run fixtures -- <stitchId> [slug] [--page-only]");
	process.exit(1);
}

const url = `https://app.codestitch.app/app/dashboard/stitches/${stitchId}`;
console.log(`Fetching ${url} …`);

const res = await fetch(url, {
	headers: {
		"User-Agent":
			"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36",
		Accept: "text/html,application/xhtml+xml",
	},
});
if (!res.ok) {
	console.error(`HTTP ${res.status} ${res.statusText}`);
	process.exit(1);
}
const pageHtml = await res.text();

const data = extractGetCode(pageHtml);
if (!data) {
	console.error("No window.GET_CODE script — layout changed, or the page needs auth.");
	process.exit(1);
}

await mkdir(join(FIXTURES, "pages"), { recursive: true });
await writeFile(join(FIXTURES, "pages", `stitch-${stitchId}.html`), pageHtml, "utf8");

const codes = data.stitch?.codes ?? [];
const files = codeFiles(codes);
if (!files["html.html"]) {
	console.warn("Warning: the HTML code is empty — a premium stitch, or one that needs sign-in.");
}

if (pageOnly) {
	console.log(`Wrote tests/fixtures/pages/stitch-${stitchId}.html (page only).`);
	process.exit(0);
}

/**
 * A browser returns textarea.value already entity-decoded; linkedom hands back
 * the raw escaped source. Decode here so fixtures match runtime input exactly.
 */
const NAMED = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
function decodeEntities(s) {
	return s.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (match, body) => {
		if (body[0] === "#") {
			const code =
				body[1] === "x" || body[1] === "X"
					? Number.parseInt(body.slice(2), 16)
					: Number.parseInt(body.slice(1), 10);
			return Number.isFinite(code) ? String.fromCodePoint(code) : match;
		}
		return NAMED[body.toLowerCase()] ?? match;
	});
}

const { document } = parseHTML(pageHtml);
for (const [flavour, key] of [["css", "CSS"], ["less", "LESS"], ["scss", "SCSS"]]) {
	const ta = document.querySelector(`#gc-core-${flavour}`);
	const value = decodeEntities(ta?.value ?? ta?.textContent ?? "");
	if (value.trim()) files[`core-styles-${key}.txt`] = lf(value);
}

const meta = {
	id: stitchId,
	url,
	sectionIds: [],
	heading: data.stitch?.category ?? null,
	title: data.stitch?.title ?? null,
	section: data.stitch?.section ?? null,
};
if (files["html.html"]) {
	const { document: frag } = parseHTML(`<body>${files["html.html"]}</body>`);
	meta.sectionIds = [...frag.querySelectorAll("section[id], header[id]")].map((el) =>
		el.getAttribute("id"),
	);
}

const slug = slugArg ?? (meta.sectionIds[0] ?? "stitch").replace(/-\d+$/, "");
const dir = join(FIXTURES, `stitch-${slug}-${stitchId}`);
await mkdir(dir, { recursive: true });

for (const [name, contents] of Object.entries(files)) {
	await writeFile(join(dir, name), contents, "utf8");
}
await writeFile(join(dir, "meta.json"), `${JSON.stringify(meta, null, 2)}\n`, "utf8");

console.log(`Wrote ${Object.keys(files).length + 1} files to tests/fixtures/stitch-${slug}-${stitchId}/`);
console.log(`  sections: ${meta.sectionIds.join(", ") || "(none)"}  heading: ${meta.heading ?? "-"}`);
console.log(`  variants: ${Object.keys(files).join(", ")}`);
