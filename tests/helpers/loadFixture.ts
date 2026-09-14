import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { CssVariant, StitchData } from "@core/types";

// Resolved from the project root: under happy-dom, import.meta.url is not a file URL.
const FIXTURES = join(process.cwd(), "tests", "fixtures");

export interface FixtureMeta {
	id: string;
	url: string;
	sectionIds: string[];
	heading: string | null;
}

const VARIANT_FILES: Record<string, CssVariant> = {
	"css-CSS.txt": "CSS",
	"css-CSS-Dark.txt": "CSS Dark",
	"css-LESS.txt": "LESS",
	"css-LESS-Dark.txt": "LESS Dark",
	"css-SCSS.txt": "SCSS",
	"css-SCSS-Dark.txt": "SCSS Dark",
};

/** Loads a captured stitch fixture as the StitchData the scraper would produce. */
export function loadFixture(dirName: string): StitchData {
	const dir = join(FIXTURES, dirName);
	const read = (f: string) => readFileSync(join(dir, f), "utf8");
	const meta = JSON.parse(read("meta.json")) as FixtureMeta;

	const css: Partial<Record<CssVariant, string>> = {};
	const coreStyles: Partial<Record<"CSS" | "LESS" | "SCSS", string>> = {};

	for (const file of readdirSync(dir)) {
		const variant = VARIANT_FILES[file];
		if (variant) css[variant] = read(file);
		const core = /^core-styles-(CSS|LESS|SCSS)\.txt$/.exec(file)?.[1];
		if (core) coreStyles[core as "CSS" | "LESS" | "SCSS"] = read(file);
	}

	return {
		id: meta.id,
		url: meta.url,
		html: read("html.html"),
		js: existsSync(join(dir, "js.js")) ? read("js.js") : undefined,
		css,
		coreStyles,
		categoryHeading: meta.heading ?? undefined,
	};
}

export function fixtureMeta(dirName: string): FixtureMeta {
	return JSON.parse(
		readFileSync(join(FIXTURES, dirName, "meta.json"), "utf8"),
	) as FixtureMeta;
}

/**
 * Full saved stitch page, for scraper tests.
 *
 * Scripts, iframes and external stylesheets are stripped: happy-dom would
 * otherwise try to fetch analytics and embedded maps, and the resulting network
 * exceptions bury genuine failures in the test output. None of them affect the
 * DOM the scraper reads.
 */
export function loadPage(stitchId: string): string {
	return readFileSync(join(FIXTURES, "pages", `stitch-${stitchId}.html`), "utf8")
		.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "")
		.replace(/<iframe\b[^>]*>[\s\S]*?<\/iframe>/gi, "")
		.replace(/<iframe\b[^>]*\/?>/gi, "")
		.replace(/<link\b[^>]*rel=["']?stylesheet["']?[^>]*>/gi, "");
}

export const FIXTURE_DIRS = {
	notFound: "stitch-not-found-2501",
	faq: "stitch-faq-1741",
	heroMultiSection: "stitch-hero-2274",
	heroLanding: "stitch-hero-1946",
	nav: "stitch-nav-757",
	contact: "stitch-contact-2320",
} as const;
