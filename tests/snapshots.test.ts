import { describe, expect, it } from "vitest";
import { convert } from "@core/convert";
import type { ConvertOptions, FetchAsset, LinkMapping } from "@core/types";
import { componentSourceFor, inspectLinks } from "@core/convert";
import { FIXTURE_DIRS, loadFixture } from "./helpers/loadFixture";

/**
 * Snapshots are real .astro / .json files under tests/__snapshots__, so a diff
 * shows exactly what a user would receive. Review them like code.
 */

/** Deterministic stand-ins so tests need no network: a real 1x1 GIF and a real SVG. */
const GIF_1X1 = "R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";
const TINY_SVG = "PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAxNiAxNiI+PHBhdGggZD0iTTIgOGgxMiIvPjwvc3ZnPg==";

const stubFetchAsset: FetchAsset = async (url) => {
	const isSvg = new URL(url).pathname.toLowerCase().endsWith(".svg");
	return {
		base64: isSvg ? TINY_SVG : GIF_1X1,
		contentType: isSvg ? "image/svg+xml" : "image/gif",
		originalUrl: url,
	};
};

const base: ConvertOptions = {
	kit: "decap",
	cssFlavor: "less",
	darkMode: true,
	includeCoreStyles: false,
	includeJs: true,
	i18n: false,
	imagesMode: "raw",
};

/** Resolves every placeholder link to a route the pristine kit really has. */
function resolveLinks(fixture: string): LinkMapping[] {
	return inspectLinks(loadFixture(fixture)).map((l) => ({ ...l, route: "/about" }));
}

interface Case {
	name: string;
	fixture: string;
	options: Partial<ConvertOptions>;
	resolveLinks?: boolean;
}

/**
 * The documented option matrix across representative stitches, rather than a
 * hand-picked few: every kit x flavour x images-mode x dark combination that
 * changes the output shape.
 */
const CASES: Case[] = (() => {
	const cases: Case[] = [];

	// Full matrix on the simplest stitch, so a flag's effect is easy to read.
	for (const kit of ["decap", "i18n"] as const) {
		for (const cssFlavor of ["less", "scss", "css"] as const) {
			for (const imagesMode of ["assets", "raw"] as const) {
				for (const darkMode of [true, false]) {
					cases.push({
						name: `NotFound-2501.${kit}.${cssFlavor}.${imagesMode}.${darkMode ? "dark" : "light"}`,
						fixture: FIXTURE_DIRS.notFound,
						options: {
							kit,
							cssFlavor,
							imagesMode,
							darkMode,
							i18n: kit === "i18n",
						},
						resolveLinks: true,
					});
				}
			}
		}
	}

	// The harder stitches on the settings that actually exercise them.
	const featured: Array<[string, string, Partial<ConvertOptions>]> = [
		["Faq-1741.decap.assets", FIXTURE_DIRS.faq, { kit: "decap", imagesMode: "assets" }],
		["Faq-1741.i18n.assets", FIXTURE_DIRS.faq, { kit: "i18n", i18n: true, imagesMode: "assets" }],
		["Hero-2274.decap.assets", FIXTURE_DIRS.heroMultiSection, { kit: "decap", imagesMode: "assets" }],
		["Hero-2274.i18n.assets", FIXTURE_DIRS.heroMultiSection, { kit: "i18n", i18n: true, imagesMode: "assets" }],
		["Hero-1946.decap.assets", FIXTURE_DIRS.heroLanding, { kit: "decap", imagesMode: "assets" }],
		["Contact-2320.i18n.assets", FIXTURE_DIRS.contact, { kit: "i18n", i18n: true, imagesMode: "assets" }],
		["Contact-2320.decap.raw", FIXTURE_DIRS.contact, { kit: "decap", imagesMode: "raw" }],
		["Navigation-757.decap.assets", FIXTURE_DIRS.nav, { kit: "decap", imagesMode: "assets" }],
		["Navigation-757.i18n.assets", FIXTURE_DIRS.nav, { kit: "i18n", i18n: true, imagesMode: "assets" }],
		// Options that deliberately produce Draft output.
		["Faq-1741.decap.core-styles", FIXTURE_DIRS.faq, { kit: "decap", includeCoreStyles: true }],
		["Faq-1741.decap.no-js", FIXTURE_DIRS.faq, { kit: "decap", includeJs: false }],
		["Navigation-757.decap.keep-nav-js", FIXTURE_DIRS.nav, { kit: "decap", imagesMode: "raw", keepKitNavScript: true }],
		["Faq-1741.i18n.no-extraction", FIXTURE_DIRS.faq, { kit: "i18n", i18n: false }],
	];
	for (const [name, fixture, options] of featured) {
		cases.push({ name, fixture, options, resolveLinks: true });
	}

	// Routes read off the link text, with nothing typed — what a sixteen-link
	// navigation actually produces.
	cases.push({
		name: "Navigation-757.decap.guessed-routes",
		fixture: FIXTURE_DIRS.nav,
		options: { kit: "decap", imagesMode: "raw" },
		resolveLinks: false,
	});

	// The same stitch with guessing switched off: every link a TODO.
	cases.push({
		name: "Navigation-757.decap.no-guessing",
		fixture: FIXTURE_DIRS.nav,
		options: { kit: "decap", imagesMode: "raw", guessRoutes: false },
		resolveLinks: false,
	});

	// Unresolved links are the most common Draft reason, so keep one case that
	// leaves them alone.
	cases.push({
		name: "NotFound-2501.decap.unresolved-links",
		fixture: FIXTURE_DIRS.notFound,
		options: { kit: "decap", imagesMode: "raw", guessRoutes: false },
		resolveLinks: false,
	});

	return cases;
})();

describe("conversion snapshots", () => {
	for (const testCase of CASES) {
		it(`${testCase.name}`, async () => {
			const stitch = loadFixture(testCase.fixture);
			const result = await convert(
				stitch,
				{
					...base,
					...testCase.options,
					linkMappings: testCase.resolveLinks ? resolveLinks(testCase.fixture) : [],
				},
				stubFetchAsset,
			);

			const astro = result.files.find((f) => f.path.endsWith(".astro"))!;
			await expect(astro.contents).toMatchFileSnapshot(
				`./__snapshots__/${testCase.name}.astro`,
			);

			const locale = result.files.find((f) => f.path.startsWith("src/locales/en/"));
			if (locale) {
				await expect(locale.contents).toMatchFileSnapshot(
					`./__snapshots__/${testCase.name}.en.json`,
				);
			}

			// What a user gets by copying the .astro on its own, which for a
			// multi-file component is a stricter verdict than the ZIP's.
			if (result.files.length > 1) {
				await expect(
					componentSourceFor(result, "component-only"),
				).toMatchFileSnapshot(
					`./__snapshots__/${testCase.name}.component-only.astro`,
				);
			}

			// The verdict and its reasons are part of the contract too.
			await expect(
				`${result.readiness.state}\n${result.readiness.reasons.map((r) => `- ${r}`).join("\n")}\n`,
			).toMatchFileSnapshot(`./__snapshots__/${testCase.name}.readiness.txt`);
		});
	}
});
