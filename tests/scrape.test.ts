import { describe, expect, it } from "vitest";
import { scrapeStitch } from "@content/scrape";
import {
	PremiumLockedError,
	SelectorDriftError,
	StitchUnavailableError,
	stitchIdFromUrl,
} from "@content/selectors";
import { loadPage } from "./helpers/loadFixture";

function docFrom(html: string): Document {
	return new DOMParser().parseFromString(html, "text/html");
}

const STITCH_URL = (id: string) =>
	`https://codestitch.app/app/dashboard/stitches/${id}`;

describe("scrapeStitch", () => {
	it("extracts every code field from a real stitch page", () => {
		const doc = docFrom(loadPage("2501"));
		const stitch = scrapeStitch(doc, STITCH_URL("2501"));

		expect(stitch.id).toBe("2501");
		expect(stitch.html).toContain('<section id="not-found-2501">');
		// The 404 stitch ships no JS tab.
		expect(stitch.js).toBeUndefined();

		// All six CSS variants are present in the DOM simultaneously.
		expect(Object.keys(stitch.css).sort()).toEqual([
			"CSS",
			"CSS Dark",
			"LESS",
			"LESS Dark",
			"SCSS",
			"SCSS Dark",
		]);
		expect(stitch.coreStyles.LESS).toContain(":root");
		expect(stitch.categoryHeading).toBe("404");
	});

	it("picks up the JS field when the stitch has one", () => {
		const stitch = scrapeStitch(docFrom(loadPage("1741")), STITCH_URL("1741"));
		expect(stitch.js).toContain("cs-faq-item");
	});

	it("distinguishes LESS from SCSS by their division syntax", () => {
		const stitch = scrapeStitch(docFrom(loadPage("2501")), STITCH_URL("2501"));
		expect(stitch.css.LESS).toMatch(/\(\d+\/16r?em\)/);
		expect(stitch.css.SCSS).toMatch(/calc\(\s*\d+\s*\/\s*16\s*\*\s*1r?em\s*\)/);
	});

	it("gets dark variants that append a body.dark-mode block to the light CSS", () => {
		const stitch = scrapeStitch(docFrom(loadPage("2501")), STITCH_URL("2501"));
		const light = stitch.css.LESS!;
		const dark = stitch.css["LESS Dark"]!;

		expect(dark).toContain("body.dark-mode");
		expect(light).not.toContain("body.dark-mode");
		// Dark is the light CSS plus a trailing block, so selecting the variant
		// is all the dark-mode toggle has to do.
		expect(dark.startsWith(light.trimEnd().slice(0, 200))).toBe(true);
	});

	it("throws SelectorDriftError when the code viewer is missing", () => {
		const doc = docFrom("<html><body><h1>Nothing here</h1></body></html>");
		expect(() => scrapeStitch(doc, STITCH_URL("2501"))).toThrow(SelectorDriftError);
	});

	it("throws PremiumLockedError when every code field is empty", () => {
		const doc = docFrom(`
			<div id="CODE_TABS"><div class="CODE_TABS__BODY">
				<div class="tab" data-codeid="1"><textarea class="CODE-TEXTAREA"></textarea></div>
			</div></div>
		`);
		expect(() => scrapeStitch(doc, STITCH_URL("2501"))).toThrow(PremiumLockedError);
	});

	it("only recognises a stitch's own code page", () => {
		const id = (url: string) => stitchIdFromUrl(url);
		const base = "https://codestitch.app/app/dashboard/stitches";

		expect(id(`${base}/1982`)).toBe("1982");
		expect(id(`${base}/1982/`)).toBe("1982");
		expect(id(`${base}/1982?tab=css`)).toBe("1982");
		expect(id(`${base}/1982#top`)).toBe("1982");

		// The live preview has no code fields; the panel must not appear there.
		expect(id(`${base}/1982/rendered`)).toBeUndefined();
		expect(id(`${base}/1982/rendered/`)).toBeUndefined();
		// Nor on any other sub-page a redesign might add.
		expect(id(`${base}/1982/figma`)).toBeUndefined();
		expect(id(`${base}`)).toBeUndefined();
		expect(id("https://codestitch.app/app/dashboard/catalog/3")).toBeUndefined();
		expect(id("not a url")).toBeUndefined();
	});

	it("says the stitch was refused, not that the site changed", () => {
		// CodeStitch serves a 403 page for a stitch outside your plan. Telling the
		// user the extension needs updating would send them the wrong way.
		const doc = docFrom(
			"<html><head><title>Forbidden</title></head><body>403 FORBIDDEN</body></html>",
		);
		expect(() => scrapeStitch(doc, STITCH_URL("1982"))).toThrow(
			StitchUnavailableError,
		);
		expect(() => scrapeStitch(doc, STITCH_URL("1982"))).toThrow(
			/did not show this stitch \(403 forbidden\)/i,
		);
	});

	it("still reports a genuine layout change as one", () => {
		const doc = docFrom(
			"<html><head><title>Code of Stitch</title></head><body>" +
				"<div class='section-body'><h2 class='heading'>Hero</h2>" +
				"<p>a redesigned page with plenty of ordinary content and no code viewer</p>".repeat(
					12,
				) +
				"</div></body></html>",
		);
		expect(() => scrapeStitch(doc, STITCH_URL("2501"))).toThrow(SelectorDriftError);
	});

	it("throws when the URL is not a stitch page", () => {
		const doc = docFrom(loadPage("2501"));
		expect(() =>
			scrapeStitch(doc, "https://codestitch.app/app/dashboard/catalog/3"),
		).toThrow(SelectorDriftError);
	});
});
