import type { AssetPayload } from "@core/types";
import { scrapeStitch } from "./scrape";
import {
	PremiumLockedError,
	SelectorDriftError,
	StitchUnavailableError,
	stitchIdFromUrl,
} from "./selectors";
import { ComponentizePanel, errorPanel } from "@ui/panel";
import type { FetchAssetResponse } from "../background/worker";

/**
 * Mounts the panel on a stitch page and keeps it mounted.
 *
 * Note: this file and the worker must not share a basename. Both were once
 * `index.ts`, and the bundler emitted two same-named chunks — the service
 * worker loader then imported the content script, so the worker silently
 * registered no message listener.
 *
 * The dashboard may re-render or navigate without a full page load, so mounting
 * is idempotent and a small watchdog re-runs it if the URL changes or the panel
 * is torn out of the DOM.
 */

const HOST_ID = "componentize-root";

/** How long to wait for one asset before giving up on it. */
const ASSET_TIMEOUT_MS = 15_000;

/**
 * Downloads a CDN asset through the service worker.
 *
 * The wait is bounded: an MV3 worker can be terminated mid-flight, and a
 * message that never gets answered would otherwise leave the panel stuck on
 * "working" forever. Giving up returns undefined, which the conversion reports
 * as an asset it could not bundle.
 */
async function fetchAsset(
	url: string,
	maxBytes?: number,
): Promise<AssetPayload | undefined> {
	const timeout = new Promise<undefined>((resolve) =>
		setTimeout(() => resolve(undefined), ASSET_TIMEOUT_MS),
	);
	const request = chrome.runtime
		.sendMessage({ type: "componentize:fetch-asset", url, maxBytes })
		.catch(() => undefined) as Promise<FetchAssetResponse | undefined>;

	const response = await Promise.race([request, timeout]);

	if (!response?.ok || !response.base64 || !response.originalUrl) {
		return undefined;
	}
	return {
		base64: response.base64,
		contentType: response.contentType ?? "application/octet-stream",
		originalUrl: response.originalUrl,
		byteLength: response.byteLength,
	};
}

/** Puts the panel just above the code viewer, so it reads as part of the page. */
function mountPoint(): { parent: Element; before: Element | null } | undefined {
	const codeTabs = document.querySelector("#CODE_TABS");
	if (codeTabs?.parentElement) {
		return { parent: codeTabs.parentElement, before: codeTabs };
	}
	const body = document.querySelector(".section-body") ?? document.body;
	return body ? { parent: body, before: body.firstElementChild } : undefined;
}

let mountedFor: string | undefined;

async function mount(): Promise<void> {
	const url = location.href;
	const stitchId = stitchIdFromUrl(url);
	if (!stitchId) return;

	const existing = document.getElementById(HOST_ID);
	if (existing && mountedFor === stitchId && existing.isConnected) return;
	existing?.remove();

	const point = mountPoint();
	if (!point) return;

	try {
		const stitch = scrapeStitch(document, url);
		const panel = new ComponentizePanel({ stitch, fetchAsset });
		point.parent.insertBefore(panel.host, point.before);
		mountedFor = stitchId;
		await panel.init();
	} catch (err) {
		const message =
			err instanceof SelectorDriftError ||
			err instanceof PremiumLockedError ||
			err instanceof StitchUnavailableError
				? err.message
				: `Componentize could not read this stitch: ${(err as Error).message}`;
		point.parent.insertBefore(errorPanel(message), point.before);
		mountedFor = stitchId;
	}
}

function start(): void {
	void mount();

	// The dashboard can swap content without a page load. A short poll is duller
	// than a document-wide MutationObserver, and cheaper.
	let lastHref = location.href;
	setInterval(() => {
		const host = document.getElementById(HOST_ID);
		if (location.href !== lastHref) {
			lastHref = location.href;
			mountedFor = undefined;
			void mount();
		} else if (!host?.isConnected) {
			void mount();
		}
	}, 500);

	window.addEventListener("popstate", () => {
		mountedFor = undefined;
		void mount();
	});
}

if (document.readyState === "loading") {
	document.addEventListener("DOMContentLoaded", start, { once: true });
} else {
	start();
}
