/**
 * Every CodeStitch selector lives here, so a platform redesign is a one-file fix.
 *
 * Verified live on app.codestitch.app (logged-out demo stitches 2501, 2274, 757,
 * 1741) on 2026-10-13, against the redesigned "Get code" screen and its own
 * scripts (site/js/get-code.js, get-code-export.js).
 *
 * The stitch itself is no longer in the DOM as code fields: the server renders
 * it as inline JSON, `window.GET_CODE = {...};`, and CodeStitch's own script
 * builds the screen from that. A content script runs in an isolated world and
 * cannot see the page's globals, so it reads the script element's text instead.
 *
 * The inspector's controls (format, styles, dark mode, file name, images, links)
 * are read by host-fields.ts; their selectors live here too.
 */

export const SEL = {
	/** Inline scripts; the one starting with GET_CODE_PREFIX holds the stitch. */
	getCodeScript: "script:not([src])",
	/** The Get code inspector (right-hand column). */
	inspector: "aside.gc-inspector",
	/** Scrollable settings area: Code, Images and Links sections, then Reset. */
	inspectorScroll: ".gc-inspector__scroll",
	/** Code viewer under the settings; the fallback mount point. */
	codeWrap: ".gc-code-wrap",

	formats: "#formats",
	flavours: "#flavours",
	imageModes: "#image-modes",
	/** The selected button of a segmented control. */
	segPressed: 'button[data-id][aria-pressed="true"]',
	darkStyles: "#dark-styles",
	includeJs: "#include-js",
	/** Hidden under the Shopify format, which names its file from a section id. */
	fileRow: "#file-row",
	fileName: "#file-name",
	folderRow: "#folder-row",
	imagesFolder: "#images-folder",
	replaceLinks: "#replace-links",
	guessRoutes: "#guess-routes",
	/** Re-rendered with innerHTML on every settings change. */
	linkRows: "#link-rows",
	linkRow: "div.gc-link-row[data-i]",
	linkRowInput: "input[data-link]",
	linkRowLabel: "label",
	linkRowMeta: ".gc-link-row__meta",
} as const;

/** Matches the stitch script, and not the `window.GET_CODE.icons = …` one after it. */
export const GET_CODE_PREFIX = /^\s*window\.GET_CODE\s*=\s*/;

/** Hidden textarea holding the core styles in one flavour; absent on private stitches. */
export function coreTextarea(flavour: "css" | "less" | "scss"): string {
	return `#gc-core-${flavour}`;
}

export class SelectorDriftError extends Error {
	override readonly name = "SelectorDriftError";
	constructor(public readonly what: string) {
		super(
			`CodeStitch changed its page layout — Componentize needs an update. (missing: ${what})`,
		);
	}
}

/**
 * The stitch page loaded, but CodeStitch would not serve its contents — a 403
 * on a stitch outside the current plan, an expired session, and so on.
 *
 * Worth its own error: the stitch data is missing, but nothing about the site
 * has changed, and telling the user the extension needs an update would send
 * them looking in entirely the wrong place.
 */
export class StitchUnavailableError extends Error {
	override readonly name = "StitchUnavailableError";
	constructor(detail: string) {
		super(
			`CodeStitch did not show this stitch (${detail}). Sign in, or open it from your dashboard — it may need a higher plan.`,
		);
	}
}

export class PremiumLockedError extends Error {
	override readonly name = "PremiumLockedError";
	constructor() {
		super("Code fields are empty — this is a premium stitch, or you are not signed in.");
	}
}

/**
 * Recognises an error or permission page rather than a redesigned one.
 * Returns a short description of what the page says, if it is one.
 */
export function pageErrorDetail(doc: Document): string | undefined {
	const title = (doc.title ?? "").trim();
	const body = (doc.body?.textContent ?? "").replace(/\s+/g, " ").trim();

	const status = /\b(40[0-9]|50[0-9])\b/.exec(`${title} ${body.slice(0, 200)}`)?.[1];
	const named = /\b(forbidden|unauthori[sz]ed|access denied|not found)\b/i.exec(
		`${title} ${body.slice(0, 200)}`,
	)?.[1];

	if (!status && !named) return undefined;
	// A real stitch page is long; an error page is a line or two.
	if (body.length > 600) return undefined;
	return [status, named?.toLowerCase()].filter(Boolean).join(" ");
}

/**
 * Stitch id for a code page — /app/dashboard/stitches/<id> and nothing deeper.
 *
 * The trailing anchor matters: /stitches/<id>/rendered is the live preview of
 * the stitch, which has no code viewer at all. Matching it would mount the panel
 * on a page it can never read and report a layout change that has not happened.
 */
export function stitchIdFromUrl(url: string): string | undefined {
	let pathname: string;
	try {
		pathname = new URL(url).pathname;
	} catch {
		return undefined;
	}
	return /^\/app\/dashboard\/stitches\/(\d+)\/?$/.exec(pathname)?.[1];
}
