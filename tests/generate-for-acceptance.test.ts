import { describe, expect, it } from "vitest";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { convert, inspectLinks } from "@core/convert";
import type { ConvertOptions, FetchAsset, KitId } from "@core/types";
import { loadFixture } from "./helpers/loadFixture";

/**
 * Writes real component files to .acceptance/generated/ for the kit acceptance
 * script to extract over a pinned kit checkout. Not a unit test — it is the
 * generation half of the end-to-end proof, run through vitest so it uses the
 * exact same pipeline the extension does.
 */

const WORK = join(process.cwd(), ".acceptance", "generated");

/** Deterministic stand-ins so tests need no network: a real 640x360 GIF and a real SVG. */
const GIF_640X360 = "R0lGODlhgAJoAYAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";
const TINY_SVG = "PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAxNiAxNiI+PHBhdGggZD0iTTIgOGgxMiIvPjwvc3ZnPg==";

const stubAsset: FetchAsset = async (url) => {
	const isSvg = new URL(url).pathname.toLowerCase().endsWith(".svg");
	return {
		base64: isSvg ? TINY_SVG : GIF_640X360,
		contentType: isSvg ? "image/svg+xml" : "image/gif",
		originalUrl: url,
	};
};

const CASES: Array<{ fixture: string; name: string }> = [
	{ fixture: "stitch-not-found-2501", name: "NotFound-2501" },
	{ fixture: "stitch-faq-1741", name: "Faq-1741" },
	{ fixture: "stitch-hero-2274", name: "Hero-2274" },
	{ fixture: "stitch-contact-2320", name: "Contact-2320" },
	{ fixture: "stitch-nav-757", name: "Navigation-757" },
];

/**
 * Each acceptance target: a kit, and the project setup it is generated for.
 * v4 appears twice because its setup script can remove i18n, and a component
 * is only Ready for a setup somebody has actually built it in.
 */
const TARGETS: Array<{ id: string; kit: KitId; multilingual?: boolean }> = [
	{ id: "i18n", kit: "i18n" },
	{ id: "advanced-v4", kit: "advanced-v4" },
	{ id: "advanced-v4-single", kit: "advanced-v4", multilingual: false },
	{ id: "decap", kit: "decap" },
];

/**
 * A route every pinned kit really ships, and — on Advanced v4 — one whose
 * French slug differs from its English one, so the built site proves the
 * navData lookup rather than just the locale prefix.
 */
const SAFE_ROUTE = "/about";

describe("generate components for kit acceptance", () => {
	for (const target of TARGETS) {
		const kit = target.kit;
		for (const testCase of CASES) {
			it(`${target.id}/${testCase.name}`, async () => {
				const stitch = loadFixture(testCase.fixture);
				const options: ConvertOptions = {
					kit,
					multilingual: target.multilingual,
					cssFlavor: "less",
					darkMode: true,
					includeCoreStyles: false,
					includeJs: true,
					i18n: kit !== "decap",
					imagesMode: "assets",
					// Exercise the panel's intended hero choice in the pinned-kit
					// build: the core default remains false everywhere else.
					prioritizeFirstImage: testCase.fixture.includes("hero-"),
					linkMappings: inspectLinks(stitch).map((l) => ({
						...l,
						route: SAFE_ROUTE,
					})),
				};

				const result = await convert(stitch, options, stubAsset);

				// What the acceptance harness needs in order to judge the built
				// site rather than just the build.
				const localeFile = result.files.find((f) =>
					f.path.startsWith("src/locales/"),
				);
				const namespace = localeFile?.path.split("/").pop()?.replace(/\.json$/, "");

				// Every fixture contains copy, so extraction silently producing
				// nothing would leave the acceptance run with nothing to check.
				if (options.i18n) {
					expect(
						localeFile,
						`${target.id}/${testCase.name} extracted no copy`,
					).toBeDefined();
				}

				// The single-language setup must not ship a locale it removed.
				if (target.multilingual === false) {
					expect(
						result.files.filter((f) => f.path.startsWith("src/locales/fr/")),
						`${target.id}/${testCase.name} wrote a locale the project removed`,
					).toHaveLength(0);
				}

				const dir = join(WORK, `${target.id}-${testCase.name}`);
				rmSync(dir, { recursive: true, force: true });
				mkdirSync(join(dir, "files"), { recursive: true });

				for (const file of result.files) {
					const target = join(dir, "files", file.path);
					mkdirSync(dirname(target), { recursive: true });
					writeFileSync(
						target,
						file.encoding === "base64"
							? Buffer.from(file.contents, "base64")
							: file.contents,
					);
				}

				writeFileSync(
					join(dir, "manifest.json"),
					`${JSON.stringify(
						{
							componentName: result.componentName,
							componentIdentifier: result.componentIdentifier,
							componentPath: result.files[0]!.path,
							readiness: result.readiness.state,
							namespace: namespace ?? null,
							extractedCopy: Boolean(localeFile),
							expectPriority: testCase.fixture.includes("hero-"),
							expectResponsiveImages:
								kit !== "decap" && /<(?:Image|Picture)\b/.test(result.files[0]!.contents),
							reasons: result.readiness.reasons,
							files: result.files.map((f) => f.path),
						},
						null,
						"\t",
					)}\n`,
				);
			});
		}
	}
});
