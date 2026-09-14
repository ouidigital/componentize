/**
 * Every CodeStitch selector lives here, so a platform redesign is a one-file fix.
 *
 * Verified live on codestitch.app (demo dashboard, 2026-08-24) and against the
 * site's own main.js: all code variants are present in the DOM simultaneously as
 * hidden textareas — no clicking or network round-trips are needed to read any of them.
 */

export const SEL = {
	/** Root of the code viewer. */
	codeTabs: "#CODE_TABS",
	/** One .tab per code variant, keyed by data-codeid. */
	tabs: "#CODE_TABS .CODE_TABS__BODY div.tab[data-codeid]",
	/**
	 * Source of truth for code content. The visible CodeMirror 5 editor is
	 * virtualized (renders only the viewport), so it must never be scraped —
	 * the site's own copy button reads this textarea too.
	 */
	textarea: "textarea.CODE-TEXTAREA",
	/** Tab links carry data-codeid + data-codetype (html|js|css|core-styles). */
	tabLinks: "a.code_list_link[data-codeid][data-codetype]",
	/** CSS flavor radios; data-css-type is authoritative, value = target codeid. */
	cssRadios: "input.radio-styles[data-css-type]",
	/** Stitch category name, e.g. "Landing + Services". */
	heading: "h2.heading",
} as const;

/** data-codetype values on the tab links. */
export type CodeType = "html" | "js" | "css" | "core-styles";

/** data-cmtype values on the textareas — fallback classification. */
export const CM_TYPE = {
	html: "application/xml",
	js: "javascript",
	css: "css",
} as const;

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
 * Worth its own error: the code viewer is missing, but nothing about the site
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

export function queryRequired<T extends Element>(
	root: ParentNode,
	selector: string,
	what: string,
): T {
	const el = root.querySelector<T>(selector);
	if (!el) throw new SelectorDriftError(what);
	return el;
}

export function queryAllRequired<T extends Element>(
	root: ParentNode,
	selector: string,
	what: string,
): T[] {
	const els = Array.from(root.querySelectorAll<T>(selector));
	if (els.length === 0) throw new SelectorDriftError(what);
	return els;
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
