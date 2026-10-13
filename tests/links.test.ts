import { describe, expect, it } from "vitest";
import {
	codestitchLinkOccurrences,
	deriveRouteFromText,
	resolveDestination,
} from "@core/html/links";
import { profileFor } from "@core/kits/profile";
import { convert, inspectLinks } from "@core/convert";
import type { ConvertOptions } from "@core/types";
import { FIXTURE_DIRS, loadFixture } from "./helpers/loadFixture";

const options = (over: Partial<ConvertOptions> = {}): ConvertOptions => ({
	kit: "decap",
	cssFlavor: "less",
	darkMode: true,
	includeCoreStyles: false,
	includeJs: true,
	i18n: false,
	imagesMode: "raw",
	...over,
});

describe("deriveRouteFromText", () => {
	it("turns a page name into the route you would have typed", () => {
		expect(deriveRouteFromText("About")).toBe("/about");
		expect(deriveRouteFromText("Privacy Policy")).toBe("/privacy-policy");
		expect(deriveRouteFromText("Terms Of Use")).toBe("/terms-of-use");
		expect(deriveRouteFromText("Stitch Designs")).toBe("/stitch-designs");
		expect(deriveRouteFromText("Donations")).toBe("/donations");
		expect(deriveRouteFromText("News & Events")).toBe("/news-and-events");
	});

	it("sends Home to the site root", () => {
		expect(deriveRouteFromText("Home")).toBe("/");
		expect(deriveRouteFromText("home")).toBe("/");
	});

	it("declines text that is plainly not a page name", () => {
		// These appear as links in CodeStitch top bars; slugifying them would
		// produce /m-f-8am-530pm and similar nonsense.
		expect(deriveRouteFromText("M-F 8am – 5:30pm")).toBeUndefined();
		expect(deriveRouteFromText("555 Olive Crt, Montclair, CA")).toBeUndefined();
		expect(deriveRouteFromText("(555) 233-2411")).toBeUndefined();
		expect(deriveRouteFromText("hello@example.com")).toBeUndefined();
		expect(
			deriveRouteFromText("Read more about how we work with our clients"),
		).toBeUndefined();
		expect(deriveRouteFromText("(no text)")).toBeUndefined();
		expect(deriveRouteFromText("")).toBeUndefined();
	});
});

describe("link suggestions on a real navigation stitch", () => {
	it("names links that have no text of their own", () => {
		const links = inspectLinks(loadFixture(FIXTURE_DIRS.nav));

		// Nothing is listed as "(no text)" when the markup describes it: the logo
		// is an image link, but it carries an aria-label worth showing.
		const logo = links.find((l) => /home page/i.test(l.text));
		expect(logo).toBeDefined();
		expect(logo!.text).toMatch(/Return to .* Home page/);
		// A logo always goes home, whatever its label says.
		expect(logo!.suggestedRoute).toBe("/");
	});

	it("offers a route for most links without any typing", () => {
		const links = inspectLinks(loadFixture(FIXTURE_DIRS.nav));
		const withSuggestion = links.filter((l) => l.suggestedRoute);

		expect(links.length).toBeGreaterThan(5);
		// The bulk of a navigation is page names, so most should resolve.
		expect(withSuggestion.length / links.length).toBeGreaterThan(0.6);
	});

	it("reports pages the kit does not ship as one line, not one per link", async () => {
		const stitch = loadFixture(FIXTURE_DIRS.nav);
		const result = await convert(stitch, options());

		const missing = result.warnings.filter((w) => w.code === "route-not-in-kit");
		expect(missing).toHaveLength(1);
		expect(missing[0]!.message).toMatch(/links point at pages/);

		// And the guesses themselves are reported once, as a note.
		const guessed = result.warnings.filter((w) => w.code === "routes-guessed");
		expect(guessed).toHaveLength(1);
		expect(guessed[0]!.severity).toBe("info");
	});
});


/** A footer-style block of social icon links, as CodeStitch writes them. */
const SOCIAL_HTML = `<section id="footer-1">
	<ul class="cs-social">
		<li class="cs-social-li">
			<a class="cs-social-link" href="" aria-label="visit facebook profile">
				<img class="cs-social-img" src="https://csimg.nyc3.cdn.digitaloceanspaces.com/Icons/facebook.svg" alt="facebook" width="12" height="12">
			</a>
		</li>
		<li class="cs-social-li">
			<a class="cs-social-link" href="" aria-label="visit instagram profile">
				<img class="cs-social-img" src="https://csimg.nyc3.cdn.digitaloceanspaces.com/Icons/instagram.svg" alt="instagram" width="12" height="12">
			</a>
		</li>
		<li class="cs-social-li">
			<a class="cs-social-link" href="" aria-label="visit twitter profile">
				<img class="cs-social-img" src="https://csimg.nyc3.cdn.digitaloceanspaces.com/Icons/twitter.svg" alt="twitter" width="12" height="12">
			</a>
		</li>
	</ul>
	<a href="" class="cs-link">Privacy Policy</a>
</section>`;

function socialStitch() {
	return { ...loadFixture(FIXTURE_DIRS.notFound), html: SOCIAL_HTML };
}

describe("social links", () => {
	it("points at the kit's own business data where it has an entry", async () => {
		const result = await convert(socialStitch(), options());
		const astro = result.files[0]!.contents;

		// Not /visit-facebook-profile, which could never exist.
		expect(astro).not.toContain("visit-facebook-profile");
		expect(astro).toContain("href={BUSINESS.socials.facebook}");
		expect(astro).toContain("href={BUSINESS.socials.instagram}");

		// And the data is imported, under the kit's own export name and path.
		expect(astro).toContain('import { BUSINESS } from "@data/client";');
		expect(astro).toContain("// Data");
	});

	it("falls back to the network itself when the kit has no entry", async () => {
		const result = await convert(socialStitch(), options());
		const astro = result.files[0]!.contents;

		// Neither kit ships a twitter entry.
		expect(astro).toContain('href="https://twitter.com/"');
		const warning = result.warnings.find((w) => w.code === "social-link-placeholder");
		expect(warning?.severity).toBe("draft");
		expect(warning?.message).toMatch(/src\/data\/client\.ts/);
	});

	it("still reads ordinary links off their text", async () => {
		const astro = (await convert(socialStitch(), options())).files[0]!.contents;
		expect(astro).toContain('href="/privacy-policy/"');
	});

	it("accepts an expression typed by hand", async () => {
		const stitch = socialStitch();
		const links = inspectLinks(stitch);
		const twitter = links.find((l) => l.social === "twitter")!;
		const result = await convert(
			stitch,
			options({
				linkMappings: [{ ...twitter, route: "{BUSINESS.socials.twitter}" }],
			}),
		);

		expect(result.files[0]!.contents).toContain("href={BUSINESS.socials.twitter}");
		// A hand-written expression is not a guess, so it is not reported as one.
		expect(result.warnings.map((w) => w.code)).not.toContain(
			"social-link-placeholder",
		);
	});

	it("localises ordinary routes but leaves social links alone", async () => {
		const astro = (
			await convert(socialStitch(), options({ kit: "i18n", i18n: true }))
		).files[0]!.contents;

		expect(astro).toContain('getLocalizedRoute(locale, "/privacy-policy/")');
		// A social profile is an absolute destination, not a site route.
		expect(astro).toContain("href={BUSINESS.socials.facebook}");
		expect(astro).not.toContain("getLocalizedRoute(locale, \"{BUSINESS");
	});
});

describe("typed fragments", () => {
	const stitch = () =>
		({
			...loadFixture(FIXTURE_DIRS.notFound),
			html: '<section id="not-found-2501"><a href="" class="cs-button-solid">Contact</a></section>',
		});

	for (const kit of ["advanced-v4", "i18n", "decap"] as const) {
		it(`keeps a typed #fragment on the current page (${kit})`, async () => {
			const s = stitch();
			const [link] = inspectLinks(s);
			const astro = (
				await convert(
					s,
					options({ kit, i18n: kit !== "decap", linkMappings: [{ ...link!, route: "#contact" }] }),
				)
			).files[0]!.contents;
			// Not "/#contact", and not the home page through the route helper.
			expect(astro).toMatch(/href="#contact"/);
			expect(astro).not.toContain('"/#contact');
		});
	}

	it("still sends /#contact to the home page's anchor", async () => {
		const s = stitch();
		const [link] = inspectLinks(s);
		const astro = (
			await convert(s, options({ kit: "advanced-v4", i18n: true, linkMappings: [{ ...link!, route: "/#contact" }] }))
		).files[0]!.contents;
		expect(astro).toContain('getLocalizedRoute(locale, "/") + "#contact"');
	});
});

describe("resolveDestination", () => {
	const v4 = profileFor("advanced-v4");

	it("classifies each kind of destination", () => {
		expect(resolveDestination("", v4, true)).toEqual({ kind: "empty" });
		expect(resolveDestination("  #contact ", v4, true)).toEqual({ kind: "fragment", href: "#contact" });
		expect(resolveDestination("tel:5550100", v4, true)).toMatchObject({ kind: "external", contact: true });
		expect(resolveDestination("https://x.test/", v4, true)).toMatchObject({ kind: "external", contact: false });
		expect(resolveDestination("{BUSINESS.socials.facebook}", v4, true)).toMatchObject({
			kind: "expression",
			code: "BUSINESS.socials.facebook",
			usesBusinessData: true,
		});
	});

	it("checks routes against the pages the kit ships", () => {
		expect(resolveDestination("/about", v4, true)).toMatchObject({ kind: "route", target: "/about/", shipped: true });
		expect(resolveDestination("/return-to-home", v4, true)).toMatchObject({ kind: "route", shipped: false });
		// A navigation parent with a dropdown has no page of its own.
		expect(resolveDestination("/projects", v4, true)).toMatchObject({ kind: "route", shipped: false });
	});

	it("resolves a localized path the way conversion does", () => {
		const resolved = resolveDestination("/fr/a-propos", v4, true);
		expect(resolved).toMatchObject({ kind: "route", target: "/about/", shipped: true });
		expect(resolved.kind === "route" && resolved.localeNote).toBeTruthy();
	});
});

describe("codestitchLinkOccurrences", () => {
	it("numbers empty-href anchors the way CodeStitch's Get code does", () => {
		const html = [
			'<a href="">One</a>',
			'<!-- <a href="">Commented</a> -->',
			"<a href='' class=\"x\">Two</a>",
			'<a href="#">Hash</a>',
			'<a href="/set">Set</a>',
			'<a data-title="a>b" href="">Three</a>',
		].join("\n");
		expect(codestitchLinkOccurrences(html)).toEqual([
			{ index: 0, inComment: false },
			{ index: 1, inComment: true },
			{ index: 2, inComment: false },
			{ index: 3, inComment: false },
		]);
	});
});

describe("kit-aware link inspection", () => {
	it("suggests the kit's business data for a social link when the kit is given", () => {
		const stitch = {
			...loadFixture(FIXTURE_DIRS.notFound),
			html: '<section id="s-1"><a href="" aria-label="visit facebook profile"><img alt="facebook" src="x.svg"></a></section>',
		};
		expect(inspectLinks(stitch)[0]!.suggestedRoute).toBe("https://www.facebook.com/");
		expect(inspectLinks(stitch, "advanced-v4")[0]!.suggestedRoute).toBe("{BUSINESS.socials.facebook}");
	});

	it("adds preflight findings to the verdict", async () => {
		const result = await convert(
			loadFixture(FIXTURE_DIRS.notFound),
			options({ preflightWarnings: [{ severity: "draft", code: "x-pre", message: "Checked before converting." }] }),
		);
		expect(result.readiness.state).toBe("draft");
		expect(result.readiness.reasons).toContain("Checked before converting.");
	});
});
