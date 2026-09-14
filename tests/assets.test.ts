import { describe, expect, it } from "vitest";
import { componentSourceFor, convert, inspectLinks } from "@core/convert";
import { readinessFor } from "@core/readiness";
import type { ConvertOptions, FetchAsset } from "@core/types";
import { FIXTURE_DIRS, loadFixture } from "./helpers/loadFixture";

const GIF_1X1 = "R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";
const TINY_SVG =
	"PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAxNiAxNiI+PHBhdGggZD0iTTIgOGgxMiIvPjwvc3ZnPg==";

const ok: FetchAsset = async (url) => {
	const isSvg = new URL(url).pathname.toLowerCase().endsWith(".svg");
	return {
		base64: isSvg ? TINY_SVG : GIF_1X1,
		contentType: isSvg ? "image/svg+xml" : "image/gif",
		originalUrl: url,
		byteLength: 43,
	};
};

const options = (over: Partial<ConvertOptions> = {}): ConvertOptions => ({
	kit: "decap",
	cssFlavor: "less",
	darkMode: true,
	includeCoreStyles: false,
	includeJs: true,
	i18n: false,
	imagesMode: "assets",
	...over,
});

/** Every import specifier the component's frontmatter declares. */
function importSpecifiers(astro: string): string[] {
	return [...astro.matchAll(/^import\s+\S+\s+from\s+"([^"]+)"/gm)].map((m) => m[1]!);
}

describe("assets mode", () => {
	it("bundles a file for every local import it emits", async () => {
		const stitch = loadFixture(FIXTURE_DIRS.faq);
		const result = await convert(stitch, options(), ok);
		const astro = result.files[0]!.contents;
		const shipped = new Set(result.files.map((f) => f.path));

		for (const specifier of importSpecifiers(astro)) {
			if (!specifier.startsWith("@assets/")) continue;
			expect(
				shipped.has(specifier.replace("@assets/", "src/assets/")),
				`${specifier} is imported but not bundled`,
			).toBe(true);
		}
	});

	it("never emits a remote URL as an import specifier", async () => {
		// A failed download must leave the CDN markup alone, not produce an
		// import that cannot possibly resolve.
		const stitch = loadFixture(FIXTURE_DIRS.faq);
		const failing: FetchAsset = async () => undefined;
		const result = await convert(stitch, options(), failing);
		const astro = result.files[0]!.contents;

		for (const specifier of importSpecifiers(astro)) {
			expect(specifier).not.toMatch(/^https?:/);
		}
		// The original markup survives so the component still renders.
		expect(astro).toContain("digitaloceanspaces.com");
		expect(result.readiness.state).toBe("draft");
		expect(result.readiness.reasons.join(" ")).toMatch(/could not be downloaded|Could not download/i);
	});

	it("passes the remaining budget down and stops when it runs out", async () => {
		const stitch = loadFixture(FIXTURE_DIRS.faq);
		const budgets: Array<number | undefined> = [];
		const huge: FetchAsset = async (url, maxBytes) => {
			budgets.push(maxBytes);
			return {
				base64: GIF_1X1,
				contentType: "image/gif",
				originalUrl: url,
				// Claims to be bigger than the whole conversion budget.
				byteLength: 60 * 1024 * 1024,
			};
		};
		const result = await convert(stitch, options(), huge);

		expect(budgets[0]).toBe(50 * 1024 * 1024);
		// An asset that would overshoot is refused, not counted.
		expect(result.readiness.reasons.join(" ")).toMatch(/50 MB/);
		expect(result.files.filter((f) => f.encoding === "base64")).toHaveLength(0);
	});

	it("routes SVGs through astro-icon rather than astro:assets", async () => {
		// astro:assets refuses SVG sources, so an <Image> would fail the build.
		const stitch = loadFixture(FIXTURE_DIRS.heroMultiSection);
		const result = await convert(stitch, options(), ok);
		const astro = result.files[0]!.contents;

		expect(astro).toContain('from "astro-icon/components"');
		for (const specifier of importSpecifiers(astro)) {
			expect(specifier.endsWith(".svg")).toBe(false);
		}
		expect(result.files.some((f) => f.path.startsWith("src/icons/"))).toBe(true);
	});
});

describe("where images are written", () => {
	it("defaults to a folder named after the stitch, not a tool-specific one", async () => {
		const stitch = loadFixture(FIXTURE_DIRS.faq);
		const result = await convert(stitch, options(), ok);

		const images = result.files.filter((f) =>
			f.path.startsWith("src/assets/images/"),
		);
		expect(images.length).toBeGreaterThan(0);
		for (const image of images) {
			expect(image.path.startsWith("src/assets/images/faq/")).toBe(true);
		}
		expect(result.files[0]!.contents).toContain('from "@assets/images/faq/');
		expect(result.files[0]!.contents).not.toContain("codestitch/");
	});

	it("writes images wherever the project keeps them", async () => {
		const stitch = loadFixture(FIXTURE_DIRS.faq);
		const result = await convert(
			stitch,
			options({ assetsDir: "src/assets/images/services" }),
			ok,
		);

		for (const file of result.files.slice(1)) {
			if (file.encoding !== "base64") continue;
			expect(file.path.startsWith("src/assets/images/services/")).toBe(true);
		}
		// The import specifier follows the folder.
		expect(result.files[0]!.contents).toContain('from "@assets/images/services/');
	});

	it("accepts a nested folder and matching alias", async () => {
		const stitch = loadFixture(FIXTURE_DIRS.faq);
		const result = await convert(
			stitch,
			options({ assetsDir: "src/assets/img/home/faq" }),
			ok,
		);
		expect(result.files[0]!.contents).toContain('from "@assets/img/home/faq/');
		expect(
			result.files.some((f) => f.path.startsWith("src/assets/img/home/faq/")),
		).toBe(true);
	});

	it("refuses a folder the @assets alias cannot reach", async () => {
		const stitch = loadFixture(FIXTURE_DIRS.faq);
		for (const dir of ["public/images", "src/images", "../outside", "src/assets/../../x"]) {
			await expect(
				convert(stitch, options({ assetsDir: dir }), ok),
				dir,
			).rejects.toThrow(/under src\/assets|not a valid folder|not safe/);
		}
	});
});

describe("srcset handling", () => {
	it("reports renditions it had to drop", async () => {
		const stitch = loadFixture(FIXTURE_DIRS.notFound);
		const complex = {
			...stitch,
			html: `<section id="hero-1">
				<picture class="cs-picture">
					<source media="(max-width: 600px)" srcset="https://csimg.nyc3.cdn.digitaloceanspaces.com/a.jpg 1x, https://csimg.nyc3.cdn.digitaloceanspaces.com/a2.jpg 2x">
					<img src="https://csimg.nyc3.cdn.digitaloceanspaces.com/a.jpg" alt="x" width="10" height="10">
				</picture>
			</section>`,
		};
		const result = await convert(complex, options(), ok);
		expect(result.readiness.reasons.join(" ")).toMatch(/several renditions/);
	});

	it("does not treat a format-switching picture as art direction", async () => {
		const stitch = loadFixture(FIXTURE_DIRS.notFound);
		const formats = {
			...stitch,
			html: `<section id="hero-1">
				<picture class="cs-picture">
					<source type="image/webp" srcset="https://csimg.nyc3.cdn.digitaloceanspaces.com/a.webp">
					<source type="image/jpeg" srcset="https://csimg.nyc3.cdn.digitaloceanspaces.com/b.jpg">
					<img src="https://csimg.nyc3.cdn.digitaloceanspaces.com/b.jpg" alt="x" width="10" height="10">
				</picture>
			</section>`,
		};
		const result = await convert(formats, options({ kit: "decap" }), ok);
		expect(result.files[0]!.contents).not.toContain("<CSPicture");
		expect(result.readiness.reasons.join(" ")).toMatch(/several renditions/);
	});
});

describe("readiness by delivery", () => {
	it("marks a single-file delivery Draft when companion files exist", async () => {
		const stitch = loadFixture(FIXTURE_DIRS.faq);
		const links = inspectLinks(stitch).map((l) => ({ ...l, route: "/about" }));
		const result = await convert(stitch, options({ linkMappings: links }), ok);

		// The full set is fine…
		expect(result.files.length).toBeGreaterThan(1);
		expect(readinessFor(result, "zip").state).toBe("ready");

		// …but the .astro on its own imports files the user would not have.
		const single = readinessFor(result, "component-only");
		expect(single.state).toBe("draft");
		expect(single.reasons[0]).toMatch(/Download ZIP/);
	});

	it("stamps the delivery's own verdict into the file the user receives", async () => {
		const stitch = loadFixture(FIXTURE_DIRS.faq);
		const links = inspectLinks(stitch).map((l) => ({ ...l, route: "/about" }));
		const result = await convert(stitch, options({ linkMappings: links }), ok);

		// The ZIP carries every file, so its copy keeps the Ready header.
		const zipSource = componentSourceFor(result, "zip");
		expect(zipSource).toContain(" * Ready: builds as-is");
		expect(zipSource).toBe(result.files[0]!.contents);

		// The lone .astro must not claim to build: its imports are missing.
		const single = componentSourceFor(result, "component-only");
		expect(single).not.toContain("Ready: builds as-is");
		expect(single).toContain(" * Draft — needs attention before shipping:");
		expect(single).toContain("Download ZIP");

		// Only the verdict changes; the component itself is untouched.
		const body = (src: string) => src.slice(src.indexOf("---", 3));
		expect(body(single)).toBe(body(zipSource));
	});

	it("keeps existing Draft reasons when restamping", async () => {
		const stitch = loadFixture(FIXTURE_DIRS.faq);
		// i18n adds an untranslated-locale reason of its own.
		const result = await convert(
			stitch,
			options({ kit: "i18n", i18n: true }),
			ok,
		);
		const single = componentSourceFor(result, "component-only");

		expect(single).toContain("Download ZIP");
		expect(single).toContain("translate it before this goes live");
	});

	it("leaves a single-file delivery Ready when there is nothing else to ship", async () => {
		const stitch = loadFixture(FIXTURE_DIRS.notFound);
		const links = inspectLinks(stitch).map((l) => ({ ...l, route: "/about" }));
		const result = await convert(
			stitch,
			options({ imagesMode: "raw", linkMappings: links }),
		);

		expect(result.files).toHaveLength(1);
		expect(readinessFor(result, "component-only")).toEqual(result.readiness);
		// Nothing to restamp, so the source is handed over unchanged.
		expect(componentSourceFor(result, "component-only")).toBe(
			result.files[0]!.contents,
		);
	});
});
