import { test, expect, chromium, type BrowserContext, type Page } from "@playwright/test";
import { unzipSync } from "fflate";
import { readFileSync, mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Drives the real unpacked extension.
 *
 * Fixture pages are served through request interception on genuine
 * codestitch.app URLs, because a locally served page would never match the
 * content script's host pattern — and widening that pattern for tests would
 * ship a manifest that does not match what users install.
 */

const DIST = join(process.cwd(), "dist");
const FIXTURE_PAGES = join(process.cwd(), "tests", "fixtures", "pages");

const STITCH = {
	notFound: "2501",
	faq: "1741",
	hero: "2274",
	nav: "757",
} as const;

function stitchUrl(id: string): string {
	return `https://codestitch.app/app/dashboard/stitches/${id}`;
}

async function launch(): Promise<BrowserContext> {
	if (!existsSync(join(DIST, "manifest.json"))) {
		throw new Error("dist/ not built — run `npm run build` before the E2E suite.");
	}
	return chromium.launchPersistentContext(mkdtempSync(join(tmpdir(), "cz-")), {
		// The default headless build is the Chromium *headless shell*, which
		// cannot load extensions at all; the full browser can.
		channel: "chromium",
		headless: true,
		args: [
			`--disable-extensions-except=${DIST}`,
			`--load-extension=${DIST}`,
			"--no-sandbox",
		],
	});
}

/**
 * Serves a saved stitch page for the real URL and blocks all other network.
 *
 * Routing is installed on the context, not the page: the extension's service
 * worker downloads images, and those requests never pass through page routing.
 */
async function serveFixture(
	context: BrowserContext,
	...stitchIds: string[]
): Promise<void> {
	const pages = new Map(
		stitchIds.map((id) => [
			stitchUrl(id),
			readFileSync(join(FIXTURE_PAGES, `stitch-${id}.html`), "utf8"),
		]),
	);

	// A single handler: registering one per stitch would let the last-registered
	// route abort requests for the others.
	await context.route("**/*", async (route) => {
		const url = route.request().url();
		const page = [...pages.entries()].find(([prefix]) => url.startsWith(prefix));
		if (page) {
			await route.fulfill({ status: 200, contentType: "text/html", body: page[1] });
			return;
		}
		if (/digitaloceanspaces\.com/.test(url)) {
			// A 1x1 GIF stands in for every CDN image.
			await route.fulfill({
				status: 200,
				contentType: "image/gif",
				body: Buffer.from(
					"R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7",
					"base64",
				),
			});
			return;
		}
		await route.abort();
	});
}

/**
 * Mimics the dashboard swapping stitches without a document load: the URL and
 * the page content change together, as a client-side render would do.
 */
async function renderStitchClientSide(page: Page, stitchId: string): Promise<void> {
	const html = readFileSync(join(FIXTURE_PAGES, `stitch-${stitchId}.html`), "utf8");
	await page.evaluate(
		({ url, html }) => {
			history.pushState({}, "", url);
			const next = new DOMParser().parseFromString(html, "text/html");
			// Replacing the body also drops the mounted panel host.
			document.body.replaceWith(next.body);
		},
		{ url: stitchUrl(stitchId), html },
	);
}

/** The panel lives in a shadow root; Playwright pierces it automatically. */
const PANEL = "#componentize-root >> .panel";

test.describe("Componentize extension", () => {
	let context: BrowserContext;

	test.beforeEach(async () => {
		context = await launch();
	});

	test.afterEach(async () => {
		await context.close();
	});

	test("injects the panel on a stitch page", async () => {
		const page = await context.newPage();
		await serveFixture(context, STITCH.notFound);
		await page.goto(stitchUrl(STITCH.notFound));

		await expect(page.locator(PANEL)).toBeVisible();
		await expect(page.locator(`${PANEL} >> .title`)).toHaveText("Componentize");
		await expect(page.locator(`${PANEL} >> .subtitle`)).toContainText("Stitch #2501");

		// It sits with the code viewer, not floating over the page.
		const isBeforeCodeTabs = await page.evaluate(() => {
			const host = document.getElementById("componentize-root");
			const tabs = document.querySelector("#CODE_TABS");
			if (!host || !tabs) return false;
			return Boolean(
				host.compareDocumentPosition(tabs) & Node.DOCUMENT_POSITION_FOLLOWING,
			);
		});
		expect(isBeforeCodeTabs).toBe(true);
	});

	test("shows the hero priority toggle only for asset mode and resets it per stitch", async () => {
		const page = await context.newPage();
		await serveFixture(context, STITCH.hero, STITCH.notFound);
		await page.goto(stitchUrl(STITCH.hero));

		const priority = () =>
			page.locator(`${PANEL} >> .toggle`, { hasText: "Prioritize first image" });
		await expect(priority()).toBeVisible();
		await expect(priority().locator("input")).toBeChecked();

		await priority().locator("input").uncheck();
		await expect(priority().locator("input")).not.toBeChecked();

		const images = page.locator(`${PANEL} >> .field`, { hasText: "Images" }).locator("select");
		await images.selectOption("raw");
		await expect(priority()).toHaveCount(0);
		await images.selectOption("assets");
		await expect(priority()).toBeVisible();
		await expect(priority().locator("input")).not.toBeChecked();

		// Rebuilding the panel for another stitch must not carry the prior choice.
		// The code must change with the URL: the hero default is read from the
		// scraped markup, so a bare pushState would still parse the hero.
		await renderStitchClientSide(page, STITCH.notFound);
		await expect(page.locator(`${PANEL} >> .subtitle`)).toContainText("Stitch #2501", {
			timeout: 15_000,
		});
		// Asset mode shows the toggle for every stitch; only heroes default it on.
		await expect(priority()).toBeVisible();
		await expect(priority().locator("input")).not.toBeChecked();

		await renderStitchClientSide(page, STITCH.hero);
		await expect(page.locator(`${PANEL} >> .subtitle`)).toContainText("Stitch #2274", {
			timeout: 15_000,
		});
		await expect(priority().locator("input")).toBeChecked();
	});

	test("pre-fills the component name and lists the links to resolve", async () => {
		const page = await context.newPage();
		await serveFixture(context, STITCH.notFound);
		await page.goto(stitchUrl(STITCH.notFound));

		const nameInput = page
			.locator(`${PANEL} >> .field`, { hasText: "File name" })
			.locator('input[type="text"]');
		await expect(nameInput).toHaveValue("NotFound-2501");

		// The 404 stitch ships two placeholder buttons, and both arrive with a
		// route already read off their label — nothing to type.
		await expect(page.locator(`${PANEL} >> .links h3`)).toContainText("all set");
		const routes = page.locator(`${PANEL} >> .link-row input`);
		await expect(routes.nth(0)).toHaveValue("/return-to-home");
		await expect(routes.nth(1)).toHaveValue("/view-properties");
	});

	test("stops guessing when the toggle is turned off", async () => {
		const page = await context.newPage();
		await serveFixture(context, STITCH.notFound);
		await page.goto(stitchUrl(STITCH.notFound));

		await page
			.locator(`${PANEL} >> .toggle`, { hasText: "Guess routes" })
			.locator("input")
			.uncheck();

		await expect(page.locator(`${PANEL} >> .links h3`)).toContainText(
			"2 still need a destination",
		);
		await expect(page.locator(`${PANEL} >> .link-row input`).first()).toHaveValue("");
	});

	test("copies a component to the clipboard", async () => {
		await context.grantPermissions(["clipboard-read", "clipboard-write"], {
			origin: "https://codestitch.app",
		});
		const page = await context.newPage();
		await serveFixture(context, STITCH.notFound);
		await page.goto(stitchUrl(STITCH.notFound));

		await page.locator(`${PANEL} >> button`, { hasText: "Copy .astro" }).click();
		await expect(page.locator(`${PANEL} >> .status`)).toContainText("copied");

		const clipboard = await page.evaluate(() => navigator.clipboard.readText());
		expect(clipboard).toContain('<section id="not-found-2501">');
		// In assets mode the style tag also carries define:vars for CSS backgrounds.
		expect(clipboard).toContain('<style lang="less"');
	});

	test("shows a Draft verdict with its reasons, and Ready once links are resolved", async () => {
		const page = await context.newPage();
		await serveFixture(context, STITCH.notFound);
		await page.goto(stitchUrl(STITCH.notFound));

		// Decap kit + raw images keeps this test about links alone.
		await page.locator(`${PANEL} >> .field select`).first().selectOption("decap");
		await page
			.locator(`${PANEL} >> .field`, { hasText: "Images" })
			.locator("select")
			.selectOption("raw");

		await page.locator(`${PANEL} >> button`, { hasText: "Copy .astro" }).click();
		await expect(page.locator(`${PANEL} >> .badge`)).toHaveText("Draft");
		// The guessed routes point at pages the kit does not ship.
		await expect(page.locator(`${PANEL} >> .reasons`)).toContainText(
			"does not ship",
		);

		// Point both at pages the pristine kit really has.
		const routeInputs = page.locator(`${PANEL} >> .link-row input`);
		await routeInputs.nth(0).fill("/about");
		await routeInputs.nth(1).fill("/contact");

		await page.locator(`${PANEL} >> button`, { hasText: "Copy .astro" }).click();
		await expect(page.locator(`${PANEL} >> .badge`)).toHaveText("Ready");
	});

	test("a nav stitch's toggle says its script is left out, and the copy agrees", async () => {
		await context.grantPermissions(["clipboard-read", "clipboard-write"], {
			origin: "https://codestitch.app",
		});
		const page = await context.newPage();
		await serveFixture(context, STITCH.nav);
		await page.goto(stitchUrl(STITCH.nav));

		// Both kits run this hamburger script sitewide, so it is left out by
		// default — and the toggle must not claim otherwise.
		const toggle = page.locator(`${PANEL} >> .toggle`, { hasText: "Include JavaScript" });
		await expect(toggle).toContainText("kit already ships this nav script");
		await expect(toggle.locator("input")).toBeEnabled();
		await expect(toggle.locator("input")).not.toBeChecked();

		await page.locator(`${PANEL} >> button`, { hasText: "Copy .astro" }).click();
		await expect(page.locator(`${PANEL} >> .status`)).toContainText("copied");
		const clipboard = await page.evaluate(() => navigator.clipboard.readText());
		expect(clipboard).toContain('id="cs-navigation"');
		expect(clipboard).not.toContain("<script>");
		await expect(page.locator(`${PANEL} >> .notes`)).toContainText(
			"Left out the stitch's navigation script",
		);
	});

	test("ticking the nav toggle includes the script and makes the result a Draft", async () => {
		await context.grantPermissions(["clipboard-read", "clipboard-write"], {
			origin: "https://codestitch.app",
		});
		const page = await context.newPage();
		await serveFixture(context, STITCH.nav);
		await page.goto(stitchUrl(STITCH.nav));

		const toggle = page.locator(`${PANEL} >> .toggle`, { hasText: "Include JavaScript" });
		await toggle.locator("input").check();
		await expect(toggle.locator("input")).toBeChecked();

		await page.locator(`${PANEL} >> button`, { hasText: "Copy .astro" }).click();
		await expect(page.locator(`${PANEL} >> .badge`)).toHaveText("Draft");
		await expect(page.locator(`${PANEL} >> .reasons`)).toContainText("nav.js");

		const clipboard = await page.evaluate(() => navigator.clipboard.readText());
		expect(clipboard).toContain("<script>");
		expect(clipboard).toContain('document.addEventListener("astro:page-load"');
		expect(clipboard).toContain("cs-toggle");
	});

	test("an ordinary stitch's toggle stays ticked and its script is copied", async () => {
		await context.grantPermissions(["clipboard-read", "clipboard-write"], {
			origin: "https://codestitch.app",
		});
		const page = await context.newPage();
		await serveFixture(context, STITCH.faq);
		await page.goto(stitchUrl(STITCH.faq));

		const toggle = page.locator(`${PANEL} >> .toggle`, { hasText: "Include JavaScript" });
		await expect(toggle).toHaveText("Include JavaScript");
		await expect(toggle.locator("input")).toBeChecked();

		await page.locator(`${PANEL} >> button`, { hasText: "Copy .astro" }).click();
		await expect(page.locator(`${PANEL} >> .status`)).toContainText("copied");
		const clipboard = await page.evaluate(() => navigator.clipboard.readText());
		expect(clipboard).toContain("<script>");
		expect(clipboard).toContain("cs-faq-item");
	});

	test("downloads a ZIP whose entries match the kit layout", async () => {
		const page = await context.newPage();
		await serveFixture(context, STITCH.faq);
		await page.goto(stitchUrl(STITCH.faq));

		const downloadPromise = page.waitForEvent("download");
		await page.locator(`${PANEL} >> button`, { hasText: "Download ZIP" }).click();
		const download = await downloadPromise;

		expect(download.suggestedFilename()).toMatch(/^Faq-1741(-draft)?\.zip$/);
		const path = await download.path();
		expect(path).toBeTruthy();

		const entries = unzipSync(new Uint8Array(readFileSync(path!)));
		const names = Object.keys(entries);

		// Paths are kit-relative so the archive extracts over a project root.
		expect(names).toContain("src/components/Faq-1741/Faq-1741.astro");
		for (const name of names) {
			expect(name.startsWith("src/"), name).toBe(true);
			expect(name).not.toContain("..");
		}

		// The component is real text, and imports only files the ZIP carries.
		const astro = new TextDecoder().decode(entries["src/components/Faq-1741/Faq-1741.astro"]!);
		expect(astro).toContain('<section id="faq-1741">');
		for (const [, specifier] of astro.matchAll(/^import\s+\S+\s+from\s+"(@assets\/[^"]+)"/gm)) {
			expect(names, `${specifier} must be in the ZIP`).toContain(
				specifier!.replace("@assets/", "src/assets/"),
			);
		}

		// Images are carried as real bytes, not text.
		const images = names.filter((n) => n.startsWith("src/assets/images/"));
		expect(images.length).toBeGreaterThan(0);
		for (const image of images) {
			const bytes = entries[image]!;
			expect(bytes.byteLength).toBeGreaterThan(0);
			// The stub CDN response is a GIF; check the magic number survived.
			expect(new TextDecoder().decode(bytes.subarray(0, 3))).toBe("GIF");
		}
	});

	test("warns that a copied component alone is missing its companion files", async () => {
		await context.grantPermissions(["clipboard-read", "clipboard-write"], {
			origin: "https://codestitch.app",
		});
		const page = await context.newPage();
		await serveFixture(context, STITCH.faq);
		await page.goto(stitchUrl(STITCH.faq));

		// The Decap kit needs no locale files, so the only difference between the
		// two deliveries is the downloaded images.
		await page.locator(`${PANEL} >> .field select`).first().selectOption("decap");
		await page.locator(`${PANEL} >> .link-row input`).first().fill("/about");

		await page.locator(`${PANEL} >> button`, { hasText: "Download ZIP" }).click();
		await expect(page.locator(`${PANEL} >> .badge`)).toHaveText("Ready");

		// The same conversion delivered as a lone .astro is not drop-in.
		await page.locator(`${PANEL} >> button`, { hasText: "Copy .astro" }).click();
		await expect(page.locator(`${PANEL} >> .badge`)).toHaveText("Draft");
		await expect(page.locator(`${PANEL} >> .reasons`)).toContainText("Download ZIP");
	});

	test("the copied file carries the verdict for what was copied", async () => {
		await context.grantPermissions(["clipboard-read", "clipboard-write"], {
			origin: "https://codestitch.app",
		});
		const page = await context.newPage();
		await serveFixture(context, STITCH.faq);
		await page.goto(stitchUrl(STITCH.faq));

		await page.locator(`${PANEL} >> .field select`).first().selectOption("decap");
		await page.locator(`${PANEL} >> .link-row input`).first().fill("/about");

		await page.locator(`${PANEL} >> button`, { hasText: "Copy .astro" }).click();
		await expect(page.locator(`${PANEL} >> .badge`)).toHaveText("Draft");

		// The file must agree with the badge, not claim it builds on its own.
		const clipboard = await page.evaluate(() => navigator.clipboard.readText());
		expect(clipboard).not.toContain("Ready: builds as-is");
		expect(clipboard).toContain("Draft — needs attention before shipping:");
		expect(clipboard).toContain("Download ZIP");
	});

	test("drops a stale verdict as soon as the settings change", async () => {
		const page = await context.newPage();
		await serveFixture(context, STITCH.notFound);
		await page.goto(stitchUrl(STITCH.notFound));

		await page.locator(`${PANEL} >> .field select`).first().selectOption("decap");
		await page
			.locator(`${PANEL} >> .field`, { hasText: "Images" })
			.locator("select")
			.selectOption("raw");
		const routes = page.locator(`${PANEL} >> .link-row input`);
		await routes.nth(0).fill("/about");
		await routes.nth(1).fill("/contact");

		await page.locator(`${PANEL} >> button`, { hasText: "Download .astro" }).click();
		await expect(page.locator(`${PANEL} >> .badge`)).toHaveText("Ready");

		// Editing a route invalidates that verdict; it must not linger.
		await routes.nth(0).fill("/reviews");
		await expect(page.locator(`${PANEL} >> .badge`)).toHaveCount(0);

		// Typing keeps the caret where the user left it.
		await expect(routes.nth(0)).toBeFocused();

		// The same applies to the component name.
		await page.locator(`${PANEL} >> button`, { hasText: "Download .astro" }).click();
		await expect(page.locator(`${PANEL} >> .badge`)).toHaveCount(1);
		await page
			.locator(`${PANEL} >> .field`, { hasText: "File name" })
			.locator('input[type="text"]')
			.fill("Renamed");
		await expect(page.locator(`${PANEL} >> .badge`)).toHaveCount(0);
	});

	test("re-mounts itself when the dashboard navigates to another stitch", async () => {
		const page = await context.newPage();
		await serveFixture(context, STITCH.notFound, STITCH.faq);
		await page.goto(stitchUrl(STITCH.notFound));
		await expect(page.locator(`${PANEL} >> .subtitle`)).toContainText("Stitch #2501");

		// The dashboard can swap pages without a document load.
		await page.evaluate((url) => history.pushState({}, "", url), stitchUrl(STITCH.faq));
		await page.evaluate(() => {
			// A client-side render would replace the page's content wholesale.
			document.getElementById("componentize-root")?.remove();
		});

		await expect(page.locator(`${PANEL} >> .subtitle`)).toContainText("Stitch #1741", {
			timeout: 15_000,
		});
	});

	test("says so when the code fields are empty", async () => {
		await context.route("**/*", async (route) => {
			const url = route.request().url();
			if (url.startsWith(stitchUrl(STITCH.notFound))) {
				await route.fulfill({
					status: 200,
					contentType: "text/html",
					// The code viewer is present but every field is locked/empty.
					body: `<html><body><div class="section-body"><div id="CODE_TABS">
						<div class="CODE_TABS__BODY">
							<div class="tab" data-codeid="1"><textarea class="CODE-TEXTAREA"></textarea></div>
						</div></div></div></body></html>`,
				});
				return;
			}
			await route.abort();
		});
		const page = await context.newPage();
		await page.goto(stitchUrl(STITCH.notFound));

		await expect(page.locator(`${PANEL} >> .error`)).toContainText(
			"premium stitch, or you are not signed in",
		);
	});

	test("labels every control for assistive technology", async () => {
		const page = await context.newPage();
		await serveFixture(context, STITCH.notFound);
		await page.goto(stitchUrl(STITCH.notFound));

		const unlabelled = await page.evaluate(() => {
			const root = document.getElementById("componentize-root")?.shadowRoot;
			if (!root) return ["no shadow root"];
			const problems: string[] = [];
			for (const control of root.querySelectorAll("select, input")) {
				const id = control.getAttribute("id");
				const labelled =
					(id && root.querySelector(`label[for="${id}"]`)) ||
					control.closest("label") ||
					control.getAttribute("aria-label");
				if (!labelled) problems.push(control.outerHTML.slice(0, 60));
			}
			return problems;
		});
		expect(unlabelled).toEqual([]);

		// Outcomes are announced, not only shown.
		await expect(page.locator(`${PANEL} >> .status`)).toHaveAttribute(
			"aria-live",
			"polite",
		);
	});

	test("targets the current Advanced kit by default, and names the version", async () => {
		const page = await context.newPage();
		await serveFixture(context, STITCH.faq);
		await page.goto(stitchUrl(STITCH.faq));

		await expect(page.locator(`${PANEL} >> .field select`).first()).toHaveValue(
			"advanced-v4",
		);
		// The subtitle has to say which kit a verdict is about, by version.
		await expect(page.locator(`${PANEL} >> .subtitle`)).toContainText(
			"Advanced Astro v4",
		);
		await expect(page.locator(`${PANEL} >> .subtitle`)).toContainText("a2eb8fd0");

		// Both Advanced versions are offered, each named.
		const options = page.locator(`${PANEL} >> .field select`).first().locator("option");
		await expect(options).toHaveText([
			"Advanced Astro v4",
			"Advanced Astro v3.0.2 (legacy)",
			"Intermediate Astro + Decap",
		]);
	});

	test("keeps a saved target rather than moving it to the new default", async () => {
		const page = await context.newPage();
		await serveFixture(context, STITCH.notFound);
		await page.goto(stitchUrl(STITCH.notFound));

		// Someone already generating for the older Advanced kit.
		await page.locator(`${PANEL} >> .field select`).first().selectOption("i18n");
		await page.waitForTimeout(600); // debounce window

		const second = await context.newPage();
		await second.goto(stitchUrl(STITCH.notFound));

		await expect(second.locator(`${PANEL} >> .field select`).first()).toHaveValue(
			"i18n",
		);
		await expect(second.locator(`${PANEL} >> .subtitle`)).toContainText(
			"Advanced Astro v3.0.2 (legacy)",
		);
	});

	test("the multilingual setting applies to v4 only, and decides the locale files", async () => {
		const page = await context.newPage();
		await serveFixture(context, STITCH.faq);
		await page.goto(stitchUrl(STITCH.faq));

		const multilingual = page.locator(`${PANEL} >> .toggle`, {
			hasText: "Multiple languages",
		});
		await expect(multilingual.locator("input")).toBeEnabled();
		await expect(multilingual.locator("input")).toBeChecked();

		// The older Advanced kit has no single-language setup to describe.
		await page.locator(`${PANEL} >> .field select`).first().selectOption("i18n");
		await expect(multilingual.locator("input")).toBeDisabled();

		await page.locator(`${PANEL} >> .field select`).first().selectOption("advanced-v4");
		await multilingual.locator("input").uncheck();

		const downloadPromise = page.waitForEvent("download");
		await page.locator(`${PANEL} >> button`, { hasText: "Download ZIP" }).click();
		const download = await downloadPromise;
		const entries = unzipSync(new Uint8Array(readFileSync((await download.path())!)));
		const locales = Object.keys(entries).filter((n) => n.startsWith("src/locales/"));

		// Only the default locale, and nothing left to translate. The stitch's
		// own links are still unresolved, so the verdict stays Draft for that
		// reason alone.
		expect(locales).toEqual(["src/locales/en/faq1741.json"]);
		await expect(page.locator(`${PANEL} >> .reasons`)).not.toContainText("translate");
	});

	test("a v4 component reads its copy from content and resolves its links", async () => {
		await context.grantPermissions(["clipboard-read", "clipboard-write"], {
			origin: "https://codestitch.app",
		});
		const page = await context.newPage();
		await serveFixture(context, STITCH.faq);
		await page.goto(stitchUrl(STITCH.faq));

		await page.locator(`${PANEL} >> .link-row input`).first().fill("/about");
		await page.locator(`${PANEL} >> button`, { hasText: "Copy .astro" }).click();
		await expect(page.locator(`${PANEL} >> .status`)).toContainText("copied");

		const clipboard = await page.evaluate(() => navigator.clipboard.readText());
		expect(clipboard).toContain('import { getSiteContext } from "@js/getSiteContext"');
		expect(clipboard).toContain("content.faq1741.");
		expect(clipboard).toContain('href={routeFor("/about/")}');
		// The helpers v4 replaced must not appear.
		expect(clipboard).not.toContain("@js/translationUtils");
	});

	test("remembers preferences across page loads", async () => {
		const page = await context.newPage();
		await serveFixture(context, STITCH.notFound);
		await page.goto(stitchUrl(STITCH.notFound));

		await page.locator(`${PANEL} >> .field select`).first().selectOption("decap");
		await page.waitForTimeout(600); // debounce window

		const second = await context.newPage();
		
		await second.goto(stitchUrl(STITCH.notFound));

		await expect(
			second.locator(`${PANEL} >> .field select`).first(),
		).toHaveValue("decap");
	});

	test("stays out of the way on a stitch's live preview", async () => {
		// /stitches/<id>/rendered shows the stitch itself and has no code fields.
		// The panel used to mount there and report a layout change.
		await context.route("**/*", async (route) => {
			const url = route.request().url();
			if (url.startsWith(`${stitchUrl(STITCH.notFound)}/rendered`)) {
				await route.fulfill({
					status: 200,
					contentType: "text/html",
					body: "<html><body><section id='not-found-2501'>preview</section></body></html>",
				});
				return;
			}
			await route.abort();
		});
		const page = await context.newPage();
		await page.goto(`${stitchUrl(STITCH.notFound)}/rendered`);
		await page.waitForTimeout(1500);

		expect(await page.locator("#componentize-root").count()).toBe(0);
	});

	test("explains itself when the page layout is unrecognisable", async () => {
		await context.route("**/*", async (route) => {
			const url = route.request().url();
			if (url.startsWith(stitchUrl(STITCH.notFound))) {
				await route.fulfill({
					status: 200,
					contentType: "text/html",
					body: "<html><body><h1>Redesigned</h1></body></html>",
				});
				return;
			}
			await route.abort();
		});
		const page = await context.newPage();
		await page.goto(stitchUrl(STITCH.notFound));

		await expect(page.locator(`${PANEL} >> .error`)).toContainText(
			"CodeStitch changed its page layout",
		);
	});
});
