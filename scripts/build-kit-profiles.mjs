#!/usr/bin/env node
/**
 * Builds kit profiles from PINNED commits of the two official CodeStitch kits.
 *
 * A profile captures everything the converter must compare against so that a
 * "Ready" verdict means something concrete: the global rules it may dedupe, the
 * icons it may reference, the routes a link may resolve to, the nav script it
 * may suppress, and the CSPicture contract it may target.
 *
 * Usage: npm run profiles
 *        npm run profiles -- --latest advanced-v4 (refreshes one version contract)
 */
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parse } from "acorn";

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(__dirname, "..", "src", "core", "kits", "profiles");

/** Pinned kit versions. "Ready" claims apply to these commits only. */
const KITS = {
	"advanced-i18n": {
		id: "i18n",
		repo: "CodeStitchOfficial/Advanced-Astro-i18n",
		sha: "5de7f5fe97344ed75239df1a8824c23e4d06df84",
		major: 6,
		label: "Advanced Astro v3.0.2 (legacy)",
		generation: "legacy-i18n",
	},
	"advanced-v4": {
		id: "advanced-v4",
		repo: "CodeStitchOfficial/Advanced-Astro-i18n",
		sha: "6012674f5324de9a0a5892156393fd00be128ad4",
		major: 7,
		label: "Advanced Astro v4",
		generation: "advanced-v4",
	},
	"intermediate-decap": {
		id: "decap",
		repo: "CodeStitchOfficial/Intermediate-Astro-Decap-CMS",
		sha: "7f1d82ef93ae8641b9aca883480c2b4c865cc50b",
		major: 7,
		label: "Intermediate Astro + Decap CMS",
		generation: "decap",
	},
};

const refreshArg = process.argv.indexOf("--latest");
const refreshTarget = refreshArg === -1 ? undefined : process.argv[refreshArg + 1];
if (refreshArg !== -1 && (!refreshTarget || !KITS[refreshTarget])) {
	throw new Error(`Use --latest <${Object.keys(KITS).join("|")}> to refresh exactly one target.`);
}
if (refreshArg !== -1 && process.argv.indexOf("--latest", refreshArg + 1) !== -1) {
	throw new Error("Refresh one profile at a time so version contracts remain explicit.");
}

const IMAGE_CONFIG_PATHS = ["astro.config.mjs", "astro.config.ts", "astro.config.js"];
const IMAGE_LAYOUTS = new Set(["constrained", "full-width", "fixed", "none"]);

/**
 * Turns JavaScript or TypeScript config source into JavaScript for the small
 * static AST inspection below. No config is executed: dynamic values remain
 * dynamic and are rejected by parseImageLayoutConfig.
 */
function transpileConfig(source, _path) {
	// Strip only TypeScript assertions commonly used around Astro config literals.
	// Values remain in the AST, so dynamic layout values are still rejected.
	return source
		.replace(/\s+as\s+(?:const|[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)/g, "")
		.replace(/\s+satisfies\s+[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*/g, "");
}

function propertyName(property) {
	if (property.type !== "Property" || property.computed) return undefined;
	if (property.key.type === "Identifier") return property.key.name;
	if (property.key.type === "Literal" && typeof property.key.value === "string") {
		return property.key.value;
	}
	return undefined;
}

function lastProperty(object, name) {
	return object.properties
		.filter((property) => propertyName(property) === name)
		.at(-1);
}

/**
 * Reads image.layout from an Astro config without importing or evaluating it.
 * A reachable config with no image/layout property deliberately returns null.
 */
export function parseImageLayoutConfig(source, path = "astro.config.mjs") {
	let program;
	try {
		program = parse(transpileConfig(source, path), {
			ecmaVersion: "latest",
			sourceType: "module",
		});
	} catch (error) {
		if (error instanceof Error && error.message.startsWith("Could not parse ")) throw error;
		throw new Error("Could not parse " + path + ": " + error.message);
	}

	const exported = program.body.find((statement) => statement.type === "ExportDefaultDeclaration");
	if (!exported) throw new Error("Could not find a static default config export in " + path + ".");

	let config = exported.declaration;
	if (config.type === "CallExpression") {
		const callee = config.callee;
		if (callee.type !== "Identifier" || callee.name !== "defineConfig" || config.arguments.length !== 1) {
			throw new Error("The default config export in " + path + " is dynamic or unparseable.");
		}
		config = config.arguments[0];
	}
	if (!config || config.type !== "ObjectExpression") {
		throw new Error("The default config export in " + path + " is dynamic or unparseable.");
	}

	const image = lastProperty(config, "image");
	if (!image) return null;
	if (image.type !== "Property" || image.value.type !== "ObjectExpression") {
		throw new Error("The image config in " + path + " is dynamic or unparseable.");
	}

	const layout = lastProperty(image.value, "layout");
	if (!layout) return null;
	if (layout.type !== "Property" || layout.value.type !== "Literal" || typeof layout.value.value !== "string") {
		throw new Error("image.layout in " + path + " must be a supported string literal.");
	}
	if (!IMAGE_LAYOUTS.has(layout.value.value)) {
		throw new Error(
			"image.layout in " + path + " must be one of " + [...IMAGE_LAYOUTS].join(", ") +
			"; received " + JSON.stringify(layout.value.value) + ".",
		);
	}
	return layout.value.value;
}

/** Finds the first reachable config in Astro's documented precedence order. */
export async function discoverImageLayout(fetchFile) {
	for (const path of IMAGE_CONFIG_PATHS) {
		let source;
		try {
			source = await fetchFile(path);
		} catch {
			continue;
		}
		if (source === undefined || source === null) continue;
		return parseImageLayoutConfig(source, path);
	}
	throw new Error(
		"Could not reach any of " + IMAGE_CONFIG_PATHS.join(", ") +
		"; image profile generation cannot continue.",
	);
}

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
 * The repository's full file list at a pinned commit.
 *
 * One recursive call answers every subtree question, which matters because the
 * unauthenticated GitHub API allows only 60 requests an hour and a profile run
 * asks about several directories per kit.
 */
const treeCache = new Map();
async function listTree(repo, sha, path) {
	const cacheKey = `${repo}@${sha}`;
	if (!treeCache.has(cacheKey)) {
		const data = await api(`/repos/${repo}/git/trees/${sha}?recursive=1`);
		if (data.truncated) throw new Error(`GitHub truncated the file tree for ${repo}@${sha}.`);
		treeCache.set(cacheKey, data.tree);
	}
	const prefix = `${path}/`;
	return treeCache
		.get(cacheKey)
		.filter((entry) => entry.type === "blob" && entry.path.startsWith(prefix))
		.map((entry) => ({ ...entry, relativePath: entry.path.slice(prefix.length) }));
}

/** Normalises a navData URL to a comparable, slash-free-suffix route. */
function cleanRoute(value) {
	const path = String(value ?? "/").split(/[?#]/, 1)[0] || "/";
	const leading = path.startsWith("/") ? path : `/${path}`;
	return leading === "/" ? "/" : leading.replace(/\/+$/, "");
}

/**
 * v4's per-locale routes, read from navData.json.
 *
 * navData is the kit's single source of truth for translated slugs, and it
 * nests: a project page is a child of the projects entry. Each entry is
 * recorded against its default-locale path, which is the key a generated
 * component looks a destination up by at runtime.
 */
export function collectNavRoutes(items, defaultLocale) {
	const routes = {};
	const visit = (entries) => {
		for (const entry of entries ?? []) {
			// A dropdown parent carries a label and children but no URL of its
			// own, and indexing it would invent a destination that has no page.
			const defaultUrl = entry.urls?.[defaultLocale];
			if (defaultUrl) {
				const defaultPath = cleanRoute(defaultUrl);
				for (const [locale, localized] of Object.entries(entry.urls)) {
					(routes[locale] ??= []).push({ defaultPath, localizedPath: cleanRoute(localized) });
				}
			}
			visit(entry.children);
		}
	};
	visit(items);
	return routes;
}

/** Every page route in a pinned kit, walked recursively from src/pages. */
export function collectPageRoutes(entries, stripDefaultLocale) {
	const routes = new Set();
	for (const entry of entries) {
		const rel = entry.relativePath;
		if (!rel || !/\.(?:astro|md)$/.test(rel)) continue;

		let segments = rel.replace(/\.(?:astro|md)$/, "").split("/");
		// Astro never routes a file or folder whose name begins with "_".
		if (segments.some((part) => part.startsWith("_"))) continue;

		const dynamic = segments.findIndex((part) => part.startsWith("["));
		if (dynamic !== -1) {
			// A dynamic segment describes a shape, not a destination a link can
			// target — except for a trailing rest parameter, which also matches
			// zero segments, so blog/[...page].astro really does serve /blog/.
			const last = segments.at(-1) ?? "";
			if (dynamic !== segments.length - 1 || !last.startsWith("[...")) continue;
			segments = segments.slice(0, -1);
			if (segments.length === 0) continue;
		}

		if (segments.at(-1) === "index") segments = segments.slice(0, -1);
		if (stripDefaultLocale && segments[0] === stripDefaultLocale) segments = segments.slice(1);
		const route = `/${segments.filter(Boolean).join("/")}`;
		routes.add(route === "/" ? "/" : route);
	}
	return [...routes].sort();
}

/**
 * Routes that exist in the pristine kit but belong to a removable feature.
 *
 * Read from the kit's own removal scripts rather than from a list kept here:
 * those scripts decide what a trimmed project loses, so parsing the page paths
 * they delete is the only claim that stays true when the kit changes them.
 */
export function collectOptionalRoutes(scripts, routes, locales) {
	const optional = {};
	const pageArgs = /join\(\s*root\s*,\s*"src"\s*,\s*"pages"((?:\s*,\s*"[^"]+")+)\s*\)/g;

	for (const [feature, source] of scripts) {
		if (!source) continue;
		for (const match of source.matchAll(pageArgs)) {
			const segments = [...match[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
			const cleaned = segments.map((segment) => segment.replace(/\.(?:astro|md)$/, ""));
			// A page deleted from a locale folder costs both the prefixed route
			// and the default-locale one a link is actually written against.
			const targets = [cleaned];
			if (locales.includes(cleaned[0]) && cleaned.length > 1) targets.push(cleaned.slice(1));
			for (const parts of targets) {
				const target = `/${parts.join("/")}`;
				for (const route of routes) {
					// A deleted directory takes every route beneath it.
					if (route === target || route.startsWith(`${target}/`)) optional[route] = feature;
				}
			}
		}
	}
	return Object.fromEntries(Object.entries(optional).sort(([a], [b]) => a.localeCompare(b)));
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
	const sha = refreshTarget === key ? await resolveSha(kit.repo) : kit.sha;
	console.log(`  ${kit.repo} @ ${sha.slice(0, 8)}`);
	const fetchFile = (path) => raw(kit.repo, sha, path);
	const imageLayout = await discoverImageLayout(fetchFile);
	const packageSource = await fetchFile("package.json");
	if (!packageSource) throw new Error(`${kit.repo}@${sha} has no package.json.`);
	const packageData = JSON.parse(packageSource);
	const astroVersion = (packageData.dependencies ?? {}).astro ?? (packageData.devDependencies ?? {}).astro;
	const actualMajor = Number(/^\D*(\d+)/.exec(astroVersion ?? "")?.[1]);
	if (actualMajor !== kit.major) {
		throw new Error(`${key} supports Astro ${kit.major}; ${sha.slice(0, 8)} declares ${astroVersion ?? "no Astro dependency"}.`);
	}

	// Each generation keeps the file layout it actually shipped with. v4 moved
	// its locale list into src/features/ and drives routes from navData.json;
	// the legacy Advanced kit and the Intermediate kit are read exactly as
	// before, so their profiles cannot drift while v4 support is added.
	const advancedV4 = kit.generation === "advanced-v4";
	const configPath = advancedV4 ? "astro.config.ts" : "astro.config.mjs";
	const i18nSettingsPath = advancedV4
		? "src/features/i18n/i18nConfig.ts"
		: "src/config/siteSettings.ts";
	const [rootLess, darkLess, tsconfig, navJsA, navJsB, cspicture, routeTranslations,
		navDataSource, clientData, configSource, i18nSettings, removeDemo, removeDecap] =
		await Promise.all([
			raw(kit.repo, sha, "src/styles/root.less"),
			raw(kit.repo, sha, "src/styles/dark.less"),
			raw(kit.repo, sha, "tsconfig.json"),
			raw(kit.repo, sha, "src/js/nav.js"),
			raw(kit.repo, sha, "src/assets/js/nav.js"),
			raw(kit.repo, sha, "src/components/CSPicture/CSPicture.astro"),
			raw(kit.repo, sha, "src/config/routeTranslations.ts"),
			fetchFile("src/data/navData.json"),
			raw(kit.repo, sha, "src/data/client.ts"),
			fetchFile(configPath),
			fetchFile(i18nSettingsPath),
			advancedV4 ? fetchFile("scripts/remove-demo.js") : Promise.resolve(undefined),
			advancedV4 ? fetchFile("scripts/remove-decap.js") : Promise.resolve(undefined),
		]);
	if (!configSource || !cspicture || !tsconfig || !rootLess) {
		throw new Error(`${key} is missing a required config, image-component, style, or alias file.`);
	}
	if (advancedV4 && (!i18nSettings || !navDataSource || !removeDemo || !removeDecap)) {
		throw new Error(
			`${key} is missing the i18n config, navData.json, or the feature-removal scripts its profile is read from.`,
		);
	}

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
	const css = advancedV4 ? (rootLess ?? "") : `${rootLess ?? ""}\n${darkLess ?? ""}`;

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
	// v4 walks src/pages recursively, because its translated pages live in
	// per-locale folders and its project pages are nested.
	const pages = advancedV4
		? []
		: (await listDir(kit.repo, sha, "src/pages"))
				.filter((e) => e.type === "file" && /\.(astro|md)$/.test(e.name) && !e.name.startsWith("_"))
				.map((e) => (e.name.replace(/\.(astro|md)$/, "") === "index" ? "/" : `/${e.name.replace(/\.(astro|md)$/, "")}`));
	const routeSegments = advancedV4
		? []
		: routeTranslations
			? [...new Set([...routeTranslations.matchAll(/"([\w-]+)"\s*:\s*"/g)].map((m) => m[1]))]
			: [];

	// CSPicture's real prop set — the two kits differ, so art direction must
	// only target the kit that actually supports it.
	const cspictureProps = cspicture
		? [...(/interface Props\s*{([\s\S]*?)}/.exec(cspicture)?.[1] ?? "").matchAll(/(\w+)\s*[?:]/g)].map((m) => m[1])
		: [];

	const deps = { ...(packageData.dependencies ?? {}), ...(packageData.devDependencies ?? {}) };

	const aliases = tsconfig
		? Object.keys(JSON.parse(tsconfig.replace(/\/\/.*$/gm, "")).compilerOptions?.paths ?? {})
		: [];

	// The Intermediate kit is monolingual and ships no locale list at all, which
	// is a fact about it rather than a failure to read one.
	const locales = i18nSettings
		? [...(/(?:export )?const locales\s*=\s*\[([^\]]*)\]/.exec(i18nSettings)?.[1] ?? "").matchAll(/["']([\w-]+)["']/g)].map((m) => m[1])
		: [];
	if (advancedV4 && locales.length === 0) {
		throw new Error(`${key} locale list could not be read from ${i18nSettingsPath}.`);
	}
	const defaultLocale = locales[0] ?? null;

	// Namespaces the kit's own content loader already owns: a generated locale
	// file that reuses one of these names would overwrite the kit's copy.
	const namespaceFiles = defaultLocale
		? (await listDir(kit.repo, sha, `src/locales/${defaultLocale}`))
				.filter((e) => e.type === "file" && e.name.endsWith(".json"))
				.map((e) => e.name.replace(/\.json$/, ""))
		: [];
	if (locales.length > 0 && namespaceFiles.length === 0) {
		throw new Error(`${key} declares locales but no locale namespaces could be read.`);
	}

	const prefixDefaultLocale = /prefixDefaultLocale:\s*true/.test(configSource);
	const navItems = navDataSource ? JSON.parse(navDataSource) : undefined;
	const localeRoutes = advancedV4 ? collectNavRoutes(navItems, defaultLocale) : {};

	let exactRoutes;
	let optionalRoutes = {};
	if (advancedV4) {
		const pageTree = await listTree(kit.repo, sha, "src/pages");
		exactRoutes = collectPageRoutes(pageTree, prefixDefaultLocale ? null : defaultLocale);
		optionalRoutes = collectOptionalRoutes(
			[["demo", removeDemo], ["CMS", removeDecap]],
			exactRoutes,
			locales,
		);
	} else {
		exactRoutes = [...new Set(pages)].sort();
	}

	// Astro 7 defaults to "jsx" whitespace handling; Astro 6 always compressed.
	// The effective value is recorded, not merely whether the kit spelled it out.
	const compressHTML = /compressHTML:\s*true/.test(configSource)
		? true
		: /compressHTML:\s*(?:false|"jsx")/.test(configSource)
			? (/compressHTML:\s*false/.test(configSource) ? false : "jsx")
			: kit.major >= 7
				? "jsx"
				: true;

	return {
		key,
		kitId: kit.id,
		label: kit.label,
		repo: kit.repo,
		sha,
		kitVersion: packageData.version ?? null,
		astroVersion: deps.astro ?? null,
		configPath,
		generation: kit.generation,
		compressHTML,
		prefixDefaultLocale,
		hasLess: Boolean(deps.less),
		hasSass: Boolean(deps.sass),
		aliases,
		locales,
		defaultLocale,
		namespaceFiles: [...new Set(namespaceFiles)].sort(),
		localeRoutes,
		optionalRoutes,
		imageLayout,
		routes: exactRoutes,
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

async function main() {
await mkdir(OUT_DIR, { recursive: true });
console.log("Building kit profiles from pinned commits:");
for (const [key, kit] of Object.entries(KITS)) {
	const profile = await buildProfile(key, kit);
	await writeFile(join(OUT_DIR, `${key}.json`), `${JSON.stringify(profile, null, "\t")}\n`, "utf8");
	console.log(
		`    → ${key}.json  astro=${profile.astroVersion} less=${profile.hasLess} sass=${profile.hasSass} ` +
			`locales=[${profile.locales}] icons=${profile.icons.length} routes=${profile.routes.length} ` +
			`image-layout=${profile.imageLayout} cspicture-art-direction=${profile.cspicture.supportsArtDirection}`,
	);
}
console.log("Done. Ready claims apply to these SHAs only.");
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	await main();
}
