import { describe, expect, it } from "vitest";
import { convert } from "@core/convert";
import type { ConvertOptions, FetchAsset } from "@core/types";
import { FIXTURE_DIRS, loadFixture } from "./helpers/loadFixture";

const GIF_1X1 = "R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";
const TINY_SVG =
	"PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAxNiAxNiI+PHBhdGggZD0iTTIgOGgxMiIvPjwvc3ZnPg==";

const fetchAsset: FetchAsset = async (url) => ({
	base64: url.endsWith(".svg") ? TINY_SVG : GIF_1X1,
	contentType: url.endsWith(".svg") ? "image/svg+xml" : "image/gif",
	originalUrl: url,
});

const options = (over: Partial<ConvertOptions> = {}): ConvertOptions => ({
	kit: "decap",
	cssFlavor: "less",
	darkMode: false,
	includeCoreStyles: false,
	includeJs: false,
	i18n: false,
	imagesMode: "assets",
	...over,
});

function stitch(html: string, css = "#hero-1 { color: red; }") {
	const base = loadFixture(FIXTURE_DIRS.notFound);
	return { ...base, html, css: { LESS: css } };
}

describe("image best practices", () => {
	it("prioritizes exactly the first eligible raster candidate in DOM order", async () => {
		const cdn = "https://csimg.nyc3.cdn.digitaloceanspaces.com/Images/";
		const result = await convert(
			stitch(`<section id="hero-1">
				<img src="${cdn}icon.svg" alt="icon" aria-hidden="true">
				<picture class="first-picture">
					<source srcset="${cdn}first.jpg">
					<img loading="eager" decoding="sync" fetchpriority="low" src="${cdn}first.jpg" alt="first" width="10" height="10">
				</picture>
				<img src="${cdn}later.jpg" alt="later">
			</section>`),
			options({ prioritizeFirstImage: true }),
			fetchAsset,
		);
		const astro = result.files[0]!.contents;

		expect(astro.match(/\bpriority\b/g)?.length).toBe(1);
		expect(astro).toContain("<Picture");
		expect(astro).toContain("later");
		expect(astro).not.toContain('loading="lazy"');
		expect(astro).not.toContain('loading="eager"');
		expect(astro).not.toContain('decoding="sync"');
		expect(astro).not.toContain('decoding="async"');
		expect(astro).not.toContain('fetchpriority="low"');
	});

	it("does not promote a later image when the selected download fails", async () => {
		const cdn = "https://csimg.nyc3.cdn.digitaloceanspaces.com/Images/";
		const failing: FetchAsset = async (url) =>
			url.endsWith("first.jpg") ? undefined : fetchAsset(url);
		const result = await convert(
			stitch(`<section id="hero-1">
				<img src="${cdn}first.jpg" alt="first">
				<img src="${cdn}later.jpg" alt="later">
			</section>`),
			options({ prioritizeFirstImage: true }),
			failing,
		);
		const astro = result.files[0]!.contents;

		expect(astro).toContain(`${cdn}first.jpg`);
		expect(astro).not.toContain("priority");
	});

	it("keeps CSPicture lazy and explains why the first image was not promoted", async () => {
		const cdn = "https://csimg.nyc3.cdn.digitaloceanspaces.com/Images/";
		const result = await convert(
			stitch(`<section id="hero-1">
				<picture class="art-directed">
					<source media="(max-width: 600px)" srcset="${cdn}mobile.jpg">
					<source media="(min-width: 601px)" srcset="${cdn}desktop.jpg">
					<img src="${cdn}fallback.jpg" alt="hero">
				</picture>
			</section>`),
			options({ kit: "decap", prioritizeFirstImage: true }),
			fetchAsset,
		);
		const astro = result.files[0]!.contents;

		expect(astro).toContain("<CSPicture");
		expect(astro).toContain("<!-- Note:");
		expect(astro).toContain("hard-codes lazy loading");
		expect(astro).not.toContain("TODO");
		expect(result.warnings.find((w) => w.code === "cspicture-priority-limited")?.severity).toBe("info");
	});

	it("preserves safe attributes and serializes picture attributes as an object", async () => {
		const cdn = "https://csimg.nyc3.cdn.digitaloceanspaces.com/Images/";
		const result = await convert(
			stitch(`<section id="hero-1">
				<picture id="picture-id" class="cs-picture" style='--quoted: "yes";' data-track='a"b'>
					<img id="image-id" class="photo" style='object-position: "center";' title="Photo" data-kind="hero" referrerpolicy="no-referrer" crossorigin="anonymous" fetchpriority="low" loading="eager" decoding="sync" srcset="${cdn}a-2.jpg" sizes="100vw" src="${cdn}a.jpg" alt="photo" width="100" height="80" onclick="bad()">
				</picture>
			</section>`),
			options(),
			fetchAsset,
		);
		const astro = result.files[0]!.contents;

		expect(astro).toContain('pictureAttributes={{ id: "picture-id", class: "cs-picture", style: "--quoted: \\"yes\\";", "data-track": "a\\"b" }}');
		expect(astro).toContain('id="image-id"');
		expect(astro).toContain('referrerpolicy="no-referrer"');
		expect(astro).toContain('crossorigin="anonymous"');
		expect(astro).toContain('fetchpriority="low"');
		expect(astro).toContain('loading="eager"');
		expect(astro).toContain('decoding="sync"');
		expect(astro).not.toContain("srcset=\"");
		expect(astro).not.toContain("sizes=\"");
		expect(astro).not.toContain("onclick");
		expect(result.warnings.map((w) => w.code)).toContain("responsive-attrs-removed");
	});

	it("uses SVG alt/title precedence without forwarding raster network attributes", async () => {
		const cdn = "https://csimg.nyc3.cdn.digitaloceanspaces.com/Images/";
		const result = await convert(
			stitch(`<section id="hero-1">
				<img src="${cdn}icon.svg" alt="announced label" title="old label" width="16" fetchpriority="high" onload="bad()">
			</section>`),
			options(),
			fetchAsset,
		);
		const astro = result.files[0]!.contents;

		expect(astro).toContain('title="announced label"');
		expect(astro).not.toContain("old label");
		expect(astro).not.toContain("fetchpriority");
		expect(astro).not.toContain("onload");
		expect(astro).not.toContain('title="arrow"');
	});

	it("adds the missing-alt diagnostic to a picture fallback", async () => {
		const cdn = "https://csimg.nyc3.cdn.digitaloceanspaces.com/Images/";
		const result = await convert(
			stitch(`<section id="hero-1">
				<picture class="photo">
					<source srcset="${cdn}picture.jpg">
					<img src="${cdn}picture.jpg" width="100" height="80">
				</picture>
			</section>`),
			options(),
			fetchAsset,
		);
		const astro = result.files[0]!.contents;

		expect(astro).toMatch(/TODO: add descriptive alt text to this image[\s\S]*<Picture/);
		expect(result.warnings.filter((w) => w.code === "missing-alt")).toHaveLength(1);
	});

	it("does not warn for a normal single-URL picture source", async () => {
		const cdn = "https://csimg.nyc3.cdn.digitaloceanspaces.com/Images/";
		const result = await convert(
			stitch(`<section id="hero-1">
				<picture class="photo">
					<source srcset="${cdn}picture.jpg">
					<img src="${cdn}picture.jpg" alt="photo">
				</picture>
			</section>`),
			options(),
			fetchAsset,
		);

		expect(result.warnings.map((w) => w.code)).not.toContain("responsive-attrs-removed");
	});

	it("diagnoses missing alt while accepting explicit empty and decorative images", async () => {
		const cdn = "https://csimg.nyc3.cdn.digitaloceanspaces.com/Images/";
		const result = await convert(
			stitch(`<section id="hero-1">
				<img src="${cdn}missing.jpg">
				<img src="${cdn}empty.jpg" alt="">
				<img src="${cdn}decorative.jpg" aria-hidden="true">
			</section>`),
			options(),
			fetchAsset,
		);
		const astro = result.files[0]!.contents;

		expect(astro).toContain("TODO: add descriptive alt text");
		expect(result.warnings.filter((w) => w.code === "missing-alt")).toHaveLength(1);
		expect(result.warnings.find((w) => w.code === "missing-alt")?.message).toContain("1 image is");
	});

	it("uses format-neutral getImage for raster CSS backgrounds only", async () => {
		const cdn = "https://csimg.nyc3.cdn.digitaloceanspaces.com/Images/";
		const result = await convert(
			stitch(
				`<section id="hero-1"><img src="${cdn}hero.jpg" alt="hero"></section>`,
				`#hero-1 { background-image: url("${cdn}background.gif"); mask-image: url("${cdn}mask.svg"); content: url("${cdn}odd.bmp"); }`,
			),
			options(),
			fetchAsset,
		);
		const astro = result.files[0]!.contents;

		expect(astro).toContain('import { Image, getImage } from "astro:assets"');
		expect(astro).toContain("await getImage({ src: background });");
		expect(astro).not.toContain("format:");
		expect(astro).toContain('url("${backgroundBgImage.src}")');
		expect(astro).toContain('url("${mask.src}")');
		expect(astro).toContain('url("${odd.src}")');
	});
});
