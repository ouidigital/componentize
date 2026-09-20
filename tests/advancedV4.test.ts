import { describe, expect, it } from "vitest";
import { convert } from "@core/convert";
import type { ConvertOptions, StitchData } from "@core/types";
import { profileFor } from "@core/kits/profile";
import { freeNamespace } from "@core/naming";

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

	it("keeps looking until the locale file name is free", () => {
		// Stopping at the first fallback would leave the original name in
		// place, which is the overwrite this check exists to prevent.
		expect(freeNamespace("hero", "1621", ["contact"])).toBe("hero");
		expect(freeNamespace("contact", "1621", ["contact"])).toBe("contact1621");
		expect(freeNamespace("contact", "1621", ["contact", "contact1621"])).toBe(
			"contact16212",
		);
		const reserved = ["contact", "contact1621", "contact16212", "contact16213"];
		expect(reserved).not.toContain(freeNamespace("contact", "1621", reserved));
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
			expect(out.markup).toContain(`href={getLocalizedRoute(locale, "${route}")}`);
		}

		const nested = await run(link("Anything", ""), {
			linkMappings: [
				{ id: "link-0", text: "Anything", originalHref: "", route: "/projects/project-1" },
			],
		});
		expect(nested.markup).toContain(
			'href={getLocalizedRoute(locale, "/projects/project-1/")}',
		);
		expect(nested.reasons.join(" ")).not.toContain("does not ship");
	});

	it("keeps a query string and a fragment outside the route call", async () => {
		// The kit's helper normalises whatever it is handed to a trailing
		// slash, so passing it the whole thing would yield /contact?ref=hero/.
		for (const [typed, expected] of [
			["/contact?ref=hero", 'getLocalizedRoute(locale, "/contact/") + "?ref=hero"'],
			["/about#team", 'getLocalizedRoute(locale, "/about/") + "#team"'],
		] as const) {
			const out = await run(link("Anything"), {
				linkMappings: [{ id: "link-0", text: "Anything", originalHref: "", route: typed }],
			});
			expect(out.markup).toContain(`href={${expected}}`);
			expect(out.reasons.join(" ")).not.toContain("does not ship");
		}
	});

	/**
	 * The kit's helper takes an unprefixed path and adds the prefix itself, so
	 * handing it a French URL produces /fr/fr/a-propos/. Somebody copying a
	 * link out of their own French site writes exactly that, with whatever
	 * query string or fragment was on the end of it.
	 */
	describe("a destination written with a locale prefix", () => {
		const route = async (typed: string) => {
			const out = await run(link("Anything"), {
				linkMappings: [
					{ id: "link-0", text: "Anything", originalHref: "", route: typed },
				],
			});
			const call = /href=\{([^}]*)\}/.exec(out.markup)?.[1] ?? "";
			return { call, out };
		};

		// The prefix and the suffix have to be handled together: stripping one
		// while the other is still attached is what made the slug unmatchable.
		const cases: Array<[typed: string, expected: string]> = [
			["/fr/a-propos", 'getLocalizedRoute(locale, "/about/")'],
			["/fr/a-propos?ref=hero", 'getLocalizedRoute(locale, "/about/") + "?ref=hero"'],
			["/fr/a-propos#team", 'getLocalizedRoute(locale, "/about/") + "#team"'],
			[
				"/fr/projets/projet-1?utm=x",
				'getLocalizedRoute(locale, "/projects/project-1/") + "?utm=x"',
			],
			// The default locale is normally unprefixed, so this path does not
			// exist; the prefix still has to come off, or the helper adds a second.
			["/en/about", 'getLocalizedRoute(locale, "/about/")'],
			["/en/about?ref=hero", 'getLocalizedRoute(locale, "/about/") + "?ref=hero"'],
		];

		for (const [typed, expected] of cases) {
			it(`maps ${typed}`, async () => {
				const { call, out } = await route(typed);
				expect(call).toBe(expected);
				expect(call).not.toContain("/fr/");
				expect(call).not.toContain("/en/");
				// Mapped cleanly, so the prefix is not a reason to withhold Ready.
				expect(out.reasons.join(" ")).not.toContain("no translation");
			});
		}

		it("keeps a usable unprefixed path when it cannot map one", async () => {
			const { call, out } = await route("/fr/une-page-inventee?ref=hero");

			// Dropping the prefix is what makes it usable: left on, the helper
			// would add a second one and the link would go nowhere.
			expect(call).toBe(
				'getLocalizedRoute(locale, "/une-page-inventee/") + "?ref=hero"',
			);
			// The default-locale path is a guess, so it may not claim Ready.
			expect(out.reasons.join(" ")).toContain("no translation");
		});
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
		expect(out.markup).not.toContain('getLocalizedRoute(locale, "https');

		const expression = await run(`<section id="demo"><a href="">Facebook</a></section>`);
		expect(expression.markup).toContain("href={BUSINESS.socials.facebook}");
	});

	it("emits the route helper only when the markup has a local link", async () => {
		const without = await run('<section id="demo"><h2 class="cs-title">Hi</h2></section>');
		expect(without.astro).not.toContain("getLocalizedRoute");
		expect(without.astro).not.toContain("@js/routes");

		const with_ = await run(link("About"));
		expect(with_.astro).toContain('import { getLocalizedRoute } from "@js/routes";');
		// The kit resolves the slug itself, so the component carries no lookup
		// of its own and needs no navData import.
		expect(with_.astro).not.toContain("navData");
		expect(with_.astro).not.toContain("NavItem");
	});
});
