#!/usr/bin/env node
/**
 * Captures a CodeStitch stitch page into tests/fixtures/.
 *
 * Usage: npm run fixtures -- <stitchId> [slug]
 *
 * Works against the logged-out demo dashboard, so fixtures are reproducible
 * without credentials. Writes the raw code fields plus the full page HTML
 * (the latter feeds the scraper tests).
 */
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { parseHTML } from "linkedom";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(__dirname, "..", "tests", "fixtures");

const [, , stitchId, slugArg] = process.argv;
if (!stitchId || !/^\d+$/.test(stitchId)) {
	console.error("Usage: npm run fixtures -- <stitchId> [slug]");
	process.exit(1);
}

const url = `https://codestitch.app/app/dashboard/stitches/${stitchId}`;
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
const { document } = parseHTML(pageHtml);

const tabs = [...document.querySelectorAll("#CODE_TABS .CODE_TABS__BODY div.tab[data-codeid]")];
if (tabs.length === 0) {
	console.error("No code tabs found — layout changed, or the page needs auth.");
	process.exit(1);
}

/**
 * A browser returns textarea.value already entity-decoded; linkedom hands back
 * the raw escaped source. Decode here so fixtures match runtime input exactly.
 */
const NAMED = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
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

const byId = new Map();
for (const tab of tabs) {
	const ta = tab.querySelector("textarea.CODE-TEXTAREA");
	const raw = ta?.value ?? ta?.textContent ?? "";
	const value = decodeEntities(raw);
	if (value.trim()) byId.set(tab.getAttribute("data-codeid"), value);
}

const files = {};
const meta = { id: stitchId, url, sectionIds: [], heading: null };

for (const a of document.querySelectorAll("a.code_list_link[data-codeid][data-codetype]")) {
	const type = a.getAttribute("data-codetype");
	const code = byId.get(a.getAttribute("data-codeid"));
	if (!code) continue;
	if (type === "html") files["html.html"] = code;
	if (type === "js") files["js.js"] = code;
}

for (const radio of document.querySelectorAll("input.radio-styles[data-css-type]")) {
	const variant = radio.getAttribute("data-css-type");
	const code = byId.get(radio.getAttribute("value"));
	if (code) files[`css-${variant.replace(/\s+/g, "-")}.txt`] = code;
}

for (const key of ["CSS", "LESS", "SCSS"]) {
	const code = byId.get(`core-styles-${key}`);
	if (code) files[`core-styles-${key}.txt`] = code;
}

meta.heading = document.querySelector("h2.heading")?.textContent?.trim() ?? null;

if (files["html.html"]) {
	const { document: frag } = parseHTML(`<body>${files["html.html"]}</body>`);
	meta.sectionIds = [...frag.querySelectorAll("section[id], header[id]")].map((el) =>
		el.getAttribute("id"),
	);
}

const slug = slugArg ?? (meta.sectionIds[0] ?? "stitch").replace(/-\d+$/, "");
const dir = join(FIXTURES, `stitch-${slug}-${stitchId}`);
await mkdir(dir, { recursive: true });
await mkdir(join(FIXTURES, "pages"), { recursive: true });

for (const [name, contents] of Object.entries(files)) {
	await writeFile(join(dir, name), contents, "utf8");
}
await writeFile(join(dir, "meta.json"), `${JSON.stringify(meta, null, 2)}\n`, "utf8");
await writeFile(join(FIXTURES, "pages", `stitch-${stitchId}.html`), pageHtml, "utf8");

console.log(`Wrote ${Object.keys(files).length + 1} files to tests/fixtures/stitch-${slug}-${stitchId}/`);
console.log(`  sections: ${meta.sectionIds.join(", ") || "(none)"}  heading: ${meta.heading ?? "-"}`);
console.log(`  variants: ${Object.keys(files).join(", ")}`);
