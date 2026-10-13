/**
 * Composes conversion options from CodeStitch's own Get code settings, the
 * extension's preferences, and the panel's per-stitch choices.
 *
 * Pure: no DOM, no storage, no callbacks. The panel reads the page, calls this,
 * and wires whatever it returns.
 *
 * Policy: a CodeStitch control is used whenever the user can actually set it
 * there. Where CodeStitch locks or hides it, or its script never ran, the
 * panel's own fallback value applies, and `fallbacks` tells the panel which
 * of its own controls to show.
 */
import {
	defaultAssetsDirFor,
	defaultComponentName,
	inspectJs,
	inspectLinks,
	kitCapabilities,
	kitLocalizesLinks,
} from "@core/convert";
import { codestitchLinkOccurrences, resolveDestination } from "@core/html/links";
import { profileFor } from "@core/kits/profile";
import { InvalidNameError, assertValidAssetsDir, assertValidComponentFileName } from "@core/naming";
import type {
	ConvertOptions,
	CssFlavor,
	ImagesMode,
	KitId,
	LinkMapping,
	StitchData,
	Warning,
} from "@core/types";
import type { HostLinkRow, HostNote, HostSettings } from "@content/host-fields";
import type { Prefs } from "./prefs";

/** The panel's own values, used where CodeStitch's control is unusable. */
export interface FallbackValues {
	flavour: CssFlavor;
	darkMode: boolean;
	includeJs: boolean;
	/** Empty means CodeStitch's default name. */
	fileName: string;
	imagesMode: ImagesMode;
	assetsDir: string;
	guessRoutes: boolean;
}

export interface OwnChoices {
	keepNavJs: boolean;
	prioritizeFirstImage: boolean;
	/** Destinations typed into the panel's own link rows, by mapping id. */
	ownRoutes: ReadonlyMap<string, string>;
	/** Opt-ins to fill an empty social field from the kit's business data. */
	socialChoices: ReadonlyMap<string, boolean>;
	fallback: FallbackValues;
}

export interface HostSummary {
	rendered: boolean;
	componentName: string;
	flavourLabel: string;
	dark: boolean;
	imagesLabel: string;
	linksLabel: string;
}

export type Pairing = "paired" | "ambiguous" | "none";

export interface Composed {
	options: ConvertOptions;
	preflight: Warning[];
	summary: HostSummary;
	/** Notes for CodeStitch's link rows, keyed by their input[data-link]. */
	hostNotes: Map<number, HostNote>;
	/** Links the panel lists itself, each with its effective suggestion. */
	ownRows: LinkMapping[];
	pairing: Pairing;
	/** Which of the panel's own controls stand in for CodeStitch's. */
	fallbacks: Set<keyof FallbackValues>;
	hasJs: boolean;
	duplicatesKitNav: boolean;
	/** Paired social links whose CodeStitch field holds a value: their opt-in is void. */
	overriddenSocials: string[];
	/** Changes exactly when the conversion would. */
	optionsKey: string;
	/** Changes exactly when the set of rendered controls and rows would. */
	layoutKey: string;
}

export function defaultFallbacks(stitch: StitchData): FallbackValues {
	return {
		flavour: "less",
		darkMode: true,
		includeJs: true,
		fileName: "",
		imagesMode: "assets",
		assetsDir: defaultAssetsDirFor(stitch),
		guessRoutes: true,
	};
}

/**
 * CodeStitch's default file name: the first element id in the markup, with a
 * leading `cs-` dropped and the first letter capitalised (get-code-export.js
 * defaultFileName). "not-found-2501" → "Not-found-2501", "cs-navigation" →
 * "Navigation".
 */
export function codestitchDefaultFileName(html: string): string {
	const clean = html.replace(/<!--[\s\S]*?-->/g, "");
	const match = /<[a-z][^>]*?\sid\s*=\s*("([^"]+)"|'([^']+)')/i.exec(clean);
	const id = match ? (match[2] ?? match[3] ?? "") : "";
	if (!id) return "Stitch";
	const name = id.replace(/^cs-/, "");
	return name.charAt(0).toUpperCase() + name.slice(1);
}

/** The flavour to convert in: the requested one if the stitch has it. */
export function resolveFlavour(requested: CssFlavor, stitch: StitchData): CssFlavor {
	const has = (f: CssFlavor) => {
		const base = f.toUpperCase() as "CSS" | "LESS" | "SCSS";
		return Boolean(stitch.css[base] || stitch.css[`${base} Dark`]);
	};
	if (has(requested)) return requested;
	if (has("css")) return "css";
	return (["less", "scss"] as const).find(has) ?? requested;
}

/**
 * Maps CodeStitch's images folder, a URL path such as `/assets/images`, onto a
 * kit folder under `src/assets`, which is what the `@assets` alias reaches.
 *
 * CodeStitch's untouched default means "wherever images go", so it maps to the
 * per-stitch default rather than piling every stitch into one folder.
 */
export function mapImagesFolder(
	folder: string,
	stitchDefault: string,
): { assetsDir: string; problem?: string } {
	const f = folder.trim().replace(/\\/g, "/").replace(/\/+$/, "");
	if (f === "" || f === "/assets/images" || f === "assets/images") {
		return { assetsDir: stitchDefault };
	}
	const bare = f.replace(/^\//, "").replace(/^src\//, "");
	const problem = `Images folder "${folder.trim()}" is not under src/assets, so images were written to ${stitchDefault}. Move them, or change the folder in Get code.`;
	if (!/^assets(\/|$)/.test(bare)) return { assetsDir: stitchDefault, problem };
	try {
		return { assetsDir: assertValidAssetsDir(`src/${bare}`) };
	} catch {
		return { assetsDir: stitchDefault, problem };
	}
}

/**
 * Pairs the stitch's empty-href links with CodeStitch's link fields.
 *
 * Identity is the link's position in CodeStitch's own list, never its label:
 * CodeStitch counts anchors inside HTML comments and joins nested tags with
 * spaces, so labels can repeat or differ. When the number of visible links
 * does not match, nothing is paired and the panel lists the links itself.
 */
export function alignHostLinks(
	listed: LinkMapping[],
	occurrences: Array<{ index: number; inComment: boolean }>,
	rows: HostLinkRow[],
): { pairs: Map<string, HostLinkRow>; ambiguous: boolean } {
	const visible = occurrences.filter((o) => !o.inComment);
	const pairs = new Map<string, HostLinkRow>();
	if (visible.length !== listed.length) return { pairs, ambiguous: true };
	const byIndex = new Map(rows.map((row) => [row.index, row]));
	listed.forEach((mapping, k) => {
		const row = byIndex.get(visible[k]!.index);
		if (row) pairs.set(mapping.id, row);
	});
	return { pairs, ambiguous: false };
}

/** JSON with sorted keys, so equal settings always produce the same key. */
function stableStringify(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
	if (value && typeof value === "object") {
		const entries = Object.entries(value as Record<string, unknown>)
			.filter(([, v]) => v !== undefined)
			.sort(([a], [b]) => (a < b ? -1 : 1));
		return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(",")}}`;
	}
	return JSON.stringify(value);
}

const isBusinessExpression = (route?: string) => Boolean(route?.startsWith("{"));

export function composeOptions(
	stitch: StitchData,
	prefs: Prefs,
	host: HostSettings,
	own: OwnChoices,
): Composed {
	const kit: KitId = prefs.kit;
	const profile = profileFor(kit);
	const caps = kitCapabilities(kit);
	const preflight: Warning[] = [];
	const fallbacks = new Set<keyof FallbackValues>();
	const fb = own.fallback;

	// --- styles ---
	if (!host.usable.flavour) fallbacks.add("flavour");
	const cssFlavor = resolveFlavour(host.usable.flavour ? host.flavour : fb.flavour, stitch);
	const darkVariant = Boolean(stitch.css[`${cssFlavor.toUpperCase() as "CSS"} Dark`]);
	if (!host.usable.darkStyles && darkVariant) fallbacks.add("darkMode");
	const darkMode = (host.usable.darkStyles ? host.darkStyles : fb.darkMode) && darkVariant;

	// --- script ---
	const { hasJs, duplicatesKitNav } = inspectJs(stitch, kit);
	if (!host.usable.includeJs && hasJs) fallbacks.add("includeJs");
	const includeJs = (host.usable.includeJs ? host.includeJs : fb.includeJs) && hasJs;
	const keepKitNavScript = includeJs && duplicatesKitNav && own.keepNavJs;

	// --- name ---
	if (!host.usable.fileName) fallbacks.add("fileName");
	const requestedName =
		(host.usable.fileName ? host.fileName : fb.fileName).trim() ||
		codestitchDefaultFileName(stitch.html);
	let componentName: string;
	try {
		componentName = assertValidComponentFileName(requestedName);
	} catch (err) {
		if (!(err instanceof InvalidNameError)) throw err;
		componentName = defaultComponentName(stitch);
		preflight.push({
			severity: "draft",
			code: "host-file-name-unusable",
			message: `The file name "${requestedName}" cannot name a component (${err.message}), so ${componentName}.astro was used instead.`,
		});
	}

	// --- images ---
	if (!host.usable.images) fallbacks.add("imagesMode");
	const imagesMode: ImagesMode = host.usable.images
		? host.imagesMode === "local"
			? "assets"
			: "raw"
		: fb.imagesMode;
	let assetsDir = fb.assetsDir;
	if (imagesMode === "assets" && host.usable.images) {
		const mapped = mapImagesFolder(host.imagesFolder, defaultAssetsDirFor(stitch));
		assetsDir = mapped.assetsDir;
		if (mapped.problem) {
			preflight.push({ severity: "draft", code: "images-folder-outside-assets", message: mapped.problem });
		}
	} else if (imagesMode === "assets") {
		fallbacks.add("assetsDir");
	}
	const prioritizeFirstImage = imagesMode === "assets" && own.prioritizeFirstImage;

	// --- links ---
	const ours = inspectLinks(stitch, kit);
	const listed = ours.filter((m) => m.originalHref === "");
	const i18n = prefs.i18n && caps.textExtraction;
	const baseOptions = { kit, i18n, multilingual: prefs.multilingual } as ConvertOptions;
	const localize = kitLocalizesLinks(baseOptions);

	const hostNotes = new Map<number, HostNote>();
	const overriddenSocials: string[] = [];
	const unsetSocials: Array<{ text: string; choice: string }> = [];
	let ownRows: LinkMapping[];
	let linkMappings: LinkMapping[];
	let guessRoutes: boolean;
	let pairing: Pairing;

	if (!host.usable.links) fallbacks.add("guessRoutes");

	if (host.usable.links && !host.replaceLinks) {
		// Matches CodeStitch's "every href copies empty": each one is a TODO.
		pairing = "none";
		ownRows = [];
		linkMappings = [];
		guessRoutes = false;
	} else if (host.usable.links) {
		const { pairs, ambiguous } = alignHostLinks(listed, codestitchLinkOccurrences(stitch.html), host.links);
		pairing = ambiguous ? "ambiguous" : "paired";
		const ownGuess = host.guessRoutes;
		linkMappings = [];
		ownRows = [];
		for (const m of ours) {
			const row = pairs.get(m.id);
			if (!row) {
				const suggested = ownGuess ? m.suggestedRoute : undefined;
				const typed = own.ownRoutes.get(m.id);
				ownRows.push({ ...m, suggestedRoute: suggested, route: typed });
				linkMappings.push({
					...m,
					route: typed ?? suggested,
					routeFromSuggestion: typed === undefined && suggested !== undefined,
				});
				continue;
			}

			const businessOffer = m.social && isBusinessExpression(m.suggestedRoute) ? m.suggestedRoute : undefined;
			if (row.href) {
				if (businessOffer) overriddenSocials.push(m.id);
				linkMappings.push({ ...m, route: row.href });
				const resolved = resolveDestination(row.href, profile, localize);
				if (resolved.kind === "route" && !resolved.shipped) {
					hostNotes.set(row.index, { kind: "note", text: `${profile.label} does not ship ${resolved.target}.` });
				} else if (resolved.kind === "route" && resolved.localeDraft) {
					hostNotes.set(row.index, { kind: "note", text: resolved.localeDraft });
				}
				continue;
			}

			if (businessOffer) {
				const checked = own.socialChoices.get(m.id) === true;
				const choice = `use ${businessOffer.slice(1, -1)} from ${profile.label}`;
				hostNotes.set(row.index, { kind: "choice", mappingId: m.id, checked, text: choice });
				if (checked) {
					linkMappings.push({ ...m, route: businessOffer });
					continue;
				}
				unsetSocials.push({ text: m.text, choice });
			}
			// Left empty in Get code: a TODO, never a guess the user did not see.
			linkMappings.push({ ...m, route: undefined });
		}
		// Host fields are explicit; the panel's own rows carry their suggestion
		// as an explicit route above, so the core never guesses on top.
		guessRoutes = false;
		if (ambiguous) {
			preflight.push({
				severity: "info",
				code: "host-links-unpaired",
				message: `Get code lists ${host.links.length} links but the markup has ${listed.length} empty ones, so their destinations are set in Componentize instead.`,
			});
		}
	} else {
		pairing = "none";
		const guess = fb.guessRoutes;
		ownRows = ours.map((m) => ({
			...m,
			suggestedRoute: guess ? m.suggestedRoute : undefined,
			route: own.ownRoutes.get(m.id),
		}));
		// Explicit routes, so a row the user cleared stays a TODO.
		linkMappings = ownRows.map((m) => {
			const typed = own.ownRoutes.get(m.id);
			return {
				...m,
				route: typed ?? m.suggestedRoute,
				routeFromSuggestion: typed === undefined && m.suggestedRoute !== undefined,
			};
		});
		guessRoutes = false;
	}

	if (unsetSocials.length > 0) {
		const listed = unsetSocials
			.slice(0, 4)
			.map((s) => `${s.text} (tick "${s.choice}")`)
			.join("; ");
		preflight.push({
			severity: "draft",
			code: "social-link-unset",
			message: `${unsetSocials.length === 1 ? "A social link has" : `${unsetSocials.length} social links have`} no destination: type one in Get code's Links, or tick the Componentize box under it. ${listed}${unsetSocials.length > 4 ? `, +${unsetSocials.length - 4} more` : ""}.`,
		});
	}

	const options: ConvertOptions = {
		kit,
		cssFlavor,
		darkMode,
		includeCoreStyles: prefs.includeCoreStyles,
		includeJs,
		i18n,
		multilingual: prefs.multilingual,
		imagesMode,
		prioritizeFirstImage,
		componentName,
		assetsDir,
		linkMappings,
		guessRoutes,
		keepKitNavScript,
	};

	const summary: HostSummary = {
		rendered: host.rendered,
		componentName,
		flavourLabel: cssFlavor.toUpperCase(),
		dark: darkMode,
		imagesLabel:
			imagesMode === "assets"
				? `images → ${assetsDir}`
				: "images stay on CodeStitch's CDN (choose Local folder to bundle them)",
		linksLabel:
			pairing === "none" && host.usable.links
				? "links copy empty (Replace links is off)"
				: pairing === "paired"
					? `${pairs(linkMappings.length - ownRows.length)} from Get code`
					: pairing === "ambiguous"
						? "links set below"
						: `${ownRows.length} link${ownRows.length === 1 ? "" : "s"} set below`,
	};

	const optionsKey = stableStringify({
		...options,
		// Provenance changes the verdict: a suggested network home page is a
		// Draft placeholder, the same URL typed by hand is not.
		linkMappings: linkMappings.map((m) => [m.id, m.route ?? null, Boolean(m.routeFromSuggestion)]),
		preflight: preflight.map((w) => [w.severity, w.code, w.message]),
	});
	const layoutKey = [
		host.rendered,
		pairing,
		[...fallbacks].sort().join(","),
		imagesMode,
		includeJs && duplicatesKitNav,
		host.replaceLinks,
		ownRows.map((r) => r.id).join(","),
		[...hostNotes].map(([i, n]) => `${i}:${n.kind}`).join(","),
	].join("|");

	return {
		options,
		preflight,
		summary,
		hostNotes,
		ownRows,
		pairing,
		fallbacks,
		hasJs,
		duplicatesKitNav,
		overriddenSocials,
		optionsKey,
		layoutKey,
	};
}

function pairs(n: number): string {
	return `${n} link${n === 1 ? "" : "s"}`;
}
