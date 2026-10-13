import { afterEach, describe, expect, it, vi } from "vitest";
import { CODESTITCH_DEFAULTS, createHostBridge, readHostSettings } from "@content/host-fields";
import { loadPage } from "./helpers/loadFixture";
import { getCodePage } from "./helpers/getCodePage";
import { click, mountHostPage, tick, typeInto } from "./helpers/hostPage";

afterEach(() => {
	document.documentElement.innerHTML = "<head></head><body></body>";
});

describe("readHostSettings", () => {
	it("reads CodeStitch's rendered controls on the real 2501 page", () => {
		const doc = mountHostPage(loadPage("2501"));
		const host = readHostSettings(doc);

		expect(host.rendered).toBe(true);
		expect(host).toMatchObject({
			format: "html",
			flavour: "css",
			includeJs: false,
			fileName: "Not-found-2501",
			imagesMode: "cdn",
			imagesFolder: "/assets/images",
			replaceLinks: true,
			guessRoutes: true,
		});
		expect(host.links).toEqual([
			{ index: 0, text: "Return To Home", href: "/return-to-home", guessed: true },
			{ index: 1, text: "View Properties", href: "/view-properties", guessed: true },
		]);
	});

	it("reports the dark box as unusable where CodeStitch misreads the stitch", () => {
		// 2501's "CSS Dark" record says isDark: false, so CodeStitch disables
		// dark mode under CSS although the variant exists.
		const doc = mountHostPage(loadPage("2501"));
		expect(readHostSettings(doc)).toMatchObject({ darkStyles: false, usable: { darkStyles: false } });

		click('#flavours [data-id="less"]');
		expect(readHostSettings(doc)).toMatchObject({
			flavour: "less",
			darkStyles: true,
			usable: { darkStyles: true },
		});
	});

	it("knows Single file and Shopify force CSS, and Shopify hides the file name", () => {
		const doc = mountHostPage(loadPage("2501"), { prefs: { flavour: "less" } });
		expect(readHostSettings(doc).usable).toMatchObject({ flavour: true, fileName: true });

		click('#formats [data-id="single"]');
		const single = readHostSettings(doc);
		// The pressed CSS button stays enabled; only the format says it is forced.
		expect(doc.querySelector<HTMLButtonElement>('#flavours [data-id="css"]')!.disabled).toBe(false);
		expect(single).toMatchObject({ flavour: "css", usable: { flavour: false, fileName: true } });

		click('#formats [data-id="shopify"]');
		expect(readHostSettings(doc).usable).toMatchObject({ flavour: false, fileName: false });
	});

	it("follows the user's edits", () => {
		const doc = mountHostPage(loadPage("2501"));
		typeInto("#file-name", "  Renamed ");
		click('#image-modes [data-id="local"]');
		typeInto("#images-folder", "/assets/images/foo");
		typeInto("#link-0", "/about");
		click("#guess-routes");

		const host = readHostSettings(doc);
		expect(host).toMatchObject({
			fileName: "Renamed",
			imagesMode: "local",
			imagesFolder: "/assets/images/foo",
			guessRoutes: false,
		});
		expect(host.links.map((l) => l.href)).toEqual(["/about", ""]);
	});

	it("falls back to CodeStitch's defaults when their script never ran", () => {
		// The server skeleton has every box unchecked; that must not read as "off".
		const doc = mountHostPage(loadPage("2501"), { render: false });
		const host = readHostSettings(doc);
		expect(host.rendered).toBe(false);
		expect(host).toMatchObject({ ...CODESTITCH_DEFAULTS, links: [] });
		expect(Object.values(host.usable).every((v) => v === false)).toBe(true);
	});

	it("reads a stitch with no empty links as rendered with no rows", () => {
		const doc = mountHostPage(
			getCodePage({
				codes: [{ typeName: "HTML", type: "html", content: '<section id="x-1"><a href="#">Hash</a></section>' }],
			}),
		);
		expect(readHostSettings(doc)).toMatchObject({ rendered: true, links: [] });
	});
});

describe("createHostBridge", () => {
	it("reports changes made in CodeStitch's inspector, and nothing else", () => {
		const doc = mountHostPage(loadPage("2501"));
		const own = doc.createElement("div");
		doc.body.append(own);
		const bridge = createHostBridge(doc, () => own);
		const onChange = vi.fn();
		const dispose = bridge.observe(onChange);

		click('#flavours [data-id="less"]');
		expect(onChange).toHaveBeenCalled();

		onChange.mockClear();
		own.click();
		doc.body.click();
		expect(onChange).not.toHaveBeenCalled();

		dispose();
		click('#flavours [data-id="scss"]');
		expect(onChange).not.toHaveBeenCalled();
	});

	it("keeps its notes under CodeStitch's rows across their re-render", async () => {
		const doc = mountHostPage(loadPage("2501"));
		const bridge = createHostBridge(doc);
		const notes = new Map([[1, { kind: "note" as const, text: "Advanced Astro v4 does not ship /view-properties" }]]);
		const annotate = () => bridge.annotateLinkRows(notes, () => {});
		const dispose = bridge.observe(annotate);

		annotate();
		annotate();
		const marks = () => [...doc.querySelectorAll("#link-rows [data-componentize]")];
		expect(marks()).toHaveLength(1);
		expect(marks()[0]!.closest(".gc-link-row")!.getAttribute("data-i")).toBe("1");

		// CodeStitch replaces #link-rows wholesale on every settings change.
		click('#flavours [data-id="less"]');
		await tick();
		expect(marks()).toHaveLength(1);
		expect(marks()[0]!.textContent).toContain("Componentize: Advanced Astro v4 does not ship");
		dispose();
	});

	it("hands a ticked choice back without touching CodeStitch's field", () => {
		const doc = mountHostPage(loadPage("2501"));
		const bridge = createHostBridge(doc);
		const onChange = vi.fn();
		bridge.observe(onChange);
		const onToggle = vi.fn();
		bridge.annotateLinkRows(
			new Map([[0, { kind: "choice" as const, mappingId: "link-0", text: "use it", checked: false }]]),
			onToggle,
		);

		const box = doc.querySelector<HTMLInputElement>("#link-rows [data-componentize] input")!;
		box.click();
		expect(onToggle).toHaveBeenCalledWith("link-0", true);
		// Our own control is not a CodeStitch settings change.
		expect(onChange).not.toHaveBeenCalled();
		expect(doc.querySelector<HTMLInputElement>("#link-0")!.value).toBe("/return-to-home");
	});
});
