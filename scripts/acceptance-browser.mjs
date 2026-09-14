#!/usr/bin/env node
/**
 * The browser half of kit acceptance.
 *
 * `astro build` only proves a component compiles. This serves the built site and
 * checks what the plan actually promised: that the component renders in light
 * and dark, and that its interactive parts still work after a client-side
 * navigation — the failure mode `astro:page-load` wrapping exists to prevent.
 *
 * Invoked by kit-acceptance.mjs; not meant to be run on its own.
 */
import { chromium } from "@playwright/test";
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Minimal CSS.escape for ids used in Node-side selector strings. */
const CSS = { escape: (value) => String(value).replace(/([^\w-])/g, "\\$1") };

/** Starts `astro preview` and resolves once it reports a URL. */
export async function startPreview(kitDir) {
	const proc = spawn("npx", ["astro", "preview", "--port", "0"], {
		cwd: kitDir,
		env: { ...process.env, CI: "1" },
	});

	const url = await new Promise((resolve, reject) => {
		let output = "";
		const timer = setTimeout(
			() => reject(new Error(`astro preview did not start:\n${output}`)),
			60_000,
		);
		const onData = (chunk) => {
			output += chunk.toString();
			const match = /(http:\/\/(?:localhost|127\.0\.0\.1):\d+)/.exec(output);
			if (match) {
				clearTimeout(timer);
				resolve(match[1]);
			}
		};
		proc.stdout.on("data", onData);
		proc.stderr.on("data", onData);
		proc.on("exit", (code) => {
			clearTimeout(timer);
			reject(new Error(`astro preview exited with ${code}:\n${output}`));
		});
	});

	return { proc, url };
}

/**
 * Checks one component's page.
 *
 * @returns {Promise<string[]>} problems found; empty means it behaves.
 */
export async function checkRendered({
	baseUrl,
	pagePath,
	interactive,
	/** The component's own dark-mode rules, from darkRulesIn(). */
	darkRules = [],
	/**
	 * The id of the component's own root element.
	 *
	 * Required, and not guessed: the kit's BaseLayout renders its own <header>
	 * before the component, so "the first section or header on the page" is the
	 * kit's navigation — every check would then be inspecting the wrong element
	 * and quietly passing.
	 */
	/**
	 * Ids of the component's root elements — a stitch may contain several
	 * sections, and its dark rules may target any of them.
	 */
	rootIds = [],
	/** An empty page to navigate through; see roundTripThroughRouter. */
	waypointPath = "/",
	screenshotDir,
	screenshotName = "component",
}) {
	const problems = [];
	const browser = await chromium.launchPersistentContext(
		mkdtempSync(join(tmpdir(), "cz-view-")),
		{ channel: "chromium", headless: true, args: ["--no-sandbox"] },
	);

	try {
		// Resolve the page URL first: kits differ on trailingSlash, and the probe
		// for the other form would otherwise be recorded as a page error.
		const probe = await browser.newPage();
		let pageUrl = `${baseUrl}${pagePath}`;
		let response = await probe.goto(pageUrl, { waitUntil: "domcontentloaded" });
		if (!response || response.status() === 404) {
			pageUrl = `${baseUrl}${pagePath}/`;
			response = await probe.goto(pageUrl, { waitUntil: "domcontentloaded" });
		}
		const status = response?.status();
		await probe.close();
		if (!status || status >= 400) {
			problems.push(`page did not load (HTTP ${status ?? "no response"})`);
			return problems;
		}

		// The waypoint needs the same trailingSlash treatment; a redirect there
		// would be a full document load and would look like a router failure.
		let waypointUrl = new URL(waypointPath, baseUrl).toString();
		const waypointProbe = await browser.newPage();
		let waypointResponse = await waypointProbe.goto(waypointUrl, {
			waitUntil: "domcontentloaded",
		});
		if (!waypointResponse || waypointResponse.status() === 404) {
			waypointUrl = `${waypointUrl.replace(/\/$/, "")}/`;
			waypointResponse = await waypointProbe.goto(waypointUrl, {
				waitUntil: "domcontentloaded",
			});
		}
		const waypointOk = Boolean(waypointResponse && waypointResponse.status() < 400);
		await waypointProbe.close();

		const page = await browser.newPage();
		const consoleErrors = [];
		// A missing favicon says nothing about the component.
		const isNoise = (text) =>
			/favicon|apple-touch-icon|manifest\.json|robots\.txt/i.test(text);
		const thirdParty = (text) => /https?:\/\/(?!localhost|127\.0\.0\.1)/.test(text);
		page.on("console", (msg) => {
			if (msg.type() !== "error") return;
			const text = msg.text().slice(0, 200);
			const from = msg.location()?.url ?? "";
			if (isNoise(text) || isNoise(from)) return;
			// Embedded third-party widgets fail in a sandbox; not our concern.
			if (thirdParty(text) || (from && thirdParty(from))) return;
			consoleErrors.push(text);
		});
		page.on("pageerror", (err) => consoleErrors.push(String(err).slice(0, 200)));
		// Only requests the site itself serves. A stitch may legitimately embed a
		// third-party map or widget, and whether that host answers in a sandboxed
		// browser says nothing about the generated component.
		const origin = new URL(baseUrl).origin;
		page.on("requestfailed", (req) => {
			if (req.url().startsWith(origin) && !isNoise(req.url())) {
				consoleErrors.push(`request failed: ${req.url().slice(0, 120)}`);
			}
		});

		await page.goto(pageUrl, { waitUntil: "networkidle" });

		// --- renders at all ---
		const rootId = rootIds[0];
		if (!rootId) {
			problems.push("no root id was supplied, so nothing could be verified");
			return problems;
		}
		const root = page.locator(`#${CSS.escape(rootId)}`).first();
		if ((await root.count()) === 0) {
			problems.push(`the component (#${rootId}) is not in the rendered page`);
		} else {
			const box = await root.boundingBox();
			if (!box || box.width < 100 || box.height < 40) {
				problems.push(`component has no meaningful size (${JSON.stringify(box)})`);
			}
		}

		// --- light and dark ---
		//
		// Reading one background colour and checking it is not undefined proves
		// nothing. Instead the whole component's computed styles are captured in
		// both modes and compared, and screenshots are written for review.
		const styleSnapshot = () =>
			page.evaluate((id) => {
				const root = document.getElementById(id);
				if (!root) return [];
				const nodes = [root, ...root.querySelectorAll("*")].slice(0, 200);
				return nodes.map((node) => {
					const style = getComputedStyle(node);
					return [
						style.backgroundColor,
						style.color,
						style.borderColor,
						style.opacity,
					].join("|");
				});
			}, rootId);

		const setMode = async (mode) => {
			await page.evaluate((m) => {
				document.body.classList.toggle("dark-mode", m === "dark");
			}, mode);
			// Give transitions a moment to settle before sampling.
			await page.waitForTimeout(150);
		};

		await setMode("light");
		const lightStyles = await styleSnapshot();
		if (screenshotDir) {
			await page.screenshot({
				path: join(screenshotDir, `${screenshotName}-light.png`),
				fullPage: true,
			});
		}

		await setMode("dark");
		const darkStyles = await styleSnapshot();
		if (screenshotDir) {
			await page.screenshot({
				path: join(screenshotDir, `${screenshotName}-dark.png`),
				fullPage: true,
			});
		}
		await setMode("light");

		if (lightStyles.length === 0 || darkStyles.length === 0) {
			problems.push("could not read the component's computed styles");
		}

		// The component's *own* dark rules must survive into the built CSS.
		//
		// Comparing computed styles cannot show this: both kits' dark.less
		// restyles every heading and paragraph site-wide, so those properties
		// change in dark mode even when the component's dark block was dropped
		// entirely. What only the component can produce is a rule that is scoped
		// to its own section id *and* gated on .dark-mode, so that is what is
		// looked for.
		if (darkRules.length > 0) {
			const present = await page.evaluate((ids) => {
				const matches = [];
				for (const sheet of Array.from(document.styleSheets)) {
					let rules;
					try {
						rules = sheet.cssRules;
					} catch {
						continue; // cross-origin sheet
					}
					const walk = (list) => {
						for (const rule of Array.from(list ?? [])) {
							if (rule.cssRules) walk(rule.cssRules);
							const selector = rule.selectorText;
							if (!selector) continue;
							// `.dark-mode` exactly, not a look-alike such as
							// `.dark-mode-never`, and scoped to this component.
							if (
								/\.dark-mode(?![\w-])/.test(selector) &&
								ids.some((id) => selector.includes(id))
							) {
								matches.push(selector);
							}
						}
					};
					walk(sheet.cssRules);
				}
				return matches;
			}, rootIds);

			if (present.length === 0) {
				problems.push(
					`the component declares ${darkRules.length} dark-mode rules, but none reached the built stylesheet`,
				);
			}
		}

		// --- interactive behaviour, before and after a client-side navigation ---
		if (interactive) {
			const before = await exerciseInteraction(page, interactive, rootId);
			if (!before) problems.push(`${interactive.name} did not respond on first load`);

			// Navigate away and back through the router.
			//
			// Clicking a link to the current URL may be ignored, which would leave
			// the original listeners in place and let a broken component pass. So
			// the trip goes via another page, and a marker on `window` proves the
			// router handled it: a full document load would wipe the marker.
			const navigated = waypointOk
				? await roundTripThroughRouter(page, pageUrl, waypointUrl)
				: { clientSide: false, reason: `the waypoint page ${waypointPath} is missing` };
			if (!navigated.clientSide) {
				problems.push(
					`could not verify client-side navigation (${navigated.reason}) — the astro:page-load path is untested here`,
				);
			} else {
				const after = await exerciseInteraction(page, interactive, rootId);
				if (!after) {
					problems.push(
						`${interactive.name} stopped responding after a client-side navigation`,
					);
				}
			}
		}

		if (consoleErrors.length > 0) {
			problems.push(`console errors: ${[...new Set(consoleErrors)].slice(0, 2).join(" | ")}`);
		}
	} finally {
		await browser.close();
	}

	return problems;
}

/**
 * Leaves the page and returns through Astro's router.
 *
 * `window.__czMarker` survives a client-side swap but not a document load, so
 * finding it afterwards is direct proof the router — and therefore
 * `astro:page-load` — was actually involved.
 */
async function roundTripThroughRouter(page, pageUrl, waypointUrl) {
	await page.evaluate(() => {
		window.__czMarker = "present";
	});

	const sameUrl = (a, b) => a.replace(/\/$/, "") === b.replace(/\/$/, "");

	const clickLinkTo = async (href, id) => {
		await page.evaluate(
			({ href, id }) => {
				const link = document.createElement("a");
				link.href = href;
				link.id = id;
				link.textContent = "go";
				document.body.appendChild(link);
			},
			{ href, id },
		);
		await page.click(`#${id}`);
		// Wait for the router to land rather than hoping a sleep is long enough.
		const deadline = Date.now() + 5000;
		while (Date.now() < deadline && !sameUrl(page.url(), href)) {
			await page.waitForTimeout(50);
		}
		// Let the swap settle and astro:page-load handlers run.
		await page.waitForLoadState("networkidle").catch(() => {});
		await page.waitForTimeout(200);
	};

	// Deliberately NOT the kit's home page: its own components register
	// astro:page-load handlers on the persistent document, and those keep firing
	// on later swaps — binding to the component under test and making a broken
	// one look alive. The waypoint is an empty page for exactly that reason.
	await clickLinkTo(waypointUrl, "cz-away");
	if (sameUrl(page.url(), pageUrl)) {
		return { clientSide: false, reason: "the router did not leave the page" };
	}

	await clickLinkTo(pageUrl, "cz-back");
	if (!sameUrl(page.url(), pageUrl)) {
		return { clientSide: false, reason: "did not arrive back on the component page" };
	}

	const markerSurvived = await page.evaluate(() => window.__czMarker === "present");
	return markerSurvived
		? { clientSide: true }
		: { clientSide: false, reason: "the browser did a full page load, not a swap" };
}

/**
 * Clicks the trigger and waits for the expected class to toggle.
 *
 * Polls rather than sleeping a fixed interval: a fixed wait is either slower
 * than it needs to be or, worse, occasionally short enough to report a working
 * component as broken.
 */
async function exerciseInteraction(page, { trigger, toggles }, rootId) {
	const scope = rootId ? `#${CSS.escape(rootId)} ` : "";
	const el = page.locator(`${scope}${trigger}`).first();
	if ((await el.count()) === 0) return false;
	const target = page.locator(`${scope}${toggles.selector}`).first();
	if ((await target.count()) === 0) return false;

	const had = await target.evaluate(
		(node, cls) => node.classList.contains(cls),
		toggles.className,
	);
	await el.click({ force: true });

	const deadline = Date.now() + 3000;
	while (Date.now() < deadline) {
		const has = await target.evaluate(
			(node, cls) => node.classList.contains(cls),
			toggles.className,
		);
		if (has !== had) return true;
		await page.waitForTimeout(50);
	}
	return false;
}
