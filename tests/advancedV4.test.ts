import { describe, expect, it } from "vitest";
import { convert } from "@core/convert";
import type { ConvertOptions, StitchData } from "@core/types";
import { profileFor } from "@core/kits/profile";

/**
 * Advanced v4 generation.
 *
 * The two things that changed from v3 reach every component: copy is read as
 * data off `content`, and a destination is resolved against the project's own
 * navData before `getRoute` prefixes it. Both are checked here on markup
 * written for the case, rather than on a fixture that happens to contain one.
 */

const V4: ConvertOptions = {
	kit: "advanced-v4",
	cssFlavor: "less",
	darkMode: false,
	includeCoreStyles: false,
	includeJs: false,
	i18n: true,
	imagesMode: "raw",
	guessRoutes: true,
};

function stitch(html: string, id = "9001"): StitchData {
	return {
		id,
		url: `https://codestitch.app/app/dashboard/stitches/${id}`,
		html,
		css: { LESS: "#demo { color: red; }" },
		coreStyles: {},
	};
}

async function run(html: string, options: Partial<ConvertOptions> = {}) {
	const result = await convert(stitch(html), { ...V4, ...options });
	const astro = result.files[0]!.contents;
	return {
		result,
		astro,
		markup: astro.slice(astro.indexOf("---", 3) + 3),
		messages: (locale = "en") =>
			JSON.parse(
				result.files.find((f) => f.path.startsWith(`src/locales/${locale}/`))?.contents ??
					"null",
			),
		reasons: result.readiness.reasons,
		notes: result.warnings.filter((w) => w.severity === "info").map((w) => w.message),
	};
}

describe("advanced v4 — reading copy as data", () => {
	it("reads a string as a property of content, not through t()", async () => {
		const out = await run(
			'<section id="demo"><h2 class="cs-title">Hello</h2></section>',
		);
		expect(out.markup).toContain("{content.demo9001.title}");
		expect(out.astro).not.toContain('t("demo9001:');
		expect(out.messages()).toEqual({ title: "Hello" });
	});

	it("indexes repeated blocks as an array", async () => {
		const out = await run(`<section id="demo">
			<ul>
				<li class="cs-item"><h3 class="cs-h3">One</h3></li>
				<li class="cs-item"><h3 class="cs-h3">Two</h3></li>
			</ul>
		</section>`);
		expect(out.markup).toContain("{content.demo9001.items[0].h3}");
		expect(out.markup).toContain("{content.demo9001.items[1].h3}");
		expect(out.messages().items).toEqual([{ h3: "One" }, { h3: "Two" }]);
	});

	it("keeps duplicate keys readable as properties, never hyphenated", async () => {
		// Two headings under different parents both want the key "title".
		const out = await run(`<section id="demo">
			<div><h2 class="cs-title">First</h2></div>
			<div><h2 class="cs-title">Second</h2></div>
			<div><h2 class="cs-title">Third</h2></div>
		</section>`);
		// A hyphen would be subtraction once the key is read as a property.
		expect(out.markup).not.toMatch(/content\.demo9001\.[\w.]*-/);
		expect(Object.keys(out.messages())).toEqual(["title", "title2", "title3"]);
		expect(Object.values(out.messages())).toEqual(["First", "Second", "Third"]);
	});

	it("gives a digit-leading class name a usable key", async () => {
		const out = await run(
			'<section id="demo"><h2 class="cs-404-title">Not found</h2></section>',
		);
		const key = /content\.demo9001\.(\w+)/.exec(out.markup)?.[1];
		expect(key).toBeDefined();
		expect(key).toMatch(/^[A-Za-z_$][\w$]*$/);
	});

	it("does not let an attribute and its element's text overwrite each other", async () => {
		const out = await run(
			'<section id="demo"><a class="cs-link" aria-label="Open the card">Read more</a></section>',
		);
		const messages = out.messages();
		// Both strings survive: one may not be written inside the other.
		expect(JSON.stringify(messages)).toContain("Open the card");
		expect(JSON.stringify(messages)).toContain("Read more");
	});

	it("writes one locale file and no untranslated warning for a single-language project", async () => {
		const out = await run(
			'<section id="demo"><h2 class="cs-title">Hello</h2></section>',
			{ multilingual: false },
		);
		const locales = out.result.files.filter((f) => f.path.startsWith("src/locales/"));
		expect(locales.map((f) => f.path)).toEqual(["src/locales/en/demo9001.json"]);
		expect(out.reasons.join(" ")).not.toContain("translate");
	});

	it("writes every configured locale when the project keeps them", async () => {
		const out = await run('<section id="demo"><h2 class="cs-title">Hello</h2></section>');
		expect(out.result.files.map((f) => f.path)).toEqual(
			expect.arrayContaining([
				"src/locales/en/demo9001.json",
				"src/locales/fr/demo9001.json",
			]),
		);
		expect(out.reasons.join(" ")).toContain("translate");
	});

	it("leaves copy in the markup when extraction is off", async () => {
		const out = await run('<section id="demo"><h2 class="cs-title">Hello</h2></section>', {
			i18n: false,
		});
		expect(out.markup).toContain(">Hello<");
		expect(out.result.files.filter((f) => f.path.startsWith("src/locales/"))).toHaveLength(0);
		expect(out.astro).not.toContain("content.");
	});

	it("renames a locale file that would overwrite one the kit ships", async () => {
		const profile = profileFor("advanced-v4");
		expect(profile.namespaceFiles).toContain("contact");

		const out = await run('<section id="demo"><h2 class="cs-title">Hi</h2></section>', {
			componentName: "Contact",
		});
		expect(out.result.files.map((f) => f.path)).toContain(
			"src/locales/en/contact9001.json",
		);
		expect(out.notes.join(" ")).toContain("already ships");
	});

	it("never imports a module the kit's i18n removal script deletes", async () => {
		for (const i18n of [true, false]) {
			const out = await run(
				'<section id="demo"><a href="">About</a><h2 class="cs-title">Hi</h2></section>',
				{ i18n },
			);
			expect(out.astro).not.toContain("@js/localeUtils");
			expect(out.astro).not.toContain("@js/translationUtils");
			expect(out.astro).not.toContain("features/i18n");
			expect(out.astro).toContain('from "@js/getSiteContext"');
		}
	});
});

describe("advanced v4 — resolving destinations", () => {
	const link = (text: string, href = "") =>
		`<section id="demo"><a href="${href}">${text}</a></section>`;

	it("resolves the home page, a translated page and a nested one", async () => {
		for (const [text, route] of [
			["Home", "/"],
			["About", "/about/"],
		] as const) {
			const out = await run(link(text));
			expect(out.markup).toContain(`href={routeFor("${route}")}`);
		}

		const nested = await run(link("Anything", ""), {
			linkMappings: [
				{ id: "link-0", text: "Anything", originalHref: "", route: "/projects/project-1" },
			],
		});
		expect(nested.markup).toContain('href={routeFor("/projects/project-1/")}');
		expect(nested.reasons.join(" ")).not.toContain("does not ship");
	});

	it("keeps a query string and a fragment out of the trailing slash", async () => {
		for (const [typed, expected] of [
			["/contact?ref=hero", "/contact/?ref=hero"],
			["/about#team", "/about/#team"],
		] as const) {
			const out = await run(link("Anything"), {
				linkMappings: [{ id: "link-0", text: "Anything", originalHref: "", route: typed }],
			});
			expect(out.markup).toContain(`href={routeFor("${expected}")}`);
			expect(out.reasons.join(" ")).not.toContain("does not ship");
		}
	});

	it("reports a destination the kit has no page for", async () => {
		const out = await run(link("Services"));
		expect(out.reasons.join(" ")).toContain("/services/");
	});

	it("does not treat a navigation parent as a page", async () => {
		// /projects is a dropdown with children and no page of its own.
		expect(profileFor("advanced-v4").routes).not.toContain("/projects");
		const out = await run(link("Anything"), {
			linkMappings: [{ id: "link-0", text: "Anything", originalHref: "", route: "/projects" }],
		});
		expect(out.reasons.join(" ")).toContain("/projects/");
	});

	it("says when a destination only exists while a removable feature is installed", async () => {
		const out = await run(link("About"));
		expect(out.notes.join(" ")).toContain("demo");
		// It still builds, so it is not a reason to withhold Ready.
		expect(out.reasons.join(" ")).not.toContain("demo files");
	});

	it("leaves external links, contact links and supplied expressions alone", async () => {
		const out = await run(`<section id="demo">
			<a href="https://example.com/x">Site</a>
			<a href="tel:5551234">Call</a>
			<a href="mailto:a@b.co">Mail</a>
		</section>`);
		expect(out.markup).toContain('href="https://example.com/x"');
		expect(out.markup).toContain('href="tel:5551234"');
		expect(out.markup).toContain('href="mailto:a@b.co"');
		expect(out.markup).not.toContain("routeFor(\"https");

		const expression = await run(`<section id="demo"><a href="">Facebook</a></section>`);
		expect(expression.markup).toContain("href={BUSINESS.socials.facebook}");
	});

	it("emits the route helper only when the markup has a local link", async () => {
		const without = await run('<section id="demo"><h2 class="cs-title">Hi</h2></section>');
		expect(without.astro).not.toContain("routeFor");
		expect(without.astro).not.toContain("navData");

		const with_ = await run(link("About"));
		expect(with_.astro).toContain('import { getRoute } from "@js/routes";');
		expect(with_.astro).toContain('import navData from "@data/navData.json";');
	});
});
