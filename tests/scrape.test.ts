import { describe, expect, it } from "vitest";
import {
	cssVariantFor,
	findGetCodeScript,
	parseGetCode,
	scrapeStitch,
} from "@content/scrape";
import {
	PremiumLockedError,
	SelectorDriftError,
	StitchUnavailableError,
	stitchIdFromUrl,
} from "@content/selectors";
import type { StitchData } from "@core/types";
import {
	FIXTURE_DIRS,
	fixtureMeta,
	loadFixture,
	loadPage,
	normalizeFixtureText,
} from "./helpers/loadFixture";
import { getCodePage, type StubCode } from "./helpers/getCodePage";

function docFrom(html: string): Document {
	return new DOMParser().parseFromString(html, "text/html");
}

const STITCH_URL = (id: string, origin = "https://app.codestitch.app") =>
	`${origin}/app/dashboard/stitches/${id}`;

const FIXTURE_IDS: Record<string, string> = {
	[FIXTURE_DIRS.notFound]: "2501",
	[FIXTURE_DIRS.faq]: "1741",
	[FIXTURE_DIRS.heroMultiSection]: "2274",
	[FIXTURE_DIRS.heroLanding]: "1946",
	[FIXTURE_DIRS.nav]: "757",
	[FIXTURE_DIRS.contact]: "2320",
};

/**
 * Fields CodeStitch has edited since the derived fixtures were captured
 * (checked 2026-10-13). The derived folders feed every conversion snapshot, so
 * they are not refreshed as a side effect of the scraper migration; these
 * fields are compared for presence only, and a separate test fails as soon as
 * they match again, so a stale entry cannot linger here.
 */
const KNOWN_UPSTREAM_EDITS: Record<string, readonly string[]> = {
	// The navigation stitch's dropdown rules were reordered and its height changed.
	"757": ["CSS", "CSS Dark", "LESS", "LESS Dark", "SCSS", "SCSS Dark"],
};

const HTML: StubCode = {
	typeName: "HTML",
	type: "html",
	content: '<section id="hero-1">\r\n\t<a href="">About</a>\r\n</section>',
};

describe("scrapeStitch on the redesigned page", () => {
	/*
	 * The contract: the new scraper must reproduce what the old one captured.
	 * The derived fixture folders were taken from the pre-October page and feed
	 * every conversion snapshot, so agreement here is what lets those snapshots
	 * stand. A failure names the stitch and field CodeStitch has since changed.
	 */
	for (const [dir, id] of Object.entries(FIXTURE_IDS)) {
		it(`reads stitch ${id} exactly as it was captured before the redesign`, () => {
			const expected: StitchData = loadFixture(dir);
			const stitch = scrapeStitch(docFrom(loadPage(id)), fixtureMeta(dir).url);

			expect(stitch.id).toBe(expected.id);
			expect(stitch.categoryHeading).toBe(expected.categoryHeading);
			expect(normalizeFixtureText(stitch.html)).toBe(normalizeFixtureText(expected.html));
			expect(stitch.js === undefined).toBe(expected.js === undefined);
			if (expected.js) {
				expect(normalizeFixtureText(stitch.js!)).toBe(normalizeFixtureText(expected.js));
			}

			expect(Object.keys(stitch.css).sort()).toEqual(Object.keys(expected.css).sort());
			for (const [variant, text] of Object.entries(expected.css)) {
				if (KNOWN_UPSTREAM_EDITS[id]?.includes(variant)) continue;
				expect(
					normalizeFixtureText(stitch.css[variant as keyof typeof stitch.css]!),
					`${id} ${variant}`,
				).toBe(normalizeFixtureText(text));
			}

			expect(Object.keys(stitch.coreStyles).sort()).toEqual(
				Object.keys(expected.coreStyles).sort(),
			);
			for (const [key, text] of Object.entries(expected.coreStyles)) {
				expect(
					normalizeFixtureText(stitch.coreStyles[key as "CSS"]!, { dropBlankLines: true }),
					`${id} core ${key}`,
				).toBe(normalizeFixtureText(text, { dropBlankLines: true }));
			}
		});
	}

	for (const [id, variants] of Object.entries(KNOWN_UPSTREAM_EDITS)) {
		it(`still sees CodeStitch's edit to stitch ${id} (drop the exception once its fixture is refreshed)`, () => {
			const dir = Object.keys(FIXTURE_IDS).find((d) => FIXTURE_IDS[d] === id)!;
			const expected = loadFixture(dir);
			const stitch = scrapeStitch(docFrom(loadPage(id)), fixtureMeta(dir).url);
			for (const variant of variants) {
				const key = variant as keyof typeof stitch.css;
				expect(stitch.css[key], `${id} ${variant}`).toBeTruthy();
				expect(normalizeFixtureText(stitch.css[key]!), `${id} ${variant}`).not.toBe(
					normalizeFixtureText(expected.css[key]!),
				);
			}
		});
	}

	it("never hands Windows line endings downstream", () => {
		const stitch = scrapeStitch(docFrom(loadPage("2501")), STITCH_URL("2501"));
		for (const text of [stitch.html, ...Object.values(stitch.css), ...Object.values(stitch.coreStyles)]) {
			expect(text).not.toContain("\r");
		}
	});

	it("keys dark variants by name, not by CodeStitch's isDark flag", () => {
		// On the live 2501 page the "CSS Dark" record says isDark: false.
		const doc = docFrom(
			getCodePage({
				codes: [
					HTML,
					{ typeName: "CSS", type: "css", isDark: false, content: "#a{}" },
					{ typeName: "CSS Dark", type: "css", isDark: false, content: "#a{} body.dark-mode #a{}" },
				],
			}),
		);
		const stitch = scrapeStitch(doc, STITCH_URL("2501"));
		expect(stitch.css["CSS Dark"]).toContain("body.dark-mode");
		expect(stitch.css.CSS).toBe("#a{}");
	});

	it("does not depend on the order CodeStitch lists codes in", () => {
		const doc = docFrom(
			getCodePage({
				codes: [
					{ typeName: "LESS", type: "css", content: "#a{ .b{} }" },
					{ typeName: "JS", type: "js", content: "console.log(1)" },
					HTML,
				],
			}),
		);
		const stitch = scrapeStitch(doc, STITCH_URL("2501"));
		expect(stitch.html).toContain('<section id="hero-1">');
		expect(stitch.js).toBe("console.log(1)");
		expect(Object.keys(stitch.css)).toEqual(["LESS"]);
	});

	it("prefers the code named HTML over an agency type that is also markup", () => {
		const doc = docFrom(
			getCodePage({
				codes: [
					{ typeName: "PHP", type: "html", content: "<?php echo 1; ?>" },
					HTML,
				],
			}),
		);
		expect(scrapeStitch(doc, STITCH_URL("2501")).html).toContain("hero-1");
	});

	it("treats SASS as SCSS and skips styles it does not recognise", () => {
		const doc = docFrom(
			getCodePage({
				codes: [
					HTML,
					{ typeName: "SASS", type: "css", content: "#a{}" },
					{ typeName: "SASS Dark", type: "css", content: "#a{} body.dark-mode{}" },
					{ typeName: "Tailwind", type: "css", content: "@apply x;" },
					{ typeName: "LESS", type: "css", content: "   " },
				],
			}),
		);
		const stitch = scrapeStitch(doc, STITCH_URL("2501"));
		expect(Object.keys(stitch.css).sort()).toEqual(["SCSS", "SCSS Dark"]);
	});

	it("leaves js undefined when the stitch's script is blank", () => {
		const doc = docFrom(
			getCodePage({ codes: [HTML, { typeName: "JS", type: "js", content: " \r\n " }] }),
		);
		expect(scrapeStitch(doc, STITCH_URL("2501")).js).toBeUndefined();
	});

	it("reads core styles when the page has them, and none when it does not", () => {
		const withCore = docFrom(
			getCodePage({ codes: [HTML], core: { css: ":root{--a:1}\r\n", less: ":root{}" } }),
		);
		expect(scrapeStitch(withCore, STITCH_URL("2501")).coreStyles).toEqual({
			CSS: ":root{--a:1}\n",
			LESS: ":root{}",
		});

		// Private stitches render no core textareas at all.
		const without = docFrom(getCodePage({ codes: [HTML] }));
		expect(scrapeStitch(without, STITCH_URL("2501")).coreStyles).toEqual({});
	});

	it("takes the category from the stitch data", () => {
		const doc = docFrom(getCodePage({ codes: [HTML], category: "  Landing + Services " }));
		expect(scrapeStitch(doc, STITCH_URL("2501")).categoryHeading).toBe("Landing + Services");
		const none = docFrom(getCodePage({ codes: [HTML], category: null }));
		expect(scrapeStitch(none, STITCH_URL("2501")).categoryHeading).toBeUndefined();
	});

	it("throws PremiumLockedError when the markup is empty", () => {
		const doc = docFrom(getCodePage({ codes: [{ typeName: "HTML", type: "html", content: "" }] }));
		expect(() => scrapeStitch(doc, STITCH_URL("2501"))).toThrow(PremiumLockedError);
	});

	it("throws SelectorDriftError when there is no stitch data", () => {
		const doc = docFrom("<html><body><h1>Nothing here</h1></body></html>");
		expect(() => scrapeStitch(doc, STITCH_URL("2501"))).toThrow(SelectorDriftError);
	});

	it("still reports a genuine layout change as one", () => {
		const doc = docFrom(
			"<html><head><title>404 - 2501 · Get code</title></head><body>" +
				"<aside class='gc-inspector'>" +
				"<p>a redesigned page with plenty of ordinary content and no stitch data</p>".repeat(12) +
				"</aside><script>window.STITCH = {};</script></body></html>",
		);
		expect(() => scrapeStitch(doc, STITCH_URL("2501"))).toThrow(SelectorDriftError);
	});

	it("says the stitch was refused, not that the site changed", () => {
		// CodeStitch serves a 403 page for a stitch outside your plan. Telling the
		// user the extension needs updating would send them the wrong way.
		const doc = docFrom(
			"<html><head><title>Forbidden</title></head><body>403 FORBIDDEN</body></html>",
		);
		expect(() => scrapeStitch(doc, STITCH_URL("1982"))).toThrow(StitchUnavailableError);
		expect(() => scrapeStitch(doc, STITCH_URL("1982"))).toThrow(
			/did not show this stitch \(403 forbidden\)/i,
		);
	});

	it("throws when the URL is not a stitch page", () => {
		const doc = docFrom(loadPage("2501"));
		expect(() =>
			scrapeStitch(doc, "https://codestitch.app/app/dashboard/catalog/3"),
		).toThrow(SelectorDriftError);
	});
});

describe("GET_CODE parsing", () => {
	it("finds the stitch script and not the icons script after it", () => {
		const doc = docFrom(getCodePage({ codes: [HTML] }));
		const script = findGetCodeScript(doc);
		expect(script?.textContent).toMatch(/^window\.GET_CODE = \{/);
	});

	it("parses the assignment with or without its semicolon", () => {
		const body = JSON.stringify({ stitch: { id: 7, title: "T", codes: [] } });
		expect(parseGetCode(`window.GET_CODE = ${body};`).stitch.id).toBe(7);
		expect(parseGetCode(`\n  window.GET_CODE=${body}\n`).stitch.title).toBe("T");
	});

	it("reports anything else as a layout change", () => {
		for (const text of [
			"window.GET_CODE.icons = {};",
			"window.GET_CODE = {not json};",
			"window.GET_CODE = [];",
			'window.GET_CODE = {"stitch":{"codes":[{"type":"html"}]}};',
			'window.STITCH = {"stitch":{"codes":[]}};',
		]) {
			expect(() => parseGetCode(text), text).toThrow(SelectorDriftError);
		}
	});

	it("maps code type names onto the six CSS variants", () => {
		expect(cssVariantFor("CSS")).toBe("CSS");
		expect(cssVariantFor("css  dark")).toBe("CSS Dark");
		expect(cssVariantFor("SASS")).toBe("SCSS");
		expect(cssVariantFor("SASS Dark")).toBe("SCSS Dark");
		expect(cssVariantFor("HTML")).toBeUndefined();
		expect(cssVariantFor("Tailwind")).toBeUndefined();
	});
});

describe("stitchIdFromUrl", () => {
	it("only recognises a stitch's own code page", () => {
		const id = (url: string) => stitchIdFromUrl(url);
		for (const origin of [
			"https://app.codestitch.app",
			"https://codestitch.app",
			"https://preview.codestitch.app",
		]) {
			const base = `${origin}/app/dashboard/stitches`;

			expect(id(`${base}/1982`)).toBe("1982");
			expect(id(`${base}/1982/`)).toBe("1982");
			expect(id(`${base}/1982?tab=css`)).toBe("1982");
			expect(id(`${base}/1982#top`)).toBe("1982");

			// The live preview has no code; the panel must not appear there.
			expect(id(`${base}/1982/rendered`)).toBeUndefined();
			expect(id(`${base}/1982/rendered/`)).toBeUndefined();
			// Nor on any other sub-page a redesign might add.
			expect(id(`${base}/1982/figma`)).toBeUndefined();
			expect(id(`${base}`)).toBeUndefined();
		}
		expect(id("https://app.codestitch.app/app/dashboard/catalog/3")).toBeUndefined();
		expect(id("not a url")).toBeUndefined();
	});
});
