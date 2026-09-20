import type { KitId, LinkMapping } from "../types";
import type { KitProfile } from "../kits/profile";
import type { WarningCollector } from "../readiness";
import { normalizeText } from "./parse";
import { expr } from "./serialize";

/**
 * CodeStitch ships every link as `href=""`.
 *
 * Rather than ask for sixteen destinations one at a time — at a point where the
 * real routes usually are not decided yet — each link gets a route derived from
 * its own label: "Privacy Policy" becomes `/privacy-policy`, "Home" becomes `/`.
 * The suggestion is shown in the panel and can be edited or cleared, and text
 * that plainly is not a page name (an address, opening hours) is left for the
 * user rather than turned into nonsense like `/m-f-8am-530pm`.
 */

/**
 * Social networks a stitch might link to, with the home page to fall back on.
 *
 * A social icon's label ("visit facebook profile") describes an action, not a
 * page, so slugifying it produces `/visit-facebook-profile` — a route that will
 * never exist. These links belong either in the kit's own business data or, at
 * worst, pointed at the network itself.
 */
const SOCIAL_NETWORKS: Array<{ key: string; match: RegExp; home: string }> = [
	{ key: "facebook", match: /\bfacebook\b|\bfb\b/i, home: "https://www.facebook.com/" },
	{ key: "instagram", match: /\binstagram\b|\binsta\b/i, home: "https://www.instagram.com/" },
	{ key: "twitter", match: /\btwitter\b|\bx\.com\b/i, home: "https://twitter.com/" },
	{ key: "linkedin", match: /\blinked ?in\b/i, home: "https://www.linkedin.com/" },
	{ key: "youtube", match: /\byou ?tube\b/i, home: "https://www.youtube.com/" },
	{ key: "tiktok", match: /\btik ?tok\b/i, home: "https://www.tiktok.com/" },
	{ key: "pinterest", match: /\bpinterest\b/i, home: "https://www.pinterest.com/" },
	{ key: "threads", match: /\bthreads\b/i, home: "https://www.threads.net/" },
	{ key: "github", match: /\bgithub\b/i, home: "https://github.com/" },
];

/** The social network an anchor points at, judged by its label and classes. */
export function socialNetworkFor(
	anchor: Element,
	label: string,
): (typeof SOCIAL_NETWORKS)[number] | undefined {
	const haystack = [
		label,
		anchor.getAttribute("class") ?? "",
		anchor.getAttribute("aria-label") ?? "",
		anchor.querySelector("img")?.getAttribute("alt") ?? "",
		anchor.querySelector("use")?.getAttribute("href") ?? "",
	].join(" ");
	return SOCIAL_NETWORKS.find((network) => network.match.test(haystack));
}

/** A readable label for a link that has no text of its own. */
function labelFor(anchor: Element): string {
	const text = normalizeText(anchor.textContent ?? "");
	if (text) return text;

	const aria = anchor.getAttribute("aria-label")?.trim();
	if (aria) return aria;
	const title = anchor.getAttribute("title")?.trim();
	if (title) return title;

	const img = anchor.querySelector("img, picture img");
	const alt = img?.getAttribute("alt")?.trim();
	if (alt) return alt;

	const cls = anchor.getAttribute("class") ?? "";
	if (/\bcs-logo\b/.test(cls)) return "logo";
	return "(no text)";
}

/** True when this anchor is the site logo, which always points home. */
function isLogo(anchor: Element, label: string): boolean {
	const cls = anchor.getAttribute("class") ?? "";
	return /\bcs-logo\b/.test(cls) || /^(logo|home ?page|back to home)$/i.test(label);
}

/**
 * Turns a link's label into a route, or undefined when guessing would be worse
 * than asking.
 *
 * Digits and long phrases are the giveaway for text that is not a page name —
 * opening hours, a street address, a phone number — all of which appear as
 * links in CodeStitch top bars.
 */
export function deriveRouteFromText(label: string): string | undefined {
	const text = label.trim();
	if (!text || text === "(no text)") return undefined;
	if (/^home$/i.test(text)) return "/";

	// Not a page name: contains digits, or reads as a phrase rather than a label.
	if (/\d/.test(text)) return undefined;
	if (text.split(/\s+/).length > 4) return undefined;
	if (/[@,]|\.[a-z]{2,}$/i.test(text)) return undefined;

	const slug = text
		.toLowerCase()
		.replace(/&/g, " and ")
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
	return slug ? `/${slug}` : undefined;
}

/** Anchors whose href the user may need to fill in, with a suggested route. */
export function collectLinkMappings(
	roots: Element[],
	profile?: KitProfile,
): LinkMapping[] {
	const mappings: LinkMapping[] = [];
	let index = 0;
	for (const root of roots) {
		for (const anchor of Array.from(root.querySelectorAll("a"))) {
			const href = anchor.getAttribute("href") ?? "";
			const id = `link-${index++}`;
			anchor.setAttribute("data-cz-link", id);
			if (isPlaceholder(href)) {
				const text = labelFor(anchor);
				const social = socialNetworkFor(anchor, text);
				mappings.push({
					id,
					text,
					originalHref: href,
					social: social?.key,
					suggestedRoute: isLogo(anchor, text)
						? "/"
						: social
							? // Filled in by the caller, which knows what the kit ships.
								undefined
							: deriveRouteFromText(text),
				});
			}
		}
	}
	// Social links point at the kit's own data where it has a matching entry,
	// and at the network's home page otherwise.
	for (const mapping of mappings) {
		if (!mapping.social || mapping.suggestedRoute) continue;
		const network = SOCIAL_NETWORKS.find((n) => n.key === mapping.social)!;
		const data = profile?.businessData;
		mapping.suggestedRoute =
			data?.exists && data.exportName && data.socials.includes(network.key)
				? `{${data.exportName}.socials.${network.key}}`
				: network.home;
	}

	return mappings;
}

function isPlaceholder(href: string): boolean {
	return href.trim() === "" || href.trim() === "#";
}

function isExternal(href: string): boolean {
	return /^(https?:|tel:|mailto:|\/\/)/i.test(href.trim());
}

/** A destination written as an Astro expression, e.g. {BUSINESS.socials.facebook}. */
function isExpression(value: string): boolean {
	const trimmed = value.trim();
	return trimmed.startsWith("{") && trimmed.endsWith("}") && trimmed.length > 2;
}

/** True when an expression reads from the kit's business data export. */
function usesBusinessData(code: string, profile: KitProfile): boolean {
	const name = profile.businessData?.exportName;
	return Boolean(name) && new RegExp(`\\b${name}\\b`).test(code);
}

function isFragment(href: string): boolean {
	return href.trim().startsWith("#") && href.trim().length > 1;
}

/**
 * Splits a destination into the path and whatever follows it.
 *
 * A query string or fragment is part of the destination but not part of the
 * route: `/contact?ref=hero` names the contact page, and the trailing slash
 * this kit expects belongs after `contact`, not after `hero`.
 */
function splitRoute(route: string): { path: string; suffix: string } {
	const trimmed = route.trim();
	const marker = trimmed.search(/[?#]/);
	return marker === -1
		? { path: trimmed, suffix: "" }
		: { path: trimmed.slice(0, marker), suffix: trimmed.slice(marker) };
}

/** Normalises a user-entered route to the kit's trailing-slash convention. */
function normalizeRoute(route: string): string {
	const { path, suffix } = splitRoute(route);
	if (!path || path === "/") return `/${suffix}`;
	const withLeading = path.startsWith("/") ? path : `/${path}`;
	const withTrailing = withLeading.endsWith("/") ? withLeading : `${withLeading}/`;
	return `${withTrailing}${suffix}`;
}

/** A route in the form the profile records, without its trailing slash. */
function comparableRoute(route: string): string {
	const trimmed = route.replace(/\/+$/, "");
	return trimmed === "" ? "/" : trimmed;
}

/**
 * True when the pristine kit actually has somewhere for this route to land.
 *
 * Advanced v4 is checked as a whole path, because its profile lists every page
 * the kit ships. A first segment proves nothing there: `/projects` is a
 * navigation parent with a dropdown and no page of its own, so a link to it
 * would 404. The older kits keep the looser check they were profiled for,
 * since their profiles only ever listed top-level pages.
 */
function routeExistsInKit(route: string, profile: KitProfile): boolean {
	const { path } = splitRoute(route);
	const clean = path.replace(/^\/|\/$/g, "");
	if (clean === "") return true;

	if (profile.generation === "advanced-v4") {
		return profile.routes.includes(comparableRoute(path));
	}

	const first = clean.split("/")[0]!;
	return (
		profile.routes.includes(`/${first}`) ||
		profile.routes.includes(route) ||
		profile.routeSegments.includes(first)
	);
}

export interface LinksPassOptions {
	roots: Element[];
	kit: KitId;
	profile: KitProfile;
	warnings: WarningCollector;
	mappings: LinkMapping[];
	/** True when links should be wrapped in the kit's route helper. */
	localize: boolean;
	/** Writes a resolved route as the kit's own route expression. */
	routeExpression: (route: string) => string;
	/** Use routes derived from link text where the user supplied none. */
	useSuggestions: boolean;
	/** Called when a destination references the kit's business data. */
	onBusinessDataUsed?: () => void;
}

export function applyLinksPass(options: LinksPassOptions): void {
	const {
		roots,
		profile,
		warnings,
		mappings,
		localize,
		routeExpression,
		useSuggestions,
		onBusinessDataUsed,
	} = options;
	const byId = new Map(mappings.map((m) => [m.id, m]));
	let unresolved = 0;
	const guessed: string[] = [];
	const missingFromKit = new Set<string>();
	const placeholderExternals = new Set<string>();
	const optional = new Map<string, string>();

	for (const root of roots) {
		for (const anchor of Array.from(root.querySelectorAll("a"))) {
			const id = anchor.getAttribute("data-cz-link");
			anchor.removeAttribute("data-cz-link");
			const href = anchor.getAttribute("href") ?? "";

			if (isExternal(href)) {
				if (/^(tel:|mailto:)/i.test(href.trim())) {
					warnings.info(
						"contact-link-hardcoded",
						`Left ${href.trim()} as written — point it at your own contact details (${profile.businessData.exists ? `the kit keeps these in ${profile.businessData.importPath}` : "your site config"}) when you wire the component up.`,
					);
				}
				continue;
			}

			if (isFragment(href)) continue;

			const mapping = id ? byId.get(id) : undefined;
			const typed = mapping?.route?.trim();
			// A route the user typed always wins over one read off the label.
			const suggested = useSuggestions ? mapping?.suggestedRoute : undefined;
			const route = typed || suggested;
			const wasGuessed = Boolean(!typed && suggested);

			// Placeholder status comes from the markup, not from whether the panel
			// happened to offer a mapping — an unmapped `href=""` is still unresolved.
			if (isPlaceholder(href) && !route) {
				anchor.setAttribute("href", "#");
				const label =
					mapping?.text ?? normalizeText(anchor.textContent ?? "") ?? "this link";
				anchor.before(
					anchor.ownerDocument.createComment(
						` TODO: set the destination for "${label || "this link"}" `,
					),
				);
				unresolved++;
				continue;
			}

			if (!route && !href.trim()) continue;

			// A destination is one of three things, and the field accepts all of
			// them: an expression in braces, an absolute URL, or a site route.
			const raw = (route ?? href).trim();

			if (isExpression(raw)) {
				const code = raw.slice(1, -1).trim();
				anchor.setAttribute("href", expr(code));
				if (usesBusinessData(code, profile)) onBusinessDataUsed?.();
				if (wasGuessed) guessed.push(`${mapping?.text ?? "link"} → ${raw}`);
				continue;
			}

			if (isExternal(raw)) {
				anchor.setAttribute("href", raw);
				if (wasGuessed) {
					guessed.push(`${mapping?.text ?? "link"} → ${raw}`);
					placeholderExternals.add(raw);
				}
				continue;
			}

			const target = normalizeRoute(raw);
			if (!target) continue;

			if (route) {
				if (wasGuessed) guessed.push(`${mapping?.text ?? "link"} → ${target}`);
				if (routeExistsInKit(target, profile)) {
					const feature = profile.optionalRoutes[comparableRoute(splitRoute(target).path)];
					if (feature) optional.set(target, feature);
				} else {
					missingFromKit.add(target);
				}
			}

			anchor.setAttribute("href", localize ? expr(routeExpression(target)) : target);
		}
	}

	if (unresolved > 0) {
		warnings.draft(
			"unresolved-link",
			`${unresolved} ${unresolved === 1 ? "link has" : "links have"} no destination yet — each is marked with a TODO in the markup.`,
		);
	}

	if (guessed.length > 0) {
		warnings.info(
			"routes-guessed",
			`${guessed.length} ${guessed.length === 1 ? "route was" : "routes were"} read from the link text: ${guessed.slice(0, 6).join(", ")}${guessed.length > 6 ? `, +${guessed.length - 6} more` : ""}.`,
		);
	}

	if (placeholderExternals.size > 0) {
		const urls = [...placeholderExternals];
		warnings.draft(
			"social-link-placeholder",
			`${urls.length} social ${urls.length === 1 ? "link points" : "links point"} at the network's home page (${urls.slice(0, 4).join(", ")}) because ${profile.label} has no entry for ${urls.length === 1 ? "it" : "them"} — put your own profile ${urls.length === 1 ? "URL" : "URLs"} in src/data/client.ts, or set ${urls.length === 1 ? "it" : "them"} here.`,
		);
	}

	// A destination can exist in the pristine kit and still be missing from a
	// real project, because the kit's setup script can remove the feature that
	// brought it. That is worth saying once, and it is not a Draft reason: the
	// component builds, and only the person who ran the script knows.
	if (optional.size > 0) {
		const byFeature = new Map<string, string[]>();
		for (const [route, feature] of optional) {
			byFeature.set(feature, [...(byFeature.get(feature) ?? []), route]);
		}
		for (const [feature, routes] of byFeature) {
			warnings.info(
				"route-from-optional-feature",
				`${routes.join(", ")} ${routes.length === 1 ? "is a page" : "are pages"} ${profile.label} ships with its ${feature} files — if this project was set up without ${feature === "demo" ? "the demo content" : "the CMS"}, repoint ${routes.length === 1 ? "that link" : "those links"}.`,
			);
		}
	}

	// One line for the lot: a navigation stitch can point at a dozen pages that
	// do not exist yet, and a dozen near-identical warnings help nobody.
	if (missingFromKit.size > 0) {
		const routes = [...missingFromKit];
		warnings.draft(
			"route-not-in-kit",
			`${routes.length} ${routes.length === 1 ? "link points" : "links point"} at ${routes.length === 1 ? "a page" : "pages"} ${profile.label} does not ship: ${routes.slice(0, 8).join(", ")}${routes.length > 8 ? `, +${routes.length - 8} more` : ""} — create ${routes.length === 1 ? "it" : "them"}, or repoint the ${routes.length === 1 ? "link" : "links"}.`,
		);
	}
}

/** True when any anchor in the markup still needs a destination. */
export function hasLocalLinks(roots: Element[]): boolean {
	return roots.some((root) =>
		Array.from(root.querySelectorAll("a")).some((a) => {
			const href = a.getAttribute("href") ?? "";
			return !isExternal(href) && !isFragment(href);
		}),
	);
}
