import type {
	ConvertOptions,
	ConvertResult,
	CssVariant,
	FetchAsset,
	KitId,
	LinkMapping,
	OutputFile,
	StitchData,
} from "./types";
import {
	WarningCollector,
	evaluateReadiness,
	readinessFor,
	type Delivery,
} from "./readiness";
import { profileFor } from "./kits/profile";
import { advancedV4Kit } from "./kits/advanced-v4";
import { decapKit } from "./kits/decap";
import { i18nKit } from "./kits/i18n";
import type { GenerationContext, KitCapabilities, KitGenerator } from "./kits/kit";
import {
	assertSafeOutputPath,
	assertValidAssetsDir,
	assertValidComponentFileName,
	deriveComponentName,
	freeNamespace,
	identifierFor,
	namespaceFor,
	slugFromSectionId,
} from "./naming";
import { parseStitchHtml, stripBannerComments } from "./html/parse";
import { captureSourceWhitespace } from "./html/whitespace";
import { serializeRoots, COMPONENT_MARKER } from "./html/serialize";
import { applyImagesPass } from "./html/images";
import { applyLinksPass, collectLinkMappings, hasLocalLinks } from "./html/links";
import { applyI18nExtraction } from "./html/i18nExtract";
import { indentCss, rewriteCssUrl, transformCss } from "./css/transform";
import { looksLikeKitNavScript, wrapJs } from "./js/wrap";
import { assembleComponent, stampReadiness } from "./assemble";

const KITS: Record<KitId, KitGenerator> = {
	i18n: i18nKit,
	"advanced-v4": advancedV4Kit,
	decap: decapKit,
};

/** What the chosen kit can do at all, so the panel can disable what it cannot. */
export function kitCapabilities(kit: KitId): KitCapabilities {
	return KITS[kit].capabilities;
}

export class ConversionError extends Error {
	override readonly name = "ConversionError";
}

/** Maps flavor + dark toggle onto one of the six CSS variants on the page. */
function variantFor(options: ConvertOptions): CssVariant {
	const base = options.cssFlavor.toUpperCase() as "CSS" | "LESS" | "SCSS";
	return (options.darkMode ? `${base} Dark` : base) as CssVariant;
}

/** Reads the placeholder links a stitch contains, for the panel to offer. */
export function inspectLinks(stitch: StitchData): LinkMapping[] {
	const { roots } = parseStitchHtml(stitch.html);
	return collectLinkMappings(roots);
}

/** Default component file name for a stitch, shown pre-filled in the panel. */
export function defaultComponentName(stitch: StitchData): string {
	const { rootIds, isNav } = parseStitchHtml(stitch.html);
	return deriveComponentName(rootIds[0] ?? "component", stitch.id, isNav);
}

/**
 * What the panel needs to know about a stitch's script before converting:
 * whether there is one, and whether it duplicates the kit's sitewide nav.js —
 * in which case the default conversion leaves it out (see wrapJs).
 */
export function inspectJs(
	stitch: StitchData,
	kit: KitId,
): { hasJs: boolean; duplicatesKitNav: boolean } {
	const js = stitch.js?.trim();
	if (!js) return { hasJs: false, duplicatesKitNav: false };
	const { isNav } = parseStitchHtml(stitch.html);
	return {
		hasJs: true,
		duplicatesKitNav: isNav && looksLikeKitNavScript(js, profileFor(kit)),
	};
}

/**
 * Default images folder: `src/assets/images/<stitch>`.
 *
 * Both kits group images by section (services/, hero/, blog/), so a folder
 * named after the stitch matches how a project is already organised.
 */
export function defaultAssetsDirFor(stitch: StitchData): string {
	const { rootIds, isNav } = parseStitchHtml(stitch.html);
	return defaultAssetsDir(rootIds[0], isNav);
}

export function defaultAssetsDir(sectionId?: string, isNav = false): string {
	const slug = isNav ? "navigation" : slugFromSectionId(sectionId ?? "");
	const clean = slug.replace(/[^A-Za-z0-9_-]/g, "").toLowerCase();
	return clean ? `src/assets/images/${clean}` : "src/assets/images";
}

/**
 * Converts a scraped stitch into component files for the chosen kit.
 *
 * Every step reports through the warning collector, and the final Ready/Draft
 * verdict is derived from those warnings — never asserted directly.
 */
export async function convert(
	stitch: StitchData,
	options: ConvertOptions,
	fetchAsset?: FetchAsset,
): Promise<ConvertResult> {
	const warnings = new WarningCollector();
	const profile = profileFor(options.kit);
	const kit = KITS[options.kit]!;

	// --- 0. variant resolution ---
	const variant = variantFor(options);
	const cssSource = stitch.css[variant];
	if (!cssSource) {
		const available = Object.keys(stitch.css).join(", ") || "none";
		throw new ConversionError(
			`This stitch has no ${variant} styles (it offers: ${available}).`,
		);
	}
	if (options.cssFlavor === "scss" && !profile.hasSass) {
		warnings.draft(
			"scss-requires-sass",
			`${profile.label} ships with LESS only — run "npm i -D sass" in the project before using this SCSS component.`,
		);
	}

	// --- 1-2. parse, name, strip CodeStitch's own banners ---
	const { doc, roots, rootIds, isNav } = parseStitchHtml(stitch.html);
	if (roots.length === 0) throw new ConversionError("This stitch has no markup.");

	// Recorded before any pass edits text, because extraction replaces a node's
	// copy with a lookup and takes the spaces around it with it. The serializer
	// needs to know where the source really had whitespace.
	captureSourceWhitespace(roots);

	const componentName = options.componentName
		? assertValidComponentFileName(options.componentName)
		: deriveComponentName(rootIds[0] ?? "component", stitch.id, isNav);

	// A locale file is named after the component, and the kit's own files sit
	// in the same folder — so a component called Contact would overwrite the
	// kit's contact.json on extraction.
	const baseNamespace = namespaceFor(componentName);
	const namespace = kit.usesI18n(options)
		? freeNamespace(baseNamespace, stitch.id, profile.namespaceFiles)
		: baseNamespace;
	if (namespace !== baseNamespace) {
		warnings.info(
			"namespace-collision",
			`${profile.label} already ships src/locales/*/${baseNamespace}.json, so this component's copy went to ${namespace}.json instead.`,
		);
	}
	const assetsDir = assertValidAssetsDir(
		options.assetsDir ?? defaultAssetsDir(rootIds[0], isNav),
	);

	stripBannerComments(doc);

	if (roots.length > 1) {
		warnings.info(
			"multi-section",
			`This stitch contains ${roots.length} sections (${rootIds.join(", ")}), kept together in one component — split them by hand if you want them separate.`,
		);
	}

	// --- 3. styles (before images, so CSS url()s join the download list) ---
	const cssResult = transformCss(cssSource, {
		flavor: options.cssFlavor,
		profile,
		warnings,
		sectionIds: rootIds,
		darkModeRequested: options.darkMode,
	});

	// --- 4. images ---
	//
	// Links are collected from this document (which also tags each anchor so a
	// mapping can be matched back to it) and any routes the caller supplied are
	// laid over the top. Deriving here rather than trusting the caller to pass a
	// full list means an empty `linkMappings` array cannot silently turn the
	// suggestions off.
	const collectedLinks = collectLinkMappings(roots, profile);
	const suppliedRoutes = new Map(
		(options.linkMappings ?? [])
			.filter((mapping) => mapping.route?.trim())
			.map((mapping) => [mapping.id, mapping.route!.trim()]),
	);
	const linkMappings = collectedLinks.map((mapping) => ({
		...mapping,
		route: suppliedRoutes.get(mapping.id) ?? mapping.route,
	}));
	const images = await applyImagesPass({
		doc,
		roots,
		mode: options.imagesMode,
		profile,
		warnings,
		fetchAsset,
		assetsDir,
		cssUrls: options.imagesMode === "assets" ? cssResult.urls : [],
		prioritizeFirstImage: options.prioritizeFirstImage === true,
	});

	if (options.imagesMode === "assets" && images.anyUnbundled) {
		warnings.draft(
			"assets-partially-bundled",
			"Some images could not be downloaded, so the component still imports them from the CodeStitch CDN — those imports will not resolve.",
		);
	}

	// --- 5. links ---
	const localize = kit.localizesLinks(options);
	let usesBusinessData = false;
	applyLinksPass({
		roots,
		kit: options.kit,
		profile,
		warnings,
		mappings: linkMappings,
		localize,
		routeExpression: (route) => kit.routeExpression(route),
		useSuggestions: options.guessRoutes !== false,
		onBusinessDataUsed: () => {
			usesBusinessData = true;
		},
	});

	// --- 6. i18n extraction ---
	let messages: Record<string, unknown> | undefined;
	let messageCount = 0;
	if (kit.usesI18n(options)) {
		const result = applyI18nExtraction({
			roots,
			warnings,
			reference: (key) => kit.translationReference(namespace, key),
		});
		messages = result.messages;
		messageCount = result.count;
	}

	// --- 7. script ---
	let script: string | undefined;
	if (options.includeJs && stitch.js) {
		const wrapped = wrapJs(stitch.js, {
			profile,
			warnings,
			isNav,
			keepKitNavScript: options.keepKitNavScript,
		});
		script = wrapped.script;
	} else if (stitch.js && !options.includeJs) {
		warnings.info(
			"js-omitted",
			"This stitch ships JavaScript that was left out — its interactive parts will not work without it.",
		);
	}

	// --- 8. serialize markup, then rewrite CSS urls to custom properties ---
	const markup = serializeRoots(roots);

	let css = cssResult.css;
	for (const cssVar of images.cssVars) {
		css = rewriteCssUrl(css, cssVar.url, cssVar.varName);
	}

	// Which Astro components the markup actually uses.
	const usedComponents = new Set<string>();
	for (const root of roots) {
		const scope = [root, ...Array.from(root.querySelectorAll("*"))];
		for (const el of scope) {
			if (el.hasAttribute?.(COMPONENT_MARKER)) usedComponents.add(el.tagName);
		}
	}
	if (localize && hasLocalLinks(roots)) usedComponents.add("__localizedRoute");
	if (usesBusinessData) usedComponents.add("__businessData");

	// --- 9. assemble ---
	const ctx: GenerationContext = {
		componentName,
		namespace,
		stitchId: stitch.id,
		stitchUrl: stitch.url,
		options,
		profile,
		warnings,
		usedComponents,
		imageImports: images.imports,
		cssVars: images.cssVars,
		messages,
		messageCount,
	};

	const extraFiles = kit.extraFiles(ctx);

	// Core Styles is emitted as an installable file, never silently orphaned.
	const coreFiles: OutputFile[] = [];
	if (options.includeCoreStyles) {
		const key = options.cssFlavor.toUpperCase() as "CSS" | "LESS" | "SCSS";
		const core = stitch.coreStyles[key];
		if (core) {
			const ext = options.cssFlavor;
			coreFiles.push({
				path: `src/styles/codestitch-core.${ext}`,
				contents: core,
				encoding: "utf8",
			});
			coreFiles.push({
				path: "INSTALL.md",
				contents: coreStylesInstructions(profile.label, ext),
				encoding: "utf8",
			});
			warnings.draft(
				"core-styles-manual-merge",
				`Core Styles were written to src/styles/codestitch-core.${ext}, but nothing imports them yet — merge them into src/styles/root.less (see INSTALL.md). ${profile.label} already defines most of them.`,
			);
		} else {
			warnings.info(
				"core-styles-missing",
				"This stitch offers no Core Styles in the selected flavour, so none were written.",
			);
		}
	}

	const readiness = evaluateReadiness(warnings.warnings);

	const astro = assembleComponent({
		ctx,
		kit,
		readiness,
		markup,
		css: indentCss(css),
		script,
		title: stitch.categoryHeading || componentName,
	});

	const files: OutputFile[] = [
		{
			path: assertSafeOutputPath(
				`src/components/${componentName}/${componentName}.astro`,
			),
			contents: astro,
			encoding: "utf8",
		},
		...extraFiles.map((f) => ({ ...f, path: assertSafeOutputPath(f.path) })),
		...images.files.map((f) => ({ ...f, path: assertSafeOutputPath(f.path) })),
		...coreFiles.map((f) => ({ ...f, path: assertSafeOutputPath(f.path) })),
	];

	return {
		componentName,
		componentIdentifier: identifierFor(componentName),
		files,
		warnings: warnings.warnings,
		readiness,
	};
}

function coreStylesInstructions(kitLabel: string, ext: string): string {
	return `# Installing the CodeStitch Core Styles

\`src/styles/codestitch-core.${ext}\` holds CodeStitch's \`:root\` variables and the
base \`.cs-topper\` / \`.cs-title\` / \`.cs-text\` rules.

**Nothing imports this file yet.** ${kitLabel} already defines equivalents in
\`src/styles/root.less\`, which \`BaseLayout.astro\` imports once for the whole site.

Pick one:

1. **Merge (recommended)** — copy any variables you actually want from
   \`codestitch-core.${ext}\` into \`src/styles/root.less\`, then delete this file.
   Watch for colours you have already customised: a blind copy will overwrite them.
2. **Import it** — add \`import "@styles/codestitch-core.${ext}";\` to
   \`src/layouts/BaseLayout.astro\` *before* the \`root.less\` import, so the kit's
   own values still win.

Until you do one of these, the component may render with the kit's colours
rather than the ones shown on codestitch.app.
`;
}

/**
 * The component source for one delivery, with its verdict stamped to match.
 *
 * Always use this rather than reading `result.files[0].contents` directly: the
 * assembled file carries the verdict for the whole file set, which overstates
 * what a lone .astro gives the user.
 */
export function componentSourceFor(
	result: ConvertResult,
	delivery: Delivery,
): string {
	const source = result.files[0]!.contents;
	const readiness = readinessFor(result, delivery);
	return readiness === result.readiness
		? source
		: stampReadiness(source, readiness);
}
