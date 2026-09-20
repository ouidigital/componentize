/**
 * HTML parsing for the pure core.
 *
 * DOMParser is available both in the content-script world and in happy-dom, and
 * documents it produces never execute scripts — so stitch markup can be walked
 * safely without any sandboxing of our own.
 */

export interface ParsedStitch {
	doc: Document;
	/** The stitch's top-level elements (usually one <section>, sometimes more). */
	roots: Element[];
	/** ids of those roots, in order. */
	rootIds: string[];
	/** True when the stitch is a site navigation (fixed id, not a numeric one). */
	isNav: boolean;
}

export function parseStitchHtml(html: string): ParsedStitch {
	const doc = new DOMParser().parseFromString(html, "text/html");
	const body = doc.body;

	const roots = Array.from(body.children).filter(
		(el) => el.tagName !== "SCRIPT" && el.tagName !== "STYLE",
	);

	const rootIds = roots.map((el) => el.id).filter(Boolean);
	const isNav = roots.some(
		(el) => el.id === "cs-navigation" || el.tagName === "HEADER",
	);

	return { doc, roots, rootIds, isNav };
}

/**
 * Removes CodeStitch's own banner comments — the `<!-- ==== -->` rules and the
 * title between them. The component re-emits its own banner at assembly.
 */
export function stripBannerComments(doc: Document): void {
	const body = doc.body;
	const comments: Comment[] = [];
	const walker = doc.createTreeWalker(body, NodeFilter.SHOW_COMMENT);
	for (let n = walker.nextNode(); n; n = walker.nextNode()) {
		comments.push(n as Comment);
	}

	const isRule = (c: Comment) => /^[\s=-]+$/.test(c.data);

	for (let i = 0; i < comments.length; i++) {
		const comment = comments[i]!;
		if (!isRule(comment)) continue;
		// A banner is: rule, title, rule. Remove all three when that shape holds.
		const title = comments[i + 1];
		const closing = comments[i + 2];
		if (title && closing && isRule(closing) && !isRule(title)) {
			comment.remove();
			title.remove();
			closing.remove();
			i += 2;
		} else {
			comment.remove();
		}
	}
}

/** Collapses whitespace the way HTML rendering does. */
export function normalizeText(text: string): string {
	return text
		.replace(/[\t\n\f\r ]+/g, " ")
		.replace(/^[\t\n\f\r ]+|[\t\n\f\r ]+$/g, "");
}
