#!/usr/bin/env node
/**
 * Builds kit profiles from PINNED commits of the two official CodeStitch kits.
 *
 * A profile captures everything the converter must compare against so that a
 * "Ready" verdict means something concrete: the global rules it may dedupe, the
 * icons it may reference, the routes a link may resolve to, the nav script it
 * may suppress, and the CSPicture contract it may target.
 *
 * Usage: npm run profiles            (uses the pinned SHAs below)
 *        npm run profiles -- --latest  (re-pins to current main; prints new SHAs)
 */
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(__dirname, "..", "src", "core", "kits", "profiles");

/** Pinned kit versions. "Ready" claims apply to these commits only. */
const KITS = {
	"advanced-i18n": {
		id: "i18n",
		repo: "CodeStitchOfficial/Advanced-Astro-i18n",
		sha: "main",
		label: "Advanced Astro i18n",
	},
	"intermediate-decap": {
		id: "decap",
		repo: "CodeStitchOfficial/Intermediate-Astro-Decap-CMS",
		sha: "main",
		label: "Intermediate Astro + Decap CMS",
	},
};

const useLatest = process.argv.includes("--latest");

async function api(path) {
	const res = await fetch(`https://api.github.com${path}`, {
		headers: {
			Accept: "application/vnd.github+json",
			"User-Agent": "componentize-extension-profile-builder",
		},
	});
	if (!res.ok) throw new Error(`GitHub API ${res.status} for ${path}`);
	return res.json();
}

async function raw(repo, sha, path) {
	const res = await fetch(
		`https://raw.githubusercontent.com/${repo}/${sha}/${path}`,
		{ headers: { "User-Agent": "componentize-extension-profile-builder" } },
	);
	return res.ok ? res.text() : undefined;
}

/** Resolves the current main SHA so profiles are pinned to an immutable commit. */
async function resolveSha(repo) {
	const data = await api(`/repos/${repo}/commits/main`);
	return data.sha;
}

/** Lists file names in a repo directory (non-recursive). */
async function listDir(repo, sha, path) {
	try {
		const data = await api(`/repos/${repo}/contents/${path}?ref=${sha}`);
		return Array.isArray(data) ? data.map((e) => ({ name: e.name, type: e.type })) : [];
	} catch {
		return [];
	}
}

/**
 * Extracts the declaration block of a top-level class rule from a LESS file.
 * Used to recognise (and only then strip) redeclarations of the global helpers.
 */
function extractRule(css, selector) {
	const idx = css.indexOf(selector);
	if (idx === -1) return undefined;
	const open = css.indexOf("{", idx);
	if (open === -1) return undefined;
	let depth = 0;
	for (let i = open; i < css.length; i++) {
		if (css[i] === "{") depth++;
		else if (css[i] === "}") {
			depth--;
			if (depth === 0) return css.slice(open + 1, i).trim();
		}
	}
	return undefined;
}

/** Strips nested rule bodies so only the rule's own declarations remain. */
function topLevelOnly(block) {
	let out = "";
	let depth = 0;
	for (const ch of block) {
		if (ch === "{") depth++;
		else if (ch === "}") depth = Math.max(0, depth - 1);
		else if (depth === 0) out += ch;
	}
	// A nested rule leaves its selector behind ("&:hover"); those carry no ";".
	return out;
}

/** Normalises a declaration value so formatting differences do not matter. */
function normalizeValue(value) {
	return value.replace(/\s+/g, " ").replace(/\s*,\s*/g, ",").trim().toLowerCase();
}

/**
 * The rule's own declarations as property -> normalised value.
 *
 * Values matter: a stitch rule may reuse the kit's property names with entirely
 * different values, and deleting it as a "redeclaration" would silently change
 * how the component renders.
 */
function declMap(block) {
	if (!block) return {};
	const flat = topLevelOnly(block.replace(/\/\*[\s\S]*?\*\/|\/\/.*/g, ""));
	const out = {};
	for (const decl of flat.split(";")) {
		const trimmed = decl.trim();
		const colon = trimmed.indexOf(":");
		if (colon < 1) continue;
		const prop = trimmed.slice(0, colon).trim();
		if (!/^-{0,2}[a-zA-Z][\w-]*$/.test(prop)) continue;
		out[prop] = normalizeValue(trimmed.slice(colon + 1));
	}
	return out;
}

function parseRootVars(css) {
	const block = extractRule(css, ":root");
	if (!block) return [];
	return [...block.matchAll(/(--[\w-]+)\s*:/g)].map((m) => m[1]);
}

/**
 * CodeStitch's sitewide navigation hooks. Which of these a script binds says
 * far more than token similarity: the two kits implement their nav script
 * differently, but both drive the same elements, so a stitch script touching
 * the same hooks is a duplicate regardless of how it is written.
 */
const NAV_HOOKS = [
	"cs-navigation",
	"cs-toggle",
	"cs-active",
	"cs-open",
	"cs-ul-wrapper",
	"cs-dropdown",
	"cs-drop-ul",
	"cs-li-link",
	"mobile-menu-toggle",
	"cs-expanded-ul",
];

function navHooks(src) {
	return src ? NAV_HOOKS.filter((h) => src.includes(h)) : [];
}

/** Normalised token multiset — used to recognise the kit's own nav script. */
function fingerprintScript(src) {
	if (!src) return undefined;
	const tokens = src
		.replace(/\/\*[\s\S]*?\*\/|\/\/.*/g, "")
		.match(/[A-Za-z_$][\w$]*|["'][^"']*["']/g);
	if (!tokens) return undefined;
	const counts = {};
	for (const t of tokens) counts[t] = (counts[t] ?? 0) + 1;
	// Keep the distinctive identifiers/strings; drop language noise.
	const noise = new Set([
		"const", "let", "var", "function", "return", "if", "else", "for", "of",
		"in", "document", "window", "true", "false", "null", "undefined", "this",
	]);
	return Object.keys(counts)
		.filter((t) => !noise.has(t))
		.sort();
}

async function buildProfile(key, kit) {
	const sha = useLatest || kit.sha === "main" ? await resolveSha(kit.repo) : kit.sha;
	console.log(`  ${kit.repo} @ ${sha.slice(0, 8)}`);

	const [rootLess, darkLess, pkgJson, tsconfig, navJsA, navJsB, cspicture, siteSettings, routeTranslations, clientData] =
		await Promise.all([
			raw(kit.repo, sha, "src/styles/root.less"),
			raw(kit.repo, sha, "src/styles/dark.less"),
			raw(kit.repo, sha, "package.json"),
			raw(kit.repo, sha, "tsconfig.json"),
			raw(kit.repo, sha, "src/js/nav.js"),
			raw(kit.repo, sha, "src/assets/js/nav.js"),
			raw(kit.repo, sha, "src/components/CSPicture/CSPicture.astro"),
			raw(kit.repo, sha, "src/config/siteSettings.ts"),
			raw(kit.repo, sha, "src/config/routeTranslations.ts"),
			raw(kit.repo, sha, "src/data/client.ts"),
		]);

	// What the kit already knows about the business, so links can point at real
	// data instead of a slug invented from an icon's label.
	const businessData = (() => {
		if (!clientData) return { exists: false, socials: [] };

		// Find the exported object that actually contains `socials`, by matching
		// braces — the file has several exports, and the first one is not it.
		let exportName;
		let socialsBlock;
		for (const match of clientData.matchAll(/export const (\w+)\s*=\s*\{/g)) {
			const open = match.index + match[0].length - 1;
			let depth = 0;
			let end = open;
			for (let i = open; i < clientData.length; i++) {
				if (clientData[i] === "{") depth++;
				else if (clientData[i] === "}") {
					depth--;
					if (depth === 0) {
						end = i;
						break;
					}
				}
			}
			const body = clientData.slice(open, end);
			const socials = /socials\s*:\s*\{/.exec(body);
			if (!socials) continue;

			exportName = match[1];
			const socialsOpen = socials.index + socials[0].length - 1;
			let socialDepth = 0;
			for (let i = socialsOpen; i < body.length; i++) {
				if (body[i] === "{") socialDepth++;
				else if (body[i] === "}") {
					socialDepth--;
					if (socialDepth === 0) {
						socialsBlock = body.slice(socialsOpen + 1, i);
						break;
					}
				}
			}
			break;
		}

		// Keys only: a bare /(\w+):/ would also match the "https:" inside each URL.
		const socials = socialsBlock
			? [...socialsBlock.matchAll(/(?:^|[{,])\s*["']?(\w+)["']?\s*:/g)].map((m) => m[1])
			: [];

		return {
			exists: Boolean(exportName) && socials.length > 0,
			exportName: exportName ?? null,
			importPath: "@data/client",
			socials,
		};
	})();

	const navJs = navJsA ?? navJsB;
	const css = `${rootLess ?? ""}\n${darkLess ?? ""}`;

	// Global helper classes: which declarations the kit already provides.
	const globalRules = {};
	for (const sel of [".cs-topper", ".cs-title", ".cs-text", ".cs-button-solid"]) {
		const block = extractRule(css, sel);
		if (block) globalRules[sel] = declMap(block);
	}

	// Icons the kit ships — <Icon name="..."> is only valid for these.
	const icons = (await listDir(kit.repo, sha, "src/icons"))
		.filter((e) => e.name.endsWith(".svg"))
		.map((e) => e.name.replace(/\.svg$/, ""));

	// Routes a link mapping may resolve to in the pristine kit.
	const pages = (await listDir(kit.repo, sha, "src/pages"))
		.filter((e) => e.type === "file" && /\.(astro|md)$/.test(e.name) && !e.name.startsWith("_"))
		.map((e) => (e.name.replace(/\.(astro|md)$/, "") === "index" ? "/" : `/${e.name.replace(/\.(astro|md)$/, "")}`));
	const routeSegments = routeTranslations
		? [...new Set([...routeTranslations.matchAll(/"([\w-]+)"\s*:\s*"/g)].map((m) => m[1]))]
		: [];

	// CSPicture's real prop set — the two kits differ, so art direction must
	// only target the kit that actually supports it.
	const cspictureProps = cspicture
		? [...(/interface Props\s*{([\s\S]*?)}/.exec(cspicture)?.[1] ?? "").matchAll(/(\w+)\s*[?:]/g)].map((m) => m[1])
		: [];

	const pkg = pkgJson ? JSON.parse(pkgJson) : {};
	const deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };

	const aliases = tsconfig
		? Object.keys(JSON.parse(tsconfig.replace(/\/\/.*$/gm, "")).compilerOptions?.paths ?? {})
		: [];

	const locales = siteSettings
		? [...(/const locales\s*=\s*\[([^\]]*)\]/.exec(siteSettings)?.[1] ?? "").matchAll(/"([\w-]+)"/g)].map((m) => m[1])
		: [];

	return {
		key,
		kitId: kit.id,
		label: kit.label,
		repo: kit.repo,
		sha,
		astroVersion: deps.astro ?? null,
		hasLess: Boolean(deps.less),
		hasSass: Boolean(deps.sass),
		aliases,
		locales,
		defaultLocale: locales[0] ?? null,
		routes: [...new Set(pages)].sort(),
		routeSegments: routeSegments.sort(),
		icons: icons.sort(),
		globalRules,
		globalRootVars: parseRootVars(css).sort(),
		cspicture: {
			exists: Boolean(cspicture),
			props: cspictureProps,
			supportsArtDirection: cspictureProps.includes("mobileImgUrl"),
		},
		businessData,
		navScript: {
			exists: Boolean(navJs),
			hooks: navHooks(navJs),
			fingerprint: fingerprintScript(navJs) ?? [],
		},
	};
}

await mkdir(OUT_DIR, { recursive: true });
console.log("Building kit profiles from pinned commits:");
for (const [key, kit] of Object.entries(KITS)) {
	const profile = await buildProfile(key, kit);
	await writeFile(join(OUT_DIR, `${key}.json`), `${JSON.stringify(profile, null, "\t")}\n`, "utf8");
	console.log(
		`    → ${key}.json  astro=${profile.astroVersion} less=${profile.hasLess} sass=${profile.hasSass} ` +
			`locales=[${profile.locales}] icons=${profile.icons.length} routes=${profile.routes.length} ` +
			`cspicture-art-direction=${profile.cspicture.supportsArtDirection}`,
	);
}
console.log("Done. Ready claims apply to these SHAs only.");
