import { describe, expect, it } from "vitest";

// The profile builder is an executable Node script, so it intentionally has no
// generated TypeScript declaration file. Its static parsing helpers are still
// imported directly to keep the config matrix unit-testable.
import {
	collectNavRoutes,
	collectOptionalRoutes,
	collectPageRoutes,
	discoverImageLayout,
	parseImageLayoutConfig,
	// @ts-expect-error No declaration file is needed for this test-only script import.
} from "../scripts/build-kit-profiles.mjs";
import { execFileSync } from "node:child_process";

interface TreeEntry {
	relativePath: string;
}

const tree = (...paths: string[]): TreeEntry[] =>
	paths.map((relativePath) => ({ relativePath }));

describe("kit image config discovery", () => {
	it("searches mjs, then ts, then js and parses a missing layout as null", async () => {
		const seen: string[] = [];
		const layout = await discoverImageLayout(async (path: string) => {
			seen.push(path);
			if (path === "astro.config.ts") return "export default defineConfig({});";
			return undefined;
		});

		expect(seen).toEqual(["astro.config.mjs", "astro.config.ts"]);
		expect(layout).toBe(null);
	});

	it("accepts every supported literal layout", () => {
		for (const layout of ["constrained", "full-width", "fixed", "none"] as const) {
			expect(
				parseImageLayoutConfig(
					`export default defineConfig({ image: { layout: "${layout}" } });`,
				),
			).toBe(layout);
		}
	});

	it("fails when no config is reachable", async () => {
		await expect(discoverImageLayout(async () => undefined)).rejects.toThrow(
			/astro\.config\.mjs.*astro\.config\.ts.*astro\.config\.js/,
		);
	});

	it("fails on dynamic, invalid, and unparseable layout values", () => {
		expect(() =>
			parseImageLayoutConfig(
				`const layout = "fixed"; export default defineConfig({ image: { layout } });`,
			),
		).toThrow(/dynamic|literal/);
		expect(() =>
			parseImageLayoutConfig(
				`export default defineConfig({ image: { layout: "responsive" } });`,
			),
		).toThrow(/supported string literal|constrained/);
		expect(() =>
			parseImageLayoutConfig("export default defineConfig({ image: { layout: });"),
		).toThrow(/parse/);
	});
});

describe("pages a link may point at", () => {
	it("walks nested folders and drops the default locale's prefix", () => {
		expect(
			collectPageRoutes(
				tree(
					"index.astro",
					"about.astro",
					"projects/project-1.astro",
					"fr/index.astro",
					"fr/a-propos.astro",
				),
				null,
			),
		).toEqual(["/", "/about", "/fr", "/fr/a-propos", "/projects/project-1"]);

		// With prefixDefaultLocale the English pages move into their own folder,
		// and their routes are still written without it.
		expect(collectPageRoutes(tree("en/index.astro", "en/about.astro"), "en")).toEqual([
			"/",
			"/about",
		]);
	});

	it("keeps a rest route's own folder and drops everything else dynamic", () => {
		expect(
			collectPageRoutes(
				tree(
					"blog/[...page].astro",
					"blog/[...slug].astro",
					"projects/[id].astro",
					"[...catchall].astro",
					"_template.astro",
					"fr/_template.astro",
				),
				null,
			),
			// A rest parameter also matches zero segments, so /blog is real.
			// A required parameter is a shape, and a root catch-all is not a page.
		).toEqual(["/blog"]);
	});
});

describe("translated routes", () => {
	const navData = [
		{ key: "home", urls: { en: "/", fr: "/" }, children: [] },
		{ key: "about", urls: { en: "/about", fr: "/a-propos" }, children: [] },
		{
			key: "projects",
			urls: { en: "/projects", fr: "/projets" },
			children: [
				{ key: "p1", urls: { en: "/projects/project-1", fr: "/projets/projet-1" } },
			],
		},
	];

	it("indexes every locale's path by the default locale's, including children", () => {
		const routes = collectNavRoutes(navData, "en");
		expect(routes["fr"]).toEqual([
			{ defaultPath: "/", localizedPath: "/" },
			{ defaultPath: "/about", localizedPath: "/a-propos" },
			{ defaultPath: "/projects", localizedPath: "/projets" },
			{ defaultPath: "/projects/project-1", localizedPath: "/projets/projet-1" },
		]);
	});
});

describe("routes that come with a removable feature", () => {
	// Read from the kit's own removal scripts, so the claim stays true when
	// the kit changes what those scripts delete.
	const removeDemo = `
		pages: [
			join(root, "src", "pages", "about.astro"),
			join(root, "src", "pages", "projects"),
			join(root, "src", "pages", "fr", "a-propos.astro"),
		],
	`;
	const removeDecap = `const adminPagePath = join(root, "src", "pages", "admin.astro");
		const dir = i18n ? x : join(root, "src", "pages", "blog");`;

	it("marks a deleted page, everything under a deleted folder, and both locales", () => {
		const routes = [
			"/",
			"/about",
			"/fr/a-propos",
			"/projects/project-1",
			"/projects/project-2",
			"/admin",
			"/blog",
			"/contact",
		];
		expect(collectOptionalRoutes([["demo", removeDemo], ["CMS", removeDecap]], routes, ["en", "fr"])).toEqual({
			"/about": "demo",
			"/admin": "CMS",
			"/blog": "CMS",
			"/fr/a-propos": "demo",
			"/projects/project-1": "demo",
			"/projects/project-2": "demo",
		});
	});

	it("claims nothing when the scripts are missing", () => {
		expect(collectOptionalRoutes([["demo", undefined]], ["/about"], ["en"])).toEqual({});
	});
});

describe("re-pinning a profile", () => {
	const run = (args: string[]) => {
		try {
			execFileSync("node", ["scripts/build-kit-profiles.mjs", ...args], {
				encoding: "utf8",
				stdio: "pipe",
			});
			return "";
		} catch (error) {
			return String((error as { stderr?: string }).stderr ?? "");
		}
	};

	it("refuses to refresh without naming exactly one target", () => {
		// Refreshing every kit at once is how the legacy target would silently
		// be moved onto the current release.
		expect(run(["--latest"])).toMatch(/exactly one target/);
		expect(run(["--latest", "nonsense"])).toMatch(/exactly one target/);
		expect(run(["--latest", "advanced-v4", "--latest", "advanced-i18n"])).toMatch(
			/one profile at a time/,
		);
	});
});
