import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mountPanel, stubChromeStorage, until } from "./helpers/panelHarness";
import { typeInto } from "./helpers/hostPage";

/*
 * Same guard as panel-run.test.ts, but nothing of the output module is mocked:
 * the real buildZip runs, and the compression library underneath it is held
 * open. A download is observed where it actually happens, as a click on a
 * generated <a download>.
 */
const pending = vi.hoisted(() => [] as Array<() => void>);

vi.mock("fflate", () => ({
	zip: (_entries: unknown, _opts: unknown, cb: (err: Error | null, data: Uint8Array) => void) => {
		pending.push(() => cb(null, new Uint8Array([0x50, 0x4b, 5, 6])));
	},
}));

const downloads: string[] = [];

beforeEach(() => {
	stubChromeStorage();
	pending.length = 0;
	downloads.length = 0;
	URL.createObjectURL = vi.fn(() => "blob:test");
	URL.revokeObjectURL = vi.fn();
	vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
		if (this.download) downloads.push(this.download);
	});
});
afterEach(() => {
	vi.restoreAllMocks();
	document.documentElement.innerHTML = "<head></head><body></body>";
});

describe("the delivery guard with the real ZIP builder", () => {
	it("downloads when nothing changed", async () => {
		const p = await mountPanel();
		p.button("Download ZIP").click();
		await until(() => pending.length === 1, "compression");
		pending[0]!();
		await until(() => !p.status().includes("Building"), "the run");
		expect(downloads).toEqual(["Not-found-2501-draft.zip"]);
	});

	it("does not download when settings change during compression", async () => {
		const p = await mountPanel();
		p.button("Download ZIP").click();
		await until(() => pending.length === 1, "compression");
		typeInto("#file-name", "Renamed");
		pending[0]!();
		await until(() => !p.status().includes("Building"), "the run");
		expect(downloads).toEqual([]);
		expect(p.status()).toMatch(/Settings changed while building/);
	});
});
