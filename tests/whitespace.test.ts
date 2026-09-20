import { describe, expect, it } from "vitest";
import { convert } from "@core/convert";
import type { ConvertOptions, KitId, StitchData } from "@core/types";

/**
 * Whitespace around inline content.
 *
 * Astro 7 removes whitespace containing a newline (`compressHTML: "jsx"`),
 * while `compressHTML: true` collapses it to a single space. A generated
 * component must read the same either way, and the same as the stitch it came
 * from — so the check renders all three and compares them.
 */

const LONG =
	"Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt ut labore";

/** Stands in for a space the markup states outright, so it survives tag stripping. */
const SPACE_MARK = "@@SPACE@@";

function stripComments(markup: string): string {
	return markup.replace(/<!--[\s\S]*?-->/g, "");
}

function visible(text: string): string {
	return text.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
}

function finish(text: string): string {
	return text.split(SPACE_MARK).join(" ").replace(/\s+/g, " ").trim();
}

/** What the stitch itself renders. */
function renderSource(html: string): string {
	return visible(stripComments(html));
}

/** `compressHTML: true` — every whitespace run becomes one space. */
function renderCollapsed(markup: string): string {
	return finish(visible(stripComments(markup).split('{" "}').join(SPACE_MARK)));
}

/** `compressHTML: "jsx"` — whitespace containing a newline is dropped. */
function renderJsx(markup: string): string {
	const marked = stripComments(markup).split('{" "}').join(SPACE_MARK);
	const dropped = marked.replace(/\s+/g, (run) => (run.includes("\n") ? "" : run));
	return finish(visible(dropped));
}

const KITS: KitId[] = ["advanced-v4", "i18n", "decap"];

async function markupFor(html: string, kit: KitId): Promise<string> {
	const stitch: StitchData = {
		id: "4242",
		url: "https://codestitch.app/app/dashboard/stitches/4242",
		html,
		css: { LESS: "#demo { color: red; }" },
		coreStyles: {},
	};
	const options: ConvertOptions = {
		kit,
		cssFlavor: "less",
		darkMode: false,
		includeCoreStyles: false,
		includeJs: false,
		// Copy is left literal so the rendered text can be compared with the source.
		i18n: false,
		imagesMode: "raw",
		guessRoutes: true,
	};
	const astro = (await convert(stitch, options)).files[0]!.contents;
	const markup = astro.slice(astro.indexOf("---", 3) + 3);
	return markup.slice(0, markup.indexOf("<style"));
}

/**
 * Markup that puts every awkward case next to each other, indented the way
 * CodeStitch writes it — the indentation is what allows a line to be broken at
 * all, so writing these on one line would quietly skip half the behaviour.
 */
function section(inner: string): string {
	return `<section id="demo">\n\t<div class="cs-container">\n\t\t${inner}\n\t</div>\n</section>`;
}

const CASES: Array<[name: string, html: string]> = [
	[
		"punctuation straight after an inline element",
		section(`<p class="cs-text">\n\t\t\t${LONG} <strong>now</strong>, and ${LONG}.\n\t\t</p>`),
	],
	[
		"a link inside a long paragraph",
		section(`<p class="cs-text">\n\t\t\t${LONG} <a href="https://example.com">read this</a> ${LONG}\n\t\t</p>`),
	],
	[
		"no whitespace at all around an inline element",
		section(`<p class="cs-text">\n\t\t\t${LONG}<em>tight</em>${LONG}\n\t\t</p>`),
	],
	[
		"a long inline element with nothing inside its own tags",
		section(`<p class="cs-text">Call <a href="https://example.com" class="cs-link">${LONG}</a>now</p>`),
	],
	[
		"adjacent inline elements",
		section(`<p class="cs-text">\n\t\t\t<span>${LONG}</span> <span>${LONG}</span>\n\t\t</p>`),
	],
	[
		"a short button with no inner whitespace",
		section(`<a href="https://example.com" class="cs-button-solid">Read more</a>`),
	],
	[
		"line breaks inside an address",
		section(`<span class="cs-address">First line<br>Second line</span>`),
	],
	[
		"an inline element at the very start and end of its parent",
		section(`<p class="cs-text"><em>${LONG}</em> middle ${LONG} <strong>end</strong></p>`),
	],
];

describe("whitespace around inline content", () => {
	for (const kit of KITS) {
		for (const [name, html] of CASES) {
			it(`${kit}: ${name}`, async () => {
				const markup = await markupFor(html, kit);
				expect(renderCollapsed(markup)).toBe(renderSource(html));
				expect(renderJsx(markup)).toBe(renderSource(html));
			});
		}
	}

	/**
	 * Indenting an element's content puts whitespace inside its own tags. HTML
	 * collapses that against the whitespace outside, so the rendered sentence
	 * does not change — but the space becomes part of the link, and is
	 * underlined and clickable with it. Checked structurally, because a
	 * rendering comparison cannot see it.
	 */
	it("keeps an element on one line when its tags had nothing inside them", async () => {
		// Comfortably past the width at which content is normally broken up,
		// so only the no-inner-whitespace rule can be keeping it together.
		const label = `${LONG} ${LONG}`;
		const markup = await markupFor(
			section(`<p class="cs-text">\n\t\t\tCall <a href="https://example.com" class="cs-link">${label}</a> now\n\t\t</p>`),
			"decap",
		);
		expect(label.length).toBeGreaterThan(150);
		expect(markup).toContain(`<a href="https://example.com" class="cs-link">${label}</a>`);
	});

	/**
	 * Whitespace is only visible where both sides sit in the text flow. Treating
	 * one side as enough would glue a comment to the element after it and state
	 * spaces between block elements that render nothing.
	 */
	it("states no space beside a block element", async () => {
		// Whitespace next to a block element renders as nothing: the block
		// begins its own line either way, so stating a space there would be
		// noise at best and a stray gap at worst.
		const markup = await markupFor(
			section(`<div class="cs-wrap">\n\t\t\t<a href="https://example.com" class="cs-a">One</a>\n\t\t\t<div class="cs-b">Two</div>\n\t\t\t<a href="https://example.com" class="cs-c">Three</a>\n\t\t</div>`),
			"decap",
		);
		expect(markup).not.toContain('{" "}');
	});

	/**
	 * The TODO left for an unresolved link is inserted straight before the
	 * anchor, with no whitespace between them. Joining the two would put the
	 * comment and the link on one line and make the markup hard to read.
	 */
	it("never joins an inserted TODO comment onto its link", async () => {
		const stitch: StitchData = {
			id: "4242",
			url: "https://codestitch.app/app/dashboard/stitches/4242",
			html: section('<p class="cs-text">Ask us <a href="">about pricing</a> today</p>'),
			css: { LESS: "#demo { color: red; }" },
			coreStyles: {},
		};
		const result = await convert(stitch, {
			kit: "decap",
			cssFlavor: "less",
			darkMode: false,
			includeCoreStyles: false,
			includeJs: false,
			i18n: false,
			imagesMode: "raw",
			// Nothing is guessed, so the link is left with a TODO beside it.
			guessRoutes: false,
		});
		const astro = result.files[0]!.contents;
		expect(astro).toContain("TODO: set the destination");
		expect(astro).not.toMatch(/-->[ \t]*<a /);
		expect(astro).toMatch(/-->\n/);
	});

	it("never joins a comment onto the element after it", async () => {
		const markup = await markupFor(
			section(`<div class="cs-wrap">\n\t\t\t<!-- Left -->\n\t\t\t<a href="https://example.com" class="cs-a">One</a>\n\t\t\t<!-- Right -->\n\t\t\t<a href="https://example.com" class="cs-b">Two</a>\n\t\t</div>`),
			"decap",
		);
		// Each comment keeps its own line.
		expect(markup).toMatch(/<!-- Left -->\n/);
		expect(markup).toMatch(/<!-- Right -->\n/);
		// The space between the two links is still stated, across the comment.
		expect(markup).toContain('</a>{" "}');
	});

	it("adds an explicit space only where the source had one", async () => {
		// Indented the way CodeStitch writes it, so the paragraph is allowed to
		// be broken over several lines in the first place.
		const spaced = await markupFor(
			`<section id="demo">\n\t<p class="cs-text">\n\t\t${LONG} <em>yes</em> ${LONG}\n\t</p>\n</section>`,
			"decap",
		);
		const tight = await markupFor(
			`<section id="demo">\n\t<p class="cs-text">\n\t\t${LONG}<em>no</em>${LONG}\n\t</p>\n</section>`,
			"decap",
		);

		// Broken across lines, so each space it keeps has to be written down.
		expect(spaced.split("\n").length).toBeGreaterThan(3);
		expect(spaced).toContain('{" "}');

		// The tight one may not gain a space, so those three nodes share a line
		// however long it gets.
		expect(tight).not.toContain('{" "}');
		expect(tight).toMatch(/[^\n]<em>no<\/em>[^\n]/);
	});

	it("keeps copy and an extracted expression apart the same way", async () => {
		const stitch: StitchData = {
			id: "4242",
			url: "https://codestitch.app/app/dashboard/stitches/4242",
			html: `<section id="demo">\n\t<p class="cs-text">\n\t\t${LONG} <em>yes</em> ${LONG}\n\t</p>\n</section>`,
			css: { LESS: "#demo { color: red; }" },
			coreStyles: {},
		};
		const result = await convert(stitch, {
			kit: "advanced-v4",
			cssFlavor: "less",
			darkMode: false,
			includeCoreStyles: false,
			includeJs: false,
			i18n: true,
			imagesMode: "raw",
		});
		const astro = result.files[0]!.contents;

		// Extraction strips the spaces off each string, so the markup carries
		// them: either a plain space on one line, or an explicit one at a break.
		// A bare newline would not do, which is what these patterns rule out.
		expect(astro).toMatch(/\}(\{" "\}\s*|[ \t]+)<em>/);
		expect(astro).toMatch(/<\/em>(\{" "\}\s*|[ \t]+)\{/);

		const messages = JSON.parse(
			result.files.find((f) => f.path.endsWith("/en/demo4242.json"))!.contents,
		);
		expect(JSON.stringify(messages)).not.toContain(`${LONG} `);
	});
});
