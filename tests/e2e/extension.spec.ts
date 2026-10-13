import { test, expect, chromium, type BrowserContext, type Page } from "@playwright/test";
import { unzipSync } from "fflate";
import { readFileSync, mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getCodePage, type StubCode } from "../helpers/getCodePage";

/**
 * Drives the real unpacked extension on CodeStitch's redesigned Get code page.
 *
 * Fixture pages are served through request interception on genuine
 * codestitch.app URLs, because a locally served page would never match the
 * content script's host pattern — and widening that pattern for tests would
 * ship a manifest that does not match what users install.
 *
 * CodeStitch's own site/js/get-code.js, which renders the inspector's
 * controls, is replaced by tests/e2e/stubs/get-code.js: a stand-in that
 * reproduces the DOM contract the extension reads, so the suite stays
 * hermetic. The opt-in live test at the end checks that contract against the
 * real site.
 */

const DIST = join(process.cwd(), "dist");
const FIXTURE_PAGES = join(process.cwd(), "tests", "fixtures", "pages");
const STUB_SCRIPT = readFileSync(join(process.cwd(), "tests", "e2e", "stubs", "get-code.js"), "utf8");
const APP_ORIGIN = "https://app.codestitch.app";
const GET_CODE_SCRIPT = `${APP_ORIGIN}/site/js/get-code.js`;

/**
 * The commit the default target is pinned to, read from the profile rather
 * than written out here: the panel's job is to show whichever commit a Ready
 * verdict is about, and re-pinning the kit should not need a test edited.
 */
const V4_PROFILE = JSON.parse(
	readFileSync(join(process.cwd(), "src", "core", "kits", "profiles", "advanced-v4.json"), "utf8"),
) as { sha: string; label: string };

const STITCH = {
	notFound: "2501",
	faq: "1741",
	hero: "2274",
	nav: "757",
} as const;

function stitchUrl(id: string | number, origin = APP_ORIGIN): string {
	return `${origin}/app/dashboard/stitches/${id}`;
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
		args: [`--disable-extensions-except=${DIST}`, `--load-extension=${DIST}`, "--no-sandbox"],
	});
}

/** Hosts the fixture pages load scripts from; each is answered with an empty script. */
const SCRIPT_HOSTS = /^https?:\/\/(app\.codestitch\.app\/(site|vendor)\/|ajax\.googleapis\.com\/|cdn\.jsdelivr\.net\/|unpkg\.com\/|www\.googletagmanager\.com\/)/;

interface ServeOptions {
	/** Serve the CodeStitch stand-in, so the inspector's controls render. */
	hostScript?: boolean;
	/** Starting Get code preferences for the stand-in. */
	stubPrefs?: Record<string, unknown>;
	/** Hold every CDN image this long, to keep a conversion in flight. */
	cdnDelayMs?: number;
	/** Extra pages by stitch id, e.g. built with getCodePage(). */
	pages?: Record<string, string>;
}

/**
 * Serves saved stitch pages for their real URLs and blocks all other network.
 *
 * Routing is installed on the context, not the page: the extension's service
 * worker downloads images, and those requests never pass through page routing.
 */
async function serveFixture(
	context: BrowserContext,
	stitchIds: string[],
	options: ServeOptions = {},
): Promise<void> {
	const { hostScript = true, stubPrefs, cdnDelayMs = 0 } = options;
	const pages = new Map<string, string>([
		...stitchIds.map(
			(id) => [stitchUrl(id), readFileSync(join(FIXTURE_PAGES, `stitch-${id}.html`), "utf8")] as const,
		),
		...Object.entries(options.pages ?? {}).map(([id, html]) => [stitchUrl(id), html] as const),
	]);

	// A single handler: registering one per stitch would let the last-registered
	// route abort requests for the others.
	await context.route("**/*", async (route) => {
		const url = route.request().url();
		const page = [...pages.entries()].find(([prefix]) => url === prefix || url === `${prefix}/`);
		if (page) {
			await route.fulfill({ status: 200, contentType: "text/html", body: page[1] });
			return;
		}
		if (url.startsWith(GET_CODE_SCRIPT) && hostScript) {
			await route.fulfill({
				status: 200,
				contentType: "application/javascript",
				body: `window.__STUB_PREFS = ${JSON.stringify(stubPrefs ?? {})};\n${STUB_SCRIPT}`,
			});
			return;
		}
		if (SCRIPT_HOSTS.test(url)) {
			await route.fulfill({ status: 200, contentType: "application/javascript", body: "" });
			return;
		}
		if (/digitaloceanspaces\.com/.test(url)) {
			if (cdnDelayMs) await new Promise((r) => setTimeout(r, cdnDelayMs));
			// A 1x1 GIF stands in for every CDN image.
			await route
				.fulfill({
					status: 200,
					contentType: "image/gif",
					body: Buffer.from("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7", "base64"),
				})
				.catch(() => {
					/* the context may have closed while the response was held */
				});
			return;
		}
		await route.abort();
	});
}

/**
 * Mimics the dashboard swapping stitches without a document load: the URL and
 * the page content change together, as a client-side render would do. Scripts
 * inserted this way never run, so CodeStitch's controls stay unrendered.
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

async function grantClipboard(context: BrowserContext): Promise<void> {
	await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: APP_ORIGIN });
}

/** Opens a stitch with the panel mounted and CodeStitch's controls rendered. */
async function open(context: BrowserContext, id: string, options: ServeOptions = {}): Promise<Page> {
	const page = await context.newPage();
	await serveFixture(context, options.pages?.[id] ? [] : [id], options);
	await page.goto(stitchUrl(id));
	await expect(page.locator(PANEL)).toBeVisible();
	if (options.hostScript !== false) await expect(page.locator("#formats [aria-pressed=true]")).toHaveCount(1);
	return page;
}

const kitSelect = (page: Page) => page.locator(`${PANEL} >> .field`, { hasText: "Kit" }).locator("select");
const action = (page: Page, label: string) => page.locator(`${PANEL} >> button`, { hasText: label });
const toggle = (page: Page, label: string) => page.locator(`${PANEL} >> .toggle`, { hasText: label });

async function copy(page: Page): Promise<string> {
	await action(page, "Copy .astro").click();
	await expect(page.locator(`${PANEL} >> .status`)).toContainText("copied");
	return page.evaluate(() => navigator.clipboard.readText());
}

test.describe("Componentize extension", () => {
	let context: BrowserContext;

	test.beforeEach(async () => {
		context = await launch();
	});

	test.afterEach(async () => {
		await context.close();
	});

	test("mounts as the last section of CodeStitch's Get code settings", async () => {
		const page = await open(context, STITCH.notFound);

		await expect(page.locator(`${PANEL} >> .title`)).toHaveText("Componentize");
		await expect(page.locator(`${PANEL} >> .subtitle`)).toContainText("Stitch #2501");

		const placement = await page.evaluate(() => {
			const host = document.getElementById("componentize-root");
			return {
				parent: host?.parentElement?.className,
				last: host?.parentElement?.lastElementChild === host,
				afterReset: Boolean(
					host &&
						document.querySelector(".gc-reset")!.compareDocumentPosition(host) &
							Node.DOCUMENT_POSITION_FOLLOWING,
				),
			};
		});
		expect(placement).toEqual({ parent: "gc-inspector__scroll", last: true, afterReset: true });
	});

	test("injects on the apex host and arbitrary CodeStitch subdomains", async () => {
		const cases = [
			{ origin: "https://codestitch.app", label: "apex" },
			{ origin: "https://preview.codestitch.app", label: "subdomain" },
		];
		const html = readFileSync(join(FIXTURE_PAGES, `stitch-${STITCH.notFound}.html`), "utf8");

		await context.route("**/*", async (route) => {
			const url = route.request().url();
			if (cases.some(({ origin }) => url.startsWith(stitchUrl(STITCH.notFound, origin)))) {
				await route.fulfill({ status: 200, contentType: "text/html", body: html });
				return;
			}
			await route.abort();
		});

		for (const { origin, label } of cases) {
			const page = await context.newPage();
			await page.goto(stitchUrl(STITCH.notFound, origin));
			await expect(page.locator(PANEL), label).toBeVisible();
		}
	});

	test("shows the hero priority toggle only when images are bundled, and resets it per stitch", async () => {
		const page = await open(context, STITCH.hero);
		const priority = () => toggle(page, "Prioritize first image");

		// Get code starts on the CodeStitch CDN, where priority means nothing.
		await expect(priority()).toHaveCount(0);
		await page.locator('#image-modes [data-id="local"]').click();
		await expect(priority()).toBeVisible();
		await expect(priority().locator("input")).toBeChecked();

		await priority().locator("input").uncheck();
		await page.locator('#image-modes [data-id="cdn"]').click();
		await expect(priority()).toHaveCount(0);
		await page.locator('#image-modes [data-id="local"]').click();
		await expect(priority().locator("input")).not.toBeChecked();

		// Rebuilding the panel for another stitch must not carry the prior choice.
		// A client-side swap leaves Get code unrendered, so the panel's own
		// default (download images) applies and the toggle shows.
		await renderStitchClientSide(page, STITCH.notFound);
		await expect(page.locator(`${PANEL} >> .subtitle`)).toContainText("Stitch #2501", { timeout: 15_000 });
		await expect(priority()).toBeVisible();
		await expect(priority().locator("input")).not.toBeChecked();

		await renderStitchClientSide(page, STITCH.hero);
		await expect(page.locator(`${PANEL} >> .subtitle`)).toContainText("Stitch #2274", { timeout: 15_000 });
		await expect(priority().locator("input")).toBeChecked();
	});

	test("takes the file name and links from Get code instead of repeating them", async () => {
		const page = await open(context, STITCH.notFound);

		await expect(page.locator("#file-name")).toHaveAttribute("placeholder", "Not-found-2501");
		await expect(page.locator(`${PANEL} >> .host-summary`)).toContainText("Not-found-2501.astro");

		// Both placeholder buttons are in Get code's own list, so the panel lists none.
		await expect(page.locator("#link-0")).toHaveValue("/return-to-home");
		await expect(page.locator("#link-1")).toHaveValue("/view-properties");
		await expect(page.locator(`${PANEL} >> .links`)).toHaveCount(0);
		await expect(page.locator(`${PANEL} >> .field`, { hasText: "File name" })).toHaveCount(0);
		await expect(page.locator(`${PANEL} >> .field`, { hasText: "Styles" })).toHaveCount(0);
	});

	test("notes routes the kit does not ship under Get code's own rows, across its re-renders", async () => {
		const page = await open(context, STITCH.notFound);
		const note = page.locator('#link-rows .gc-link-row[data-i="0"] [data-componentize]');
		await expect(note).toContainText("Componentize: Advanced Astro v4 does not ship /return-to-home/");

		// Get code rebuilds #link-rows on every settings change.
		await page.locator('#flavours [data-id="less"]').click();
		await expect(note).toHaveCount(1);
		await expect(page.locator("#link-rows [data-componentize]")).toHaveCount(2);
	});

	test("leaves links Get code has no destination for as TODOs", async () => {
		await grantClipboard(context);
		const page = await open(context, STITCH.notFound);

		await page.locator("#guess-routes").uncheck();
		await expect(page.locator("#link-0")).toHaveValue("");

		const clipboard = await copy(page);
		expect(clipboard.match(/TODO: set the destination/g)).toHaveLength(2);
		await expect(page.locator(`${PANEL} >> .reasons`)).toContainText("no destination yet");
	});

	test("copies a component in the flavour picked in Get code", async () => {
		await grantClipboard(context);
		const page = await open(context, STITCH.notFound);

		await page.locator('#flavours [data-id="less"]').click();
		const clipboard = await copy(page);
		expect(clipboard).toContain('<section id="not-found-2501">');
		expect(clipboard).toContain('<style lang="less"');
	});

	test("shows a Draft verdict with its reasons, and Ready once links are resolved", async () => {
		await grantClipboard(context);
		const page = await open(context, STITCH.notFound);

		// Decap kit + CDN images keeps this test about links alone.
		await kitSelect(page).selectOption("decap");
		await action(page, "Copy .astro").click();
		await expect(page.locator(`${PANEL} >> .badge`)).toHaveText("Draft");
		// The guessed routes point at pages the kit does not ship.
		await expect(page.locator(`${PANEL} >> .reasons`)).toContainText("does not ship");

		// Point both at pages the pristine kit really has, in Get code's fields.
		await page.locator("#link-0").fill("/about");
		await page.locator("#link-1").fill("/contact");

		await action(page, "Copy .astro").click();
		await expect(page.locator(`${PANEL} >> .badge`)).toHaveText("Ready");
	});

	test("a nav stitch's script is left out, and the panel says so", async () => {
		await grantClipboard(context);
		const page = await open(context, STITCH.nav);

		// Both kits run this hamburger script sitewide, so it is left out by
		// default — and the exception toggle must not claim otherwise.
		const nav = toggle(page, "Include JavaScript");
		await expect(nav).toContainText("kit already ships this nav script");
		await expect(nav.locator("input")).not.toBeChecked();

		const clipboard = await copy(page);
		expect(clipboard).toContain('id="cs-navigation"');
		expect(clipboard).not.toContain("<script>");
		await expect(page.locator(`${PANEL} >> .notes`)).toContainText("Left out the stitch's navigation script");

		// Unticking JavaScript in Get code removes the exception altogether.
		await page.locator("#include-js").uncheck();
		await expect(nav).toHaveCount(0);
	});

	test("ticking the nav exception includes the script and makes the result a Draft", async () => {
		await grantClipboard(context);
		const page = await open(context, STITCH.nav);

		await toggle(page, "Include JavaScript").locator("input").check();
		await action(page, "Copy .astro").click();
		await expect(page.locator(`${PANEL} >> .badge`)).toHaveText("Draft");
		await expect(page.locator(`${PANEL} >> .reasons`)).toContainText("nav.js");

		const clipboard = await page.evaluate(() => navigator.clipboard.readText());
		expect(clipboard).toContain("<script>");
		expect(clipboard).toContain('document.addEventListener("astro:page-load"');
		expect(clipboard).toContain("cs-toggle");
	});

	test("an ordinary stitch's script follows Get code's JavaScript box", async () => {
		await grantClipboard(context);
		const page = await open(context, STITCH.faq);

		await expect(toggle(page, "Include JavaScript")).toHaveCount(0);
		let clipboard = await copy(page);
		expect(clipboard).toContain("<script>");
		expect(clipboard).toContain("cs-faq-item");

		await page.locator("#include-js").uncheck();
		clipboard = await copy(page);
		expect(clipboard).not.toContain("<script>");
	});

	test("downloads a ZIP whose entries match the kit layout", async () => {
		const page = await open(context, STITCH.faq);
		await page.locator('#image-modes [data-id="local"]').click();

		const downloadPromise = page.waitForEvent("download");
		await action(page, "Download ZIP").click();
		const download = await downloadPromise;

		expect(download.suggestedFilename()).toMatch(/^Faq-1741(-draft)?\.zip$/);
		const entries = unzipSync(new Uint8Array(readFileSync((await download.path())!)));
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
			expect(names, `${specifier} must be in the ZIP`).toContain(specifier!.replace("@assets/", "src/assets/"));
		}

		// Get code's default folder maps to a folder named after the stitch.
		const images = names.filter((n) => n.startsWith("src/assets/images/"));
		expect(images.length).toBeGreaterThan(0);
		for (const image of images) {
			expect(image.startsWith("src/assets/images/faq/"), image).toBe(true);
			// The stub CDN response is a GIF; check the magic number survived.
			expect(new TextDecoder().decode(entries[image]!.subarray(0, 3))).toBe("GIF");
		}
	});

	test("writes images to the folder named in Get code", async () => {
		const page = await open(context, STITCH.faq);
		await page.locator('#image-modes [data-id="local"]').click();
		await page.locator("#images-folder").fill("/assets/images/foo");

		const downloadPromise = page.waitForEvent("download");
		await action(page, "Download ZIP").click();
		const entries = unzipSync(new Uint8Array(readFileSync((await (await downloadPromise).path())!)));
		const images = Object.keys(entries).filter((n) => n.includes("/images/"));
		expect(images.length).toBeGreaterThan(0);
		for (const image of images) expect(image.startsWith("src/assets/images/foo/"), image).toBe(true);
	});

	test("says why a Get code images folder outside src/assets was not used", async () => {
		const page = await open(context, STITCH.faq);
		await page.locator('#image-modes [data-id="local"]').click();
		await page.locator("#images-folder").fill("/public/img");

		await action(page, "Download ZIP").click();
		await expect(page.locator(`${PANEL} >> .badge`)).toHaveText("Draft");
		await expect(page.locator(`${PANEL} >> .reasons`)).toContainText("is not under src/assets");
	});

	test("names the download after Get code's file name", async () => {
		const page = await open(context, STITCH.notFound);
		await page.locator("#file-name").fill("Renamed");

		const downloadPromise = page.waitForEvent("download");
		await action(page, "Download .astro").click();
		expect((await downloadPromise).suggestedFilename()).toBe("Renamed.astro");
	});

	test("warns that a copied component alone is missing its companion files", async () => {
		await grantClipboard(context);
		const page = await open(context, STITCH.faq);

		// The Decap kit needs no locale files, so the only difference between the
		// two deliveries is the downloaded images.
		await kitSelect(page).selectOption("decap");
		await page.locator('#image-modes [data-id="local"]').click();
		await page.locator("#link-0").fill("/about");

		await action(page, "Download ZIP").click();
		await expect(page.locator(`${PANEL} >> .badge`)).toHaveText("Ready");

		// The same conversion delivered as a lone .astro is not drop-in.
		await action(page, "Copy .astro").click();
		await expect(page.locator(`${PANEL} >> .badge`)).toHaveText("Draft");
		await expect(page.locator(`${PANEL} >> .reasons`)).toContainText("Download ZIP");

		// The file must agree with the badge, not claim it builds on its own.
		const clipboard = await page.evaluate(() => navigator.clipboard.readText());
		expect(clipboard).not.toContain("Ready: builds as-is");
		expect(clipboard).toContain("Draft — needs attention before shipping:");
	});

	test("drops a stale verdict as soon as a Get code setting changes", async () => {
		const page = await open(context, STITCH.notFound);

		await kitSelect(page).selectOption("decap");
		await page.locator("#link-0").fill("/about");
		await page.locator("#link-1").fill("/contact");

		await action(page, "Download .astro").click();
		await expect(page.locator(`${PANEL} >> .badge`)).toHaveText("Ready");

		// Editing a route in Get code invalidates that verdict; it must not linger.
		await page.locator("#link-0").fill("/reviews");
		await expect(page.locator(`${PANEL} >> .badge`)).toHaveCount(0);
		await expect(page.locator("#link-0")).toBeFocused();

		// The same applies to the file name.
		await action(page, "Download .astro").click();
		await expect(page.locator(`${PANEL} >> .badge`)).toHaveCount(1);
		await page.locator("#file-name").fill("Renamed");
		await expect(page.locator(`${PANEL} >> .badge`)).toHaveCount(0);
	});

	test("stands in for the dark mode box CodeStitch disables on 2501", async () => {
		await grantClipboard(context);
		const page = await open(context, STITCH.notFound);

		// The stitch has CSS dark styles, but CodeStitch's data marks them as
		// not dark, so its box is disabled under CSS.
		await expect(page.locator("#dark-styles")).toBeDisabled();
		const dark = toggle(page, "Dark mode styles");
		await expect(dark.locator("input")).toBeChecked();
		expect(await copy(page)).toContain("body.dark-mode");

		await dark.locator("input").uncheck();
		expect(await copy(page)).not.toContain("body.dark-mode");

		// Under LESS, Get code's own box works and the stand-in goes away.
		await page.locator('#flavours [data-id="less"]').click();
		await expect(dark).toHaveCount(0);
	});

	test("stands in for Styles and File name under the Shopify format", async () => {
		await grantClipboard(context);
		const page = await open(context, STITCH.notFound, { stubPrefs: { flavour: "less" } });

		await page.locator('#formats [data-id="shopify"]').click();
		// Get code keeps CSS pressed and enabled, and disables the others.
		await expect(page.locator('#flavours [data-id="css"]')).toBeEnabled();
		await expect(page.locator('#flavours [data-id="less"]')).toBeDisabled();
		await expect(page.locator("#file-row")).toBeHidden();

		const styles = page.locator(`${PANEL} >> .field`, { hasText: "Styles" }).locator("select");
		await expect(styles).toHaveValue("less");
		const name = page.locator(`${PANEL} >> .field`, { hasText: "File name" }).locator("input");
		await name.fill("Shop-Hero");

		expect(await copy(page)).toContain('<style lang="less"');
		const downloadPromise = page.waitForEvent("download");
		await action(page, "Download .astro").click();
		expect((await downloadPromise).suggestedFilename()).toBe("Shop-Hero.astro");
	});

	test("works on its own defaults when Get code's controls never render", async () => {
		const page = await open(context, STITCH.notFound, { hostScript: false });

		await expect(page.locator(`${PANEL} >> .host-summary`)).toContainText("Get code settings not detected");
		await expect(page.locator(`${PANEL} >> .field`, { hasText: "Styles" }).locator("select")).toHaveValue("less");
		const routes = page.locator(`${PANEL} >> .link-row input`);
		await expect(routes).toHaveCount(2);
		await expect(routes.nth(0)).toHaveValue("/return-to-home");
	});

	test("pairs Get code's link fields by position, not by label", async () => {
		await grantClipboard(context);
		const html = [
			'<section id="links-3001">',
			'<!-- <a href="">About</a> -->',
			'<a href="" class="cs-link">About</a>',
			'<a href="" class="cs-button"><span>Get</span><span>Started</span></a>',
			'<a href="#" class="cs-link">Hash</a>',
			"</section>",
		].join("\n");
		const codes: StubCode[] = [
			{ typeName: "HTML", type: "html", content: html },
			{ typeName: "CSS", type: "css", content: "#links-3001 { color: red; }" },
		];
		const page = await open(context, "3001", {
			pages: { "3001": getCodePage({ id: 3001, codes, bodyExtra: `<script src="${GET_CODE_SCRIPT}"></script>` }) },
		});

		// Get code lists the commented-out About first.
		await expect(page.locator("#link-rows label")).toHaveText(["About", "About", "Get Started"]);
		await page.locator("#link-0").fill("/commented");
		await page.locator("#link-1").fill("/real-about");
		await page.locator("#link-2").fill("/start");

		const clipboard = await copy(page);
		expect(clipboard).toContain('getLocalizedRoute(locale, "/real-about/")');
		expect(clipboard).toContain('getLocalizedRoute(locale, "/start/")');
		expect(clipboard).not.toContain("/commented");
		// The "#" link is not in Get code's list, so the panel lists it.
		await expect(page.locator(`${PANEL} >> .link-row label`)).toHaveText(["Hash"]);
	});

	test("fills an empty social link from the kit only when asked, and never after it was cleared", async () => {
		await grantClipboard(context);
		const html =
			'<section id="soc-3002"><a href="" class="cs-social" aria-label="visit facebook profile">' +
			'<img alt="facebook" src="https://csimg.nyc3.cdn.digitaloceanspaces.com/f.svg"></a></section>';
		const pageHtml = getCodePage({
			id: 3002,
			codes: [
				{ typeName: "HTML", type: "html", content: html },
				{ typeName: "CSS", type: "css", content: "#soc-3002 { color: red; }" },
			],
			bodyExtra: `<script src="${GET_CODE_SCRIPT}"></script>`,
		});
		const page = await open(context, "3002", { pages: { "3002": pageHtml } });
		const choice = page.locator('#link-rows .gc-link-row[data-i="0"] [data-componentize] input');

		// Off by default: a TODO and a Draft that says where to opt in.
		await expect(choice).not.toBeChecked();
		let clipboard = await copy(page);
		expect(clipboard).toContain("TODO: set the destination");
		await expect(page.locator(`${PANEL} >> .reasons`)).toContainText("use BUSINESS.socials.facebook");

		await choice.check();
		clipboard = await copy(page);
		expect(clipboard).toContain("href={BUSINESS.socials.facebook}");

		// A typed URL wins, and voids the opt-in...
		await page.locator("#link-0").fill("https://facebook.com/acme");
		await expect(choice).toHaveCount(0);
		// ...so clearing it again, even across Get code's re-render, gives a TODO.
		await page.locator("#link-0").fill("");
		await page.locator('#flavours [data-id="css"]').click();
		await expect(choice).not.toBeChecked();
		clipboard = await copy(page);
		expect(clipboard).toContain("TODO: set the destination");
		expect(clipboard).not.toContain("href={BUSINESS.socials.facebook}");

		// A ticked choice survives a reload of the same stitch.
		await choice.check();
		await page.waitForTimeout(600); // debounce window
		await page.reload();
		await expect(page.locator('#link-rows [data-componentize] input')).toBeChecked();
	});

	test("checks localized routes and fragments the way conversion writes them", async () => {
		await grantClipboard(context);
		const page = await open(context, STITCH.notFound);

		await page.locator("#link-0").fill("/fr/a-propos");
		await page.locator("#link-1").fill("#contact");
		await expect(page.locator('#link-rows .gc-link-row[data-i="0"] [data-componentize]')).toHaveCount(0);

		const clipboard = await copy(page);
		expect(clipboard).toContain('getLocalizedRoute(locale, "/about/")');
		expect(clipboard).toContain('href="#contact"');
	});

	test("never delivers a build whose settings changed while it ran", async () => {
		const page = await open(context, STITCH.faq, { cdnDelayMs: 2_000 });
		await page.locator('#image-modes [data-id="local"]').click();
		const downloads: string[] = [];
		page.on("download", (d) => downloads.push(d.suggestedFilename()));

		await action(page, "Download ZIP").click();
		await expect(page.locator(`${PANEL} >> .status`)).toContainText("Building");
		await page.locator("#file-name").fill("Changed");
		await expect(page.locator(`${PANEL} >> .status`)).toContainText("Settings changed while building", {
			timeout: 20_000,
		});
		expect(downloads).toEqual([]);
		await expect(page.locator(`${PANEL} >> .badge`)).toHaveCount(0);
	});

	test("is not cancelled by a click that changes nothing", async () => {
		const page = await open(context, STITCH.faq, { cdnDelayMs: 1_000 });
		await page.locator('#image-modes [data-id="local"]').click();

		const downloadPromise = page.waitForEvent("download", { timeout: 45_000 });
		await action(page, "Download ZIP").click();
		await expect(page.locator(`${PANEL} >> .status`)).toContainText("Building");
		await page.locator("#file-name").click();
		await page.locator('#image-modes [data-id="local"]').click();
		const download = await downloadPromise;
		expect(download.suggestedFilename()).toMatch(/^Faq-1741/);
		// Let the file finish saving, or closing the browser waits on it.
		expect(await download.path()).toBeTruthy();
	});

	test("drops a build in flight when the dashboard moves to another stitch", async () => {
		const page = await open(context, STITCH.faq, { cdnDelayMs: 2_000 });
		await page.locator('#image-modes [data-id="local"]').click();
		const downloads: string[] = [];
		page.on("download", (d) => downloads.push(d.suggestedFilename()));
		const errors: string[] = [];
		page.on("pageerror", (e) => errors.push(e.message));

		await action(page, "Download ZIP").click();
		await expect(page.locator(`${PANEL} >> .status`)).toContainText("Building");
		await renderStitchClientSide(page, STITCH.notFound);
		await expect(page.locator(`${PANEL} >> .subtitle`)).toContainText("Stitch #2501", { timeout: 15_000 });
		await page.waitForTimeout(3_000);

		expect(downloads).toEqual([]);
		expect(errors).toEqual([]);
	});

	test("re-mounts itself when the dashboard navigates to another stitch", async () => {
		const page = await context.newPage();
		await serveFixture(context, [STITCH.notFound, STITCH.faq]);
		await page.goto(stitchUrl(STITCH.notFound));
		await expect(page.locator(`${PANEL} >> .subtitle`)).toContainText("Stitch #2501");

		await renderStitchClientSide(page, STITCH.faq);
		await expect(page.locator(`${PANEL} >> .subtitle`)).toContainText("Stitch #1741", { timeout: 15_000 });
	});

	test("says so when the stitch's code is empty", async () => {
		const page = await context.newPage();
		await serveFixture(context, [], {
			pages: { [STITCH.notFound]: getCodePage({ id: 2501, codes: [{ typeName: "HTML", type: "html", content: "" }] }) },
		});
		await page.goto(stitchUrl(STITCH.notFound));

		await expect(page.locator(`${PANEL} >> .error`)).toContainText("premium stitch, or you are not signed in");
	});

	test("labels every control for assistive technology", async () => {
		const page = await open(context, STITCH.notFound, { hostScript: false });

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
		await expect(page.locator(`${PANEL} >> .status`)).toHaveAttribute("aria-live", "polite");
	});

	test("targets the current Advanced kit by default, and names the version", async () => {
		const page = await open(context, STITCH.faq);

		await expect(kitSelect(page)).toHaveValue("advanced-v4");
		// The subtitle has to say which kit a verdict is about, by version.
		await expect(page.locator(`${PANEL} >> .subtitle`)).toContainText(V4_PROFILE.label);
		await expect(page.locator(`${PANEL} >> .subtitle`)).toContainText(V4_PROFILE.sha.slice(0, 8));

		// Both Advanced versions are offered, each named.
		await expect(kitSelect(page).locator("option")).toHaveText([
			"Advanced Astro v4",
			"Advanced Astro v3.0.2 (legacy)",
			"Intermediate Astro + Decap",
		]);
	});

	test("keeps a saved target rather than moving it to the new default", async () => {
		const page = await open(context, STITCH.notFound);

		// Someone already generating for the older Advanced kit.
		await kitSelect(page).selectOption("i18n");
		await page.waitForTimeout(600); // debounce window

		const second = await context.newPage();
		await second.goto(stitchUrl(STITCH.notFound));

		await expect(kitSelect(second)).toHaveValue("i18n");
		await expect(second.locator(`${PANEL} >> .subtitle`)).toContainText("Advanced Astro v3.0.2 (legacy)");
	});

	test("the multilingual setting applies to v4 only, and decides the locale files", async () => {
		const page = await open(context, STITCH.faq);

		const multilingual = toggle(page, "Multiple languages");
		await expect(multilingual.locator("input")).toBeEnabled();
		await expect(multilingual.locator("input")).toBeChecked();

		// The older Advanced kit has no single-language setup to describe.
		await kitSelect(page).selectOption("i18n");
		await expect(multilingual.locator("input")).toBeDisabled();

		await kitSelect(page).selectOption("advanced-v4");
		await multilingual.locator("input").uncheck();

		const downloadPromise = page.waitForEvent("download");
		await action(page, "Download ZIP").click();
		const entries = unzipSync(new Uint8Array(readFileSync((await (await downloadPromise).path())!)));
		const locales = Object.keys(entries).filter((n) => n.startsWith("src/locales/"));

		// Only the default locale, and nothing left to translate.
		expect(locales).toEqual(["src/locales/en/faq1741.json"]);
		await expect(page.locator(`${PANEL} >> .reasons`)).not.toContainText("translate");
	});

	test("a v4 component reads its copy from content and resolves its links", async () => {
		await grantClipboard(context);
		const page = await open(context, STITCH.faq);

		await page.locator("#link-0").fill("/about");
		const clipboard = await copy(page);
		expect(clipboard).toContain('import { getSiteContext } from "@js/getSiteContext"');
		expect(clipboard).toContain("content.faq1741.");
		expect(clipboard).toContain('href={getLocalizedRoute(locale, "/about/")}');
		// The helpers v4 replaced must not appear.
		expect(clipboard).not.toContain("@js/translationUtils");
	});

	test("remembers preferences across page loads, and only its own", async () => {
		const page = await open(context, STITCH.notFound);

		await kitSelect(page).selectOption("decap");
		await page.waitForTimeout(600); // debounce window

		const second = await context.newPage();
		await second.goto(stitchUrl(STITCH.notFound));
		await expect(kitSelect(second)).toHaveValue("decap");

		// Settings Get code owns are not stored a second time.
		const [worker] = context.serviceWorkers();
		const stored = await worker!.evaluate(() => chrome.storage.sync.get("componentize:prefs"));
		expect(Object.keys((stored as Record<string, object>)["componentize:prefs"]!).sort()).toEqual([
			"i18n",
			"includeCoreStyles",
			"kit",
			"multilingual",
		]);
	});

	test("stays out of the way on a stitch's live preview", async () => {
		// /stitches/<id>/rendered shows the stitch itself and has no code.
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

	test("does not inject on marketing, login, catalog, nested, or unrelated pages", async () => {
		const urls = [
			"https://codestitch.app/",
			"https://app.codestitch.app/login",
			"https://app.codestitch.app/app/dashboard/catalog/3",
			`${stitchUrl(STITCH.notFound)}/figma`,
			"https://example.com/app/dashboard/stitches/2501",
		];
		await context.route("**/*", async (route) => {
			if (urls.includes(route.request().url())) {
				await route.fulfill({
					status: 200,
					contentType: "text/html",
					body: "<html><body><h1>fixture</h1></body></html>",
				});
				return;
			}
			await route.abort();
		});

		for (const url of urls) {
			const page = await context.newPage();
			await page.goto(url);
			await page.waitForTimeout(400);
			expect(await page.locator("#componentize-root").count(), url).toBe(0);
		}
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

		await expect(page.locator(`${PANEL} >> .error`)).toContainText("CodeStitch changed its page layout");
	});

	/*
	 * The one test that talks to the real site, to catch the day the stub and
	 * CodeStitch disagree. Opt-in: `E2E_LIVE=1 npx playwright test -g "live:"`.
	 */
	test("live: follows edits made in the real Get code screen", async () => {
		test.skip(!process.env["E2E_LIVE"], "set E2E_LIVE=1 to run against codestitch.app");
		const page = await context.newPage();
		await page.goto(stitchUrl(STITCH.notFound));
		await expect(page.locator(PANEL)).toBeVisible({ timeout: 30_000 });
		await expect(page.locator(`${PANEL} >> .host-summary`)).toContainText("From Get code");

		await page.locator("#file-name").fill("LiveName");
		const astro = page.waitForEvent("download");
		await action(page, "Download .astro").click();
		expect((await astro).suggestedFilename()).toBe("LiveName.astro");

		await page.locator('#image-modes [data-id="local"]').click();
		await expect(page.locator(`${PANEL} >> .host-summary`)).toContainText("src/assets/images/not-found");
		const zip = page.waitForEvent("download", { timeout: 60_000 });
		await action(page, "Download ZIP").click();
		const entries = unzipSync(new Uint8Array(readFileSync((await (await zip).path())!)));
		expect(Object.keys(entries).some((n) => n.startsWith("src/assets/images/not-found/"))).toBe(true);
	});
});
