import { describe, expect, it } from "vitest";
import { DEFAULT_PREFS, markupFingerprint, sanitizePrefs, stitchStateFrom } from "@ui/prefs";

describe("sanitizePrefs", () => {
	it("keeps only what this version owns", () => {
		const stored = {
			kit: "decap",
			cssFlavor: "scss",
			darkMode: false,
			includeJs: false,
			imagesMode: "raw",
			guessRoutes: false,
			includeCoreStyles: true,
			i18n: false,
			multilingual: false,
		};
		expect(sanitizePrefs(stored)).toEqual({
			kit: "decap",
			includeCoreStyles: true,
			i18n: false,
			multilingual: false,
		});
	});

	it("falls back per key on anything unusable", () => {
		expect(sanitizePrefs({ kit: "nope", i18n: "yes" })).toEqual(DEFAULT_PREFS);
		expect(sanitizePrefs(undefined)).toEqual(DEFAULT_PREFS);
		expect(sanitizePrefs("x")).toEqual(DEFAULT_PREFS);
	});
});

describe("per-stitch state", () => {
	const html = '<section id="s-1"><a href="">About</a><a href="" aria-label="facebook"></a></section>';

	it("round-trips for the markup it was saved on", () => {
		const fp = markupFingerprint({ html });
		expect(stitchStateFrom({ fingerprint: fp, socialChoices: { "link-1": true, x: "no" } }, fp)).toEqual({
			socialChoices: { "link-1": true },
		});
		// Line endings and surrounding whitespace are not edits.
		expect(markupFingerprint({ html: `\r\n${html.replace(/></g, ">\r\n<")}\n` })).not.toBe(fp);
		expect(markupFingerprint({ html: `  ${html}\n` })).toBe(fp);
	});

	it("discards choices saved for different markup", () => {
		const fp = markupFingerprint({ html });
		expect(stitchStateFrom({ fingerprint: "other", socialChoices: { "link-1": true } }, fp)).toEqual({
			socialChoices: {},
		});
		expect(stitchStateFrom(null, fp)).toEqual({ socialChoices: {} });
	});

	it("does not restore a choice onto a different anchor after an ordinary link is inserted", () => {
		// Ids count every anchor, so a populated link inserted first turns the
		// facebook link from link-1 into link-2. Same placeholders, new markup.
		const before = markupFingerprint({ html });
		const after = markupFingerprint({
			html: html.replace('<section id="s-1">', '<section id="s-1"><a href="/x">X</a>'),
		});
		expect(after).not.toBe(before);
		expect(stitchStateFrom({ fingerprint: before, socialChoices: { "link-1": true } }, after)).toEqual({
			socialChoices: {},
		});
	});
});
