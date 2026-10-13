import { createHostBridge } from "@content/host-fields";
import { scrapeStitch } from "@content/scrape";
import { SEL } from "@content/selectors";
import { ComponentizePanel } from "@ui/panel";
import { loadPage } from "./loadFixture";
import { mountHostPage } from "./hostPage";

/** Just enough of chrome.storage for the panel's best-effort persistence. */
export function stubChromeStorage(): void {
	const area = () => {
		const data: Record<string, unknown> = {};
		return {
			get: async (key: string) => (key in data ? { [key]: data[key] } : {}),
			set: async (items: Record<string, unknown>) => {
				Object.assign(data, items);
			},
		};
	};
	(globalThis as unknown as { chrome: unknown }).chrome = {
		storage: { sync: area(), local: area() },
	};
}

/** The real panel, mounted in the inspector of a fixture page with CodeStitch's controls rendered. */
export async function mountPanel(id = "2501", prefs?: Record<string, unknown>) {
	const doc = mountHostPage(loadPage(id), { prefs });
	const stitch = scrapeStitch(doc, `https://app.codestitch.app/app/dashboard/stitches/${id}`);
	let panel: ComponentizePanel | undefined;
	const bridge = createHostBridge(doc, () => panel?.host ?? null);
	panel = new ComponentizePanel({ stitch, fetchAsset: async () => undefined, host: bridge });
	doc.querySelector(SEL.inspectorScroll)!.append(panel.host);
	await panel.init();
	const root = panel.host.shadowRoot!;
	const button = (label: string) =>
		[...root.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent?.includes(label))!;
	const status = () => root.querySelector(".status")?.textContent ?? "";
	const badge = () => root.querySelector(".badge")?.textContent ?? "";
	return { doc, panel, root, button, status, badge };
}

/** Waits until the predicate holds, for work that crosses several awaits. */
export async function until(predicate: () => boolean, what: string): Promise<void> {
	for (let i = 0; i < 200; i++) {
		if (predicate()) return;
		await new Promise((r) => setTimeout(r, 5));
	}
	throw new Error(`timed out waiting for ${what}`);
}
