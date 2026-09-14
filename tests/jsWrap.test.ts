import { describe, expect, it } from "vitest";
import { looksLikeKitNavScript, wrapJs } from "@core/js/wrap";
import { profileFor } from "@core/kits/profile";
import { WarningCollector } from "@core/readiness";
import { FIXTURE_DIRS, loadFixture } from "./helpers/loadFixture";

function run(
	js: string,
	{ isNav = false, kit = "decap" as const, keepKitNavScript = false } = {},
) {
	const warnings = new WarningCollector();
	const result = wrapJs(js, {
		profile: profileFor(kit),
		warnings,
		isNav,
		keepKitNavScript,
	});
	return { ...result, collector: warnings };
}

describe("wrapJs", () => {
	it("wraps element-scoped listeners without an AbortController", () => {
		const stitch = loadFixture(FIXTURE_DIRS.faq);
		const { script, collector } = run(stitch.js!);

		expect(script).toContain('document.addEventListener("astro:page-load"');
		expect(script).toContain("item.addEventListener('click', onClick)");
		// Elements are replaced on swap, so their listeners need no cleanup.
		expect(script).not.toContain("AbortController");
		expect(collector.warnings.filter((w) => w.severity === "draft")).toEqual([]);
	});

	it("adds an aborting controller for document/window listeners", () => {
		const js = `
document.addEventListener("keydown", onKey);
window.addEventListener("resize", onResize);
`;
		const { script, collector } = run(js);

		expect(script).toContain("componentController?.abort()");
		expect(script).toContain("componentController = new AbortController()");
		expect(script).toContain("const { signal } = componentController");
		expect(script).toContain('document.addEventListener("keydown", onKey, { signal })');
		expect(script).toContain('window.addEventListener("resize", onResize, { signal })');
		expect(collector.warnings.filter((w) => w.severity === "draft")).toEqual([]);
	});

	it("merges signal into an existing options object", () => {
		const js = `document.addEventListener("scroll", onScroll, { passive: true });`;
		const { script } = run(js);
		expect(script).toContain("{ passive: true, signal }");
		expect(script).not.toContain("}, { signal })");
	});

	it("converts the legacy useCapture boolean into an options object", () => {
		const js = `document.addEventListener("focusin", onFocus, true);`;
		const { script } = run(js);
		expect(script).toContain("{ capture: true, signal }");
	});

	it("fills an empty options object rather than nesting one", () => {
		const js = `window.addEventListener("resize", onResize, {});`;
		const { script } = run(js);
		expect(script).toContain("onResize, { signal })");
	});

	it("refuses to guess when listener options are computed, and says so", () => {
		const js = `document.addEventListener("click", onClick, opts);`;
		const { script, collector } = run(js);

		// Source is preserved verbatim — no silent semantic change.
		expect(script).toContain("onClick, opts)");
		expect(script).not.toContain("signal");
		expect(collector.has("js-cleanup-unwired")).toBe(true);
	});

	it("flags timers and observers that outlive a navigation", () => {
		const js = `
setInterval(tick, 1000);
const io = new IntersectionObserver(onIntersect);
`;
		const { collector } = run(js);
		const leak = collector.warnings.find((w) => w.code === "js-leaky-api");
		expect(leak?.severity).toBe("draft");
		expect(leak?.message).toContain("setInterval");
		expect(leak?.message).toContain("IntersectionObserver");
	});

	it("keeps hand-written astro:page-load scripts untouched", () => {
		const js = `document.addEventListener("astro:page-load", () => { init(); });`;
		const { script, collector } = run(js);
		expect(script).toContain("init()");
		expect(collector.has("js-already-wrapped")).toBe(true);
	});

	it("passes unparseable JS through verbatim and marks it Draft", () => {
		const js = `const x = ;;;(((`;
		const { script, collector } = run(js);
		expect(script).toContain("const x = ;;;(((");
		expect(collector.has("js-cleanup-unwired")).toBe(true);
	});

	it("recognises the kit's own nav script and leaves it out", () => {
		const stitch = loadFixture(FIXTURE_DIRS.nav);
		const { script, suppressed, collector } = run(stitch.js!, { isNav: true });

		expect(suppressed).toBe(true);
		expect(script).toBeUndefined();
		expect(collector.has("nav-js-suppressed")).toBe(true);
	});

	it("keeps the kit's nav script when told to, and marks the result Draft", () => {
		const stitch = loadFixture(FIXTURE_DIRS.nav);
		const { script, suppressed, collector } = run(stitch.js!, {
			isNav: true,
			keepKitNavScript: true,
		});

		expect(suppressed).toBe(false);
		expect(script).toContain('document.addEventListener("astro:page-load"');
		// The nav script binds document/window listeners, so it gets the controller.
		expect(script).toContain("componentController = new AbortController()");
		expect(script).toContain("cs-toggle");

		const duplicate = collector.warnings.find((w) => w.code === "nav-js-duplicate");
		expect(duplicate?.severity).toBe("draft");
		expect(duplicate?.message).toContain("nav.js");
		expect(collector.has("nav-js-suppressed")).toBe(false);
		expect(collector.has("nav-js-kept")).toBe(false);
	});

	it("ignores the override on a script that does not duplicate the kit's nav", () => {
		const { collector } = run(loadFixture(FIXTURE_DIRS.faq).js!, {
			keepKitNavScript: true,
		});
		expect(collector.has("nav-js-duplicate")).toBe(false);
		expect(collector.warnings.filter((w) => w.severity === "draft")).toEqual([]);
	});

	it("keeps unfamiliar nav JS instead of suppressing it blindly", () => {
		const js = `const el = document.querySelector(".my-custom-widget"); el.addEventListener("click", spin);`;
		const { script, suppressed, collector } = run(js, { isNav: true });

		expect(suppressed).toBe(false);
		expect(script).toContain("my-custom-widget");
		expect(collector.has("nav-js-kept")).toBe(true);
	});

	it("matches the real nav stitch against both kits' nav scripts", () => {
		const stitch = loadFixture(FIXTURE_DIRS.nav);
		expect(looksLikeKitNavScript(stitch.js!, profileFor("decap"))).toBe(true);
		expect(looksLikeKitNavScript(stitch.js!, profileFor("i18n"))).toBe(true);
		// A FAQ accordion must never be mistaken for the nav script.
		expect(
			looksLikeKitNavScript(loadFixture(FIXTURE_DIRS.faq).js!, profileFor("decap")),
		).toBe(false);
	});
});
