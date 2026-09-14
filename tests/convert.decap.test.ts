import { describe, expect, it } from "vitest";
import { convert, defaultComponentName, inspectJs, inspectLinks } from "@core/convert";
import type { ConvertOptions } from "@core/types";
import { FIXTURE_DIRS, loadFixture } from "./helpers/loadFixture";

const BASE: ConvertOptions = {
	kit: "decap",
	cssFlavor: "less",
	darkMode: true,
	includeCoreStyles: false,
	includeJs: true,
	i18n: false,
	imagesMode: "raw",
};

const opts = (over: Partial<ConvertOptions> = {}): ConvertOptions => ({
	...BASE,
	...over,
});

describe("convert — Decap kit", () => {
	it("produces a component that follows the kit's file and block order", async () => {
		const stitch = loadFixture(FIXTURE_DIRS.notFound);
		const result = await convert(stitch, opts());
		const file = result.files[0]!;
		const astro = file.contents;

		expect(file.path).toBe("src/components/NotFound-2501/NotFound-2501.astro");

		// frontmatter -> banner -> markup -> style, the shape both kits use
		const fmEnd = astro.indexOf("---", 3);
		const bannerAt = astro.indexOf("<!-- =====");
		const sectionAt = astro.indexOf('<section id="not-found-2501">');
		const styleAt = astro.indexOf('<style lang="less">');
		expect(fmEnd).toBeGreaterThan(0);
		expect(bannerAt).toBeGreaterThan(fmEnd);
		expect(sectionAt).toBeGreaterThan(bannerAt);
		expect(styleAt).toBeGreaterThan(sectionAt);

		// The stitch's own id is preserved: the CSS is scoped to it.
		expect(astro).toContain("#not-found-2501");
		expect(astro).toContain("</style>");
	});

	it("names files the way CodeStitch components are usually named", async () => {
		const hero = loadFixture(FIXTURE_DIRS.heroMultiSection);
		const other = loadFixture(FIXTURE_DIRS.heroLanding);
		expect(defaultComponentName(hero)).toBe("Hero-2274");
		expect(defaultComponentName(other)).toBe("Hero-1946");
		expect(defaultComponentName(loadFixture(FIXTURE_DIRS.nav))).toBe(
			"Navigation-757",
		);
	});

	it("accepts any file name the user prefers", async () => {
		const stitch = loadFixture(FIXTURE_DIRS.notFound);
		for (const [name, expected] of [
			["SideBySide-1982", "src/components/SideBySide-1982/SideBySide-1982.astro"],
			["NotFound", "src/components/NotFound/NotFound.astro"],
			["hero_section_2", "src/components/hero_section_2/hero_section_2.astro"],
			// A typed extension is not doubled up.
			["Hero-1621.astro", "src/components/Hero-1621/Hero-1621.astro"],
		] as const) {
			const result = await convert(stitch, opts({ componentName: name }));
			expect(result.files[0]!.path, name).toBe(expected);
		}
	});

	it("imports a hyphenated file under a valid identifier", async () => {
		const stitch = loadFixture(FIXTURE_DIRS.notFound);
		const result = await convert(stitch, opts({ componentName: "SideBySide-1982" }));

		// `import SideBySide-1982 from ...` would not parse.
		expect(result.componentName).toBe("SideBySide-1982");
		expect(result.componentIdentifier).toBe("SideBySide1982");
	});

	it("rejects a file name that would escape the components folder", async () => {
		const stitch = loadFixture(FIXTURE_DIRS.notFound);
		for (const name of ["../../evil", "a/b", "../x", ".hidden"]) {
			await expect(
				convert(stitch, opts({ componentName: name })),
				name,
			).rejects.toThrow(/cannot be used as a file name|cannot contain/);
		}
	});

	it("carries the dark-mode block into the scoped style block", async () => {
		const stitch = loadFixture(FIXTURE_DIRS.notFound);
		const dark = await convert(stitch, opts({ darkMode: true }));
		const light = await convert(stitch, opts({ darkMode: false }));

		expect(dark.files[0]!.contents).toContain("body.dark-mode");
		expect(light.files[0]!.contents).not.toContain("body.dark-mode");
	});

	it("wraps stitch JS for client-side navigation", async () => {
		const stitch = loadFixture(FIXTURE_DIRS.faq);
		const result = await convert(stitch, opts());
		const astro = result.files[0]!.contents;

		expect(astro).toContain("<script>");
		expect(astro).toContain('document.addEventListener("astro:page-load"');
		expect(astro).toContain("cs-faq-item");
		// The script always comes after the styles.
		expect(astro.indexOf("<script>")).toBeGreaterThan(astro.indexOf("</style>"));
	});

	it("leaves out a nav stitch's script because the kit already runs one", async () => {
		const stitch = loadFixture(FIXTURE_DIRS.nav);
		const result = await convert(stitch, opts());

		expect(result.files[0]!.contents).not.toContain("<script>");
		expect(result.warnings.map((w) => w.code)).toContain("nav-js-suppressed");
	});

	it("keeps the nav script on request, as a Draft that says why", async () => {
		const stitch = loadFixture(FIXTURE_DIRS.nav);
		const result = await convert(stitch, opts({ keepKitNavScript: true }));

		expect(result.files[0]!.contents).toContain("<script>");
		expect(result.readiness.state).toBe("draft");
		expect(result.readiness.reasons.some((r) => r.includes("nav.js"))).toBe(true);
		expect(result.warnings.map((w) => w.code)).not.toContain("nav-js-suppressed");
	});

	it("reports which stitches ship a script the kit already runs", () => {
		for (const kit of ["decap", "i18n"] as const) {
			expect(inspectJs(loadFixture(FIXTURE_DIRS.nav), kit)).toEqual({
				hasJs: true,
				duplicatesKitNav: true,
			});
		}
		expect(inspectJs(loadFixture(FIXTURE_DIRS.faq), "decap")).toEqual({
			hasJs: true,
			duplicatesKitNav: false,
		});
		expect(inspectJs(loadFixture(FIXTURE_DIRS.notFound), "decap")).toEqual({
			hasJs: false,
			duplicatesKitNav: false,
		});
	});

	it("keeps multiple sections together and says so", async () => {
		const stitch = loadFixture(FIXTURE_DIRS.heroMultiSection);
		const result = await convert(stitch, opts());
		const astro = result.files[0]!.contents;

		expect(astro).toContain('id="hero-2274"');
		expect(astro).toContain('id="Hservices-2274"');
		expect(result.warnings.find((w) => w.code === "multi-section")?.severity).toBe(
			"info",
		);
	});

	it("is Ready with raw images, resolved links and no core styles", async () => {
		const stitch = loadFixture(FIXTURE_DIRS.notFound);
		const links = inspectLinks(stitch);
		const result = await convert(
			stitch,
			opts({ linkMappings: links.map((l) => ({ ...l, route: "/" })) }),
		);

		expect(result.readiness).toEqual({ state: "ready", reasons: [] });
		expect(result.files[0]!.contents).toContain(" * Ready:");
	});

	it("reads routes off the link text so they need not be typed", async () => {
		const stitch = loadFixture(FIXTURE_DIRS.notFound);
		const result = await convert(stitch, opts());
		const astro = result.files[0]!.contents;

		// "Return To Home" / "View Properties" become usable routes.
		expect(astro).toContain('href="/return-to-home/"');
		expect(astro).toContain('href="/view-properties/"');
		expect(astro).not.toContain("TODO: set the destination");
		expect(result.warnings.map((w) => w.code)).toContain("routes-guessed");
	});

	it("leaves links as TODO when guessing is switched off", async () => {
		const stitch = loadFixture(FIXTURE_DIRS.notFound);
		const links = inspectLinks(stitch);
		expect(links.length).toBeGreaterThan(0);

		const result = await convert(stitch, opts({ guessRoutes: false }));
		expect(result.readiness.state).toBe("draft");
		expect(result.readiness.reasons.join(" ")).toMatch(/no destination yet/);
		expect(result.files[0]!.contents).toContain("TODO: set the destination");
		expect(result.files[0]!.contents).toContain('href="#"');
	});

	it("prefers a typed route over the derived one", async () => {
		const stitch = loadFixture(FIXTURE_DIRS.notFound);
		const links = inspectLinks(stitch).map((l) => ({ ...l, route: "/contact" }));
		const astro = (await convert(stitch, opts({ linkMappings: links }))).files[0]!
			.contents;

		expect(astro).toContain('href="/contact/"');
		expect(astro).not.toContain("/return-to-home");
	});

	it("marks SCSS as Draft because the kit ships no sass", async () => {
		const stitch = loadFixture(FIXTURE_DIRS.notFound);
		const result = await convert(stitch, opts({ cssFlavor: "scss" }));

		expect(result.files[0]!.contents).toContain('<style lang="scss">');
		expect(result.readiness.reasons.join(" ")).toMatch(/npm i -D sass/);
	});

	it("writes core styles with install instructions rather than an orphan file", async () => {
		const stitch = loadFixture(FIXTURE_DIRS.notFound);
		const result = await convert(stitch, opts({ includeCoreStyles: true }));

		const paths = result.files.map((f) => f.path);
		expect(paths).toContain("src/styles/codestitch-core.less");
		expect(paths).toContain("INSTALL.md");
		expect(result.readiness.reasons.join(" ")).toMatch(/nothing imports them yet/);
	});

	it("throws a helpful error when the requested flavour is missing", async () => {
		const stitch = loadFixture(FIXTURE_DIRS.notFound);
		const stripped = { ...stitch, css: { LESS: stitch.css.LESS! } };
		await expect(
			convert(stripped, opts({ darkMode: true })),
		).rejects.toThrow(/no LESS Dark styles/);
	});
});
