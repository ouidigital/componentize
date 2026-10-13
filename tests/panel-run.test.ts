import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mountPanel, stubChromeStorage, until } from "./helpers/panelHarness";
import { click, typeInto } from "./helpers/hostPage";

/*
 * The panel builds, then delivers. Settings in CodeStitch's inspector stay
 * editable the whole time, so a build must never hand over, or show a verdict
 * for, settings that have since changed. The output primitives are mocked so
 * each step can be held open: the panel composes them itself, which is what
 * makes this mock effective (a same-module call would bypass it).
 */
const zip = vi.hoisted(() => ({ pending: [] as Array<(b: Blob) => void> }));
const clip = vi.hoisted(() => ({ pending: [] as Array<() => void> }));

vi.mock("@output/index", () => ({
	buildZip: vi.fn(() => new Promise<Blob>((resolve) => zip.pending.push(resolve))),
	zipFileName: vi.fn((r: { componentName: string }) => `${r.componentName}.zip`),
	astroBlob: vi.fn((s: string) => new Blob([s])),
	astroFileName: vi.fn((r: { componentName: string }) => `${r.componentName}.astro`),
	downloadBlob: vi.fn(),
	copyToClipboard: vi.fn(() => new Promise<void>((resolve) => clip.pending.push(resolve))),
}));

import * as output from "@output/index";

beforeEach(() => {
	stubChromeStorage();
	zip.pending.length = 0;
	clip.pending.length = 0;
	vi.mocked(output.downloadBlob).mockClear();
});
afterEach(() => {
	document.documentElement.innerHTML = "<head></head><body></body>";
});

describe("the delivery guard", () => {
	it("delivers when nothing changed (the control case)", async () => {
		const p = await mountPanel();
		p.button("Download ZIP").click();
		await until(() => zip.pending.length === 1, "the ZIP build");
		zip.pending[0]!(new Blob(["zip"]));
		await until(() => !p.status().includes("Building"), "the run to finish");

		expect(output.downloadBlob).toHaveBeenCalledTimes(1);
		expect(vi.mocked(output.downloadBlob).mock.calls[0]![1]).toBe("Not-found-2501.zip");
		expect(p.badge()).toMatch(/Draft|Ready/);
	});

	it("holds back a ZIP whose settings changed while it was being compressed", async () => {
		const p = await mountPanel();
		p.button("Download ZIP").click();
		await until(() => zip.pending.length === 1, "the ZIP build");

		typeInto("#link-0", "/about");
		zip.pending[0]!(new Blob(["zip"]));
		await until(() => !p.status().includes("Building"), "the run to finish");

		expect(output.downloadBlob).not.toHaveBeenCalled();
		expect(p.badge()).toBe("");
		expect(p.status()).toMatch(/Settings changed while building/);
	});

	it("is not cancelled by a click that changes nothing", async () => {
		const p = await mountPanel();
		p.button("Download ZIP").click();
		await until(() => zip.pending.length === 1, "the ZIP build");

		click("#file-name");
		click('#flavours [data-id="css"]'); // already selected
		zip.pending[0]!(new Blob(["zip"]));
		await until(() => !p.status().includes("Building"), "the run to finish");

		expect(output.downloadBlob).toHaveBeenCalledTimes(1);
	});

	it("never restores an outdated verdict when a copy completes late", async () => {
		const p = await mountPanel();
		p.button("Copy .astro").click();
		await until(() => clip.pending.length === 1, "the clipboard write");

		click('#flavours [data-id="less"]');
		clip.pending[0]!();
		await until(() => !p.status().includes("Building"), "the run to finish");

		expect(p.badge()).toBe("");
		expect(p.status()).toMatch(/Copied, but the settings changed meanwhile/);
	});

	it("delivers nothing once the panel is gone", async () => {
		const p = await mountPanel();
		p.button("Download ZIP").click();
		await until(() => zip.pending.length === 1, "the ZIP build");

		p.panel.destroy();
		zip.pending[0]!(new Blob(["zip"]));
		await new Promise((r) => setTimeout(r, 30));
		expect(output.downloadBlob).not.toHaveBeenCalled();
	});
});

describe("saved social opt-ins", () => {
	it("are voided at startup when Get code's field already holds a URL", async () => {
		const { getCodePage } = await import("./helpers/getCodePage");
		const { mountHostPage, typeInto } = await import("./helpers/hostPage");
		const { scrapeStitch } = await import("@content/scrape");
		const { createHostBridge } = await import("@content/host-fields");
		const { ComponentizePanel } = await import("@ui/panel");
		const { markupFingerprint } = await import("@ui/prefs");

		const html = '<section id="soc-3002"><a href="" aria-label="visit facebook profile">facebook</a></section>';
		const doc = mountHostPage(
			getCodePage({ id: 3002, codes: [{ typeName: "HTML", type: "html", content: html }, { typeName: "CSS", type: "css", content: "#soc-3002{}" }] }),
		);
		const stitch = scrapeStitch(doc, "https://app.codestitch.app/app/dashboard/stitches/3002");
		await chrome.storage.local.set({
			"componentize:stitch:3002": { fingerprint: markupFingerprint(stitch), socialChoices: { "link-0": true } },
		});
		typeInto("#link-0", "https://facebook.com/acme");

		let panel: InstanceType<typeof ComponentizePanel> | undefined;
		panel = new ComponentizePanel({
			stitch,
			fetchAsset: async () => undefined,
			host: createHostBridge(doc, () => panel?.host ?? null),
		});
		doc.querySelector(".gc-inspector__scroll")!.append(panel.host);
		await panel.init();

		// Clearing the URL as the very first edit must give a TODO, not the kit's data.
		typeInto("#link-0", "");
		expect(doc.querySelector<HTMLInputElement>("#link-rows [data-componentize] input")!.checked).toBe(false);
		panel.destroy();
	});
});

