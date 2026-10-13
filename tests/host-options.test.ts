import { afterEach, describe, expect, it } from "vitest";
import { readHostSettings, type HostSettings } from "@content/host-fields";
import { scrapeStitch } from "@content/scrape";
import { convert } from "@core/convert";
import type { StitchData } from "@core/types";
import { DEFAULT_PREFS, type Prefs } from "@ui/prefs";
import {
	codestitchDefaultFileName,
	composeOptions,
	defaultFallbacks,
	mapImagesFolder,
	resolveFlavour,
	type OwnChoices,
} from "@ui/host-options";
import { FIXTURE_DIRS, loadFixture, loadPage } from "./helpers/loadFixture";
import { getCodePage } from "./helpers/getCodePage";
import { click, mountHostPage, typeInto } from "./helpers/hostPage";

afterEach(() => {
	document.documentElement.innerHTML = "<head></head><body></body>";
});

const URL_OF = (id: string | number) => `https://app.codestitch.app/app/dashboard/stitches/${id}`;

function own(stitch: StitchData, over: Partial<OwnChoices> = {}): OwnChoices {
	return {
		keepNavJs: false,
		prioritizeFirstImage: false,
		ownRoutes: new Map(),
		socialChoices: new Map(),
		fallback: defaultFallbacks(stitch),
		...over,
	};
}

function page(id: string, prefs?: Record<string, unknown>) {
	const doc = mountHostPage(loadPage(id), { prefs });
	return { stitch: scrapeStitch(doc, URL_OF(id)), host: () => readHostSettings(doc) };
}

function compose(stitch: StitchData, host: HostSettings, over: Partial<OwnChoices> = {}, prefs: Prefs = DEFAULT_PREFS) {
	return composeOptions(stitch, prefs, host, own(stitch, over));
}

describe("mapImagesFolder", () => {
	const DEF = "src/assets/images/not-found";
	it.each([
		["/assets/images", DEF],
		["/assets/images/", DEF],
		["assets/images", DEF],
		["", DEF],
		["/assets/images/foo", "src/assets/images/foo"],
		["assets/x", "src/assets/x"],
		["/src/assets/x", "src/assets/x"],
		["\\assets\\img\\", "src/assets/img"],
	])("%s → %s", (folder, expected) => {
		expect(mapImagesFolder(folder, DEF)).toEqual({ assetsDir: expected });
	});

	it.each(["/public/img", "../x", "/assets/../../x", "images"])("rejects %s", (folder) => {
		const mapped = mapImagesFolder(folder, DEF);
		expect(mapped.assetsDir).toBe(DEF);
		expect(mapped.problem).toMatch(/not under src\/assets/);
	});
});

describe("naming and flavour helpers", () => {
	it("names a component the way CodeStitch's Get code does", () => {
		expect(codestitchDefaultFileName(loadFixture(FIXTURE_DIRS.notFound).html)).toBe("Not-found-2501");
		expect(codestitchDefaultFileName(loadFixture(FIXTURE_DIRS.nav).html)).toBe("Navigation");
		expect(codestitchDefaultFileName(loadFixture(FIXTURE_DIRS.heroMultiSection).html)).toBe("Hero-2274");
		expect(codestitchDefaultFileName("<p>no ids</p>")).toBe("Stitch");
	});

	it("falls back to a flavour the stitch has", () => {
		const stitch = { ...loadFixture(FIXTURE_DIRS.notFound), css: { SCSS: "a{}" } };
		expect(resolveFlavour("less", stitch)).toBe("scss");
		expect(resolveFlavour("scss", stitch)).toBe("scss");
	});
});

describe("composeOptions from CodeStitch's settings", () => {
	it("follows Get code on the real 2501 page", () => {
		const { stitch, host } = page("2501", { flavour: "less", images: "local" });
		const c = compose(stitch, host());
		expect(c.options).toMatchObject({
			cssFlavor: "less",
			darkMode: true,
			includeJs: false,
			componentName: "Not-found-2501",
			imagesMode: "assets",
			assetsDir: "src/assets/images/not-found",
			guessRoutes: false,
		});
		expect(c.options.linkMappings!.map((m) => m.route)).toEqual(["/return-to-home", "/view-properties"]);
		expect(c.ownRows).toEqual([]);
		expect(c.pairing).toBe("paired");
		expect(c.fallbacks.size).toBe(0);
		// Neither route ships with the kit; the note sits under CodeStitch's own row.
		expect(c.hostNotes.get(0)).toMatchObject({ kind: "note", text: expect.stringContaining("does not ship /return-to-home/") });
	});

	it("stands in for the dark checkbox CodeStitch wrongly disables on 2501", () => {
		const { stitch, host } = page("2501");
		const c = compose(stitch, host());
		expect(host().usable.darkStyles).toBe(false);
		expect(c.fallbacks.has("darkMode")).toBe(true);
		expect(c.options).toMatchObject({ cssFlavor: "css", darkMode: true });
	});

	it("stands in for Styles and File name under Shopify", () => {
		const { stitch, host } = page("2501", { flavour: "less" });
		click('#formats [data-id="shopify"]');
		const h = host();
		const c = compose(stitch, h, { fallback: { ...defaultFallbacks(stitch), fileName: "Shop-Hero" } });
		expect(c.fallbacks.has("flavour")).toBe(true);
		expect(c.fallbacks.has("fileName")).toBe(true);
		expect(c.options).toMatchObject({ cssFlavor: "less", componentName: "Shop-Hero" });
	});

	it("uses every fallback when CodeStitch's script never ran", () => {
		const doc = mountHostPage(loadPage("2501"), { render: false });
		const stitch = scrapeStitch(doc, URL_OF("2501"));
		const c = compose(stitch, readHostSettings(doc));
		expect(c.options).toMatchObject({
			cssFlavor: "less",
			darkMode: true,
			componentName: "Not-found-2501",
			imagesMode: "assets",
			assetsDir: "src/assets/images/not-found",
		});
		expect(c.ownRows.map((r) => r.suggestedRoute)).toEqual(["/return-to-home", "/view-properties"]);
		expect(c.options.linkMappings!.map((m) => m.route)).toEqual(["/return-to-home", "/view-properties"]);
		// A row cleared in the panel stays cleared.
		const cleared = compose(stitch, readHostSettings(doc), { ownRoutes: new Map([["link-0", ""]]) });
		expect(cleared.options.linkMappings![0]!.route).toBe("");
		expect([...c.fallbacks].sort()).toEqual(["assetsDir", "darkMode", "fileName", "flavour", "guessRoutes", "imagesMode"]);
	});

	it("turns every link into a TODO when Replace links is off", async () => {
		const { stitch, host } = page("2501");
		click("#replace-links");
		const c = compose(stitch, host());
		expect(c.options).toMatchObject({ linkMappings: [], guessRoutes: false });
		const result = await convert(stitch, { ...c.options, preflightWarnings: c.preflight });
		expect(result.files[0]!.contents.match(/TODO: set the destination/g)).toHaveLength(2);
	});

	it("leaves a field cleared in Get code as a TODO instead of guessing", async () => {
		const { stitch, host } = page("2501");
		typeInto("#link-1", "");
		const c = compose(stitch, host());
		const result = await convert(stitch, { ...c.options, preflightWarnings: c.preflight });
		expect(result.files[0]!.contents.match(/TODO: set the destination/g)).toHaveLength(1);
	});

	it("reports an unusable images folder as a Draft reason and uses the default", () => {
		const { stitch, host } = page("2501", { images: "local" });
		typeInto("#images-folder", "/public/img");
		const c = compose(stitch, host());
		expect(c.options.assetsDir).toBe("src/assets/images/not-found");
		expect(c.preflight).toEqual([
			expect.objectContaining({ severity: "draft", code: "images-folder-outside-assets" }),
		]);
	});

	it("falls back to a valid name when the typed one cannot be a file name", () => {
		const { stitch, host } = page("2501");
		typeInto("#file-name", "../escape");
		const c = compose(stitch, host());
		expect(c.options.componentName).toBe("NotFound-2501");
		expect(c.preflight[0]).toMatchObject({ severity: "draft", code: "host-file-name-unusable" });
	});

	it("keeps the nav script decision on the panel", () => {
		const { stitch, host } = page("757");
		const c = compose(stitch, host(), { keepNavJs: true });
		expect(c.duplicatesKitNav).toBe(true);
		expect(c.options).toMatchObject({ includeJs: true, keepKitNavScript: true });
		click("#include-js");
		expect(compose(stitch, host(), { keepNavJs: true }).options).toMatchObject({ includeJs: false, keepKitNavScript: false });
	});
});

describe("pairing links with CodeStitch's fields", () => {
	const html = [
		'<section id="links-1">',
		'<!-- <a href="">About</a> -->',
		'<a href="" class="cs-link">About</a>',
		'<a href="" class="cs-button"><span>Get</span><span>Started</span></a>',
		'<a href="#" class="cs-link">Hash</a>',
		"</section>",
	].join("\n");
	const pageWith = (content: string) =>
		mountHostPage(getCodePage({ id: 3001, codes: [{ typeName: "HTML", type: "html", content }, { typeName: "CSS", type: "css", content: "#links-1{}" }] }));

	it("pairs by position in CodeStitch's list, skipping commented-out anchors", () => {
		const doc = pageWith(html);
		// CodeStitch lists the commented About as link-0.
		expect([...doc.querySelectorAll("#link-rows label")].map((l) => l.textContent)).toEqual([
			"About",
			"About",
			"Get Started",
		]);
		typeInto("#link-0", "/commented");
		typeInto("#link-1", "/real-about");
		typeInto("#link-2", "/start");
		const stitch = scrapeStitch(doc, URL_OF(3001));
		const c = compose(stitch, readHostSettings(doc));
		const routes = Object.fromEntries(c.options.linkMappings!.map((m) => [m.text, m.route]));
		expect(routes["About"]).toBe("/real-about");
		// "GetStarted" here, "Get Started" there: position decides, not label.
		expect(c.options.linkMappings!.find((m) => m.originalHref === "" && m.text !== "About")!.route).toBe("/start");
		// The "#" link is not in CodeStitch's list, so the panel lists it.
		expect(c.ownRows.map((r) => r.text)).toEqual(["Hash"]);
	});

	it("lists every link in the panel when the counts do not line up", () => {
		const doc = pageWith(html.replace("<!-- <a", "<!-- <a").replace('<a href="" class="cs-link">About</a>', '<a href="" class="cs-link">About</a><a href>Bare</a>'));
		const stitch = scrapeStitch(doc, URL_OF(3001));
		const c = compose(stitch, readHostSettings(doc));
		expect(c.pairing).toBe("ambiguous");
		expect(c.ownRows.length).toBe(4);
		expect(c.preflight.map((w) => w.code)).toContain("host-links-unpaired");
	});
});

describe("social links", () => {
	const social = '<section id="soc-1"><a href="" aria-label="visit facebook profile"><img alt="facebook" src="https://csimg.nyc3.cdn.digitaloceanspaces.com/f.svg"></a><a href="">About</a></section>';
	const setup = () => {
		const doc = mountHostPage(getCodePage({ id: 3002, codes: [{ typeName: "HTML", type: "html", content: social }, { typeName: "CSS", type: "css", content: "#soc-1{}" }] }));
		return { doc, stitch: scrapeStitch(doc, URL_OF(3002)) };
	};

	it("offers the kit's business data as an opt-in, off by default", () => {
		const { doc, stitch } = setup();
		const c = compose(stitch, readHostSettings(doc));
		expect(c.hostNotes.get(0)).toEqual({
			kind: "choice",
			mappingId: "link-0",
			checked: false,
			text: "use BUSINESS.socials.facebook from Advanced Astro v4",
		});
		expect(c.options.linkMappings![0]!.route).toBeUndefined();
		expect(c.preflight.map((w) => w.code)).toContain("social-link-unset");

		const on = compose(stitch, readHostSettings(doc), { socialChoices: new Map([["link-0", true]]) });
		expect(on.options.linkMappings![0]!.route).toBe("{BUSINESS.socials.facebook}");
		expect(on.preflight.map((w) => w.code)).not.toContain("social-link-unset");
	});

	it("lets a typed destination win and voids the opt-in", () => {
		const { doc, stitch } = setup();
		typeInto("#link-0", "https://facebook.com/acme");
		const c = compose(stitch, readHostSettings(doc), { socialChoices: new Map([["link-0", true]]) });
		expect(c.options.linkMappings![0]!.route).toBe("https://facebook.com/acme");
		expect(c.hostNotes.has(0)).toBe(false);
		expect(c.overriddenSocials).toEqual(["link-0"]);
	});

	it("keeps a network home page a Draft placeholder when Get code's controls never rendered", async () => {
		const html = '<section id="soc-3003"><a href="" aria-label="visit twitter profile">twitter</a></section>';
		const doc = mountHostPage(
			getCodePage({ id: 3003, codes: [{ typeName: "HTML", type: "html", content: html }, { typeName: "CSS", type: "css", content: "#soc-3003{}" }] }),
			{ render: false },
		);
		const stitch = scrapeStitch(doc, URL_OF(3003));
		const c = compose(stitch, readHostSettings(doc), { fallback: { ...defaultFallbacks(stitch), imagesMode: "raw" } }, {
			...DEFAULT_PREFS,
			i18n: false,
			multilingual: false,
		});
		expect(c.options.linkMappings![0]).toMatchObject({ route: "https://twitter.com/", routeFromSuggestion: true });
		const result = await convert(stitch, { ...c.options, preflightWarnings: c.preflight });
		expect(result.readiness.state).toBe("draft");
		expect(result.warnings.map((w) => w.code)).toContain("social-link-placeholder");

		// Typed by hand, the same URL is a decision, not a placeholder.
		const typed = compose(stitch, readHostSettings(doc), {
			fallback: { ...defaultFallbacks(stitch), imagesMode: "raw" },
			ownRoutes: new Map([["link-0", "https://twitter.com/"]]),
		}, { ...DEFAULT_PREFS, i18n: false, multilingual: false });
		const typedResult = await convert(stitch, { ...typed.options, preflightWarnings: typed.preflight });
		expect(typedResult.warnings.map((w) => w.code)).not.toContain("social-link-placeholder");
	});

	it("does not offer what the kit has no entry for", () => {
		const { doc, stitch } = setup();
		const c = compose(stitch, readHostSettings(doc), {}, { ...DEFAULT_PREFS, kit: "decap" });
		const note = c.hostNotes.get(0);
		expect(note?.kind === "choice" ? note.text : "").not.toMatch(/undefined/);
	});
});

describe("change keys", () => {
	it("moves the options key only when the conversion would change", () => {
		const { stitch, host } = page("2501");
		const a = compose(stitch, host());
		expect(compose(stitch, host()).optionsKey).toBe(a.optionsKey);
		typeInto("#link-0", "/about");
		expect(compose(stitch, host()).optionsKey).not.toBe(a.optionsKey);
	});

	it("includes complete preflight messages, not just their codes", () => {
		const { stitch, host } = page("2501", { images: "local" });
		typeInto("#images-folder", "/public/a");
		const a = compose(stitch, host());
		typeInto("#images-folder", "/public/b");
		const b = compose(stitch, host());
		// Same fallback folder, same code, different message.
		expect(b.options.assetsDir).toBe(a.options.assetsDir);
		expect(b.optionsKey).not.toBe(a.optionsKey);
	});

	it("moves the options key when a suggested route is typed out unchanged", () => {
		// Same URL, different verdict: suggested is a Draft placeholder, typed is not.
		const html = '<section id="soc-3004"><a href="" aria-label="visit twitter profile">twitter</a></section>';
		const doc = mountHostPage(
			getCodePage({ id: 3004, codes: [{ typeName: "HTML", type: "html", content: html }, { typeName: "CSS", type: "css", content: "#soc-3004{}" }] }),
			{ render: false },
		);
		const stitch = scrapeStitch(doc, URL_OF(3004));
		const suggested = compose(stitch, readHostSettings(doc));
		const typed = compose(stitch, readHostSettings(doc), { ownRoutes: new Map([["link-0", "https://twitter.com/"]]) });
		expect(suggested.options.linkMappings![0]!.route).toBe(typed.options.linkMappings![0]!.route);
		expect(typed.optionsKey).not.toBe(suggested.optionsKey);
	});

	it("moves the layout key when images switch to the local folder", () => {
		const { stitch, host } = page("2501");
		const a = compose(stitch, host());
		click('#image-modes [data-id="local"]');
		expect(compose(stitch, host()).layoutKey).not.toBe(a.layoutKey);
	});
});
