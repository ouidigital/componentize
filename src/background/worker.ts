/**
 * Service worker — asset downloading only.
 *
 * A content script cannot fetch the CodeStitch CDN directly (the page's origin
 * policy applies to it), so the worker does it under the extension's host
 * permission. The manifest permission is necessarily broad
 * (`https://*.digitaloceanspaces.com/*`), so this file is the narrow security
 * boundary: an exact host allowlist, revalidated on every redirect hop.
 *
 * It stays stateless — MV3 terminates workers between messages — so the
 * per-conversion budget is tracked by the caller and passed in as `maxBytes`.
 */

/** The only hosts CodeStitch serves stitch imagery from. */
const ALLOWED_HOSTS = new Set([
	"csimg.nyc3.cdn.digitaloceanspaces.com",
	"csimg.nyc3.digitaloceanspaces.com",
	"nyc3.digitaloceanspaces.com",
	"csimages2.nyc3.digitaloceanspaces.com",
]);

const MAX_FILE_BYTES = 10 * 1024 * 1024;
const MAX_REDIRECTS = 3;

export interface FetchAssetRequest {
	type: "componentize:fetch-asset";
	url: string;
	/** Caller's remaining budget; the read aborts past it. */
	maxBytes?: number;
}

export interface FetchAssetResponse {
	ok: boolean;
	base64?: string;
	contentType?: string;
	originalUrl?: string;
	/** Actual decoded byte length, so the caller can keep an exact budget. */
	byteLength?: number;
	error?: string;
}

/**
 * Exact-match only. A suffix test would accept any bucket on the provider —
 * including one an attacker controls — which is precisely what the broad
 * manifest permission would otherwise allow.
 */
export function isAllowed(rawUrl: string): boolean {
	try {
		const url = new URL(rawUrl);
		return url.protocol === "https:" && ALLOWED_HOSTS.has(url.hostname);
	} catch {
		return false;
	}
}

function toBase64(bytes: Uint8Array): string {
	let binary = "";
	const chunk = 0x8000;
	for (let i = 0; i < bytes.length; i += chunk) {
		binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
	}
	return btoa(binary);
}

/**
 * Reads the body incrementally, stopping the moment the cap is passed.
 *
 * `Content-Length` is a hint, not a promise: it can be absent or wrong, so the
 * limit has to be enforced against bytes actually received rather than by
 * buffering the whole response and measuring it afterwards.
 */
export async function readCapped(
	response: Response,
	cap: number,
): Promise<{ bytes: Uint8Array } | { error: string }> {
	const body = response.body;
	if (!body) return { error: "Empty response body." };

	const reader = body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;

	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			if (!value) continue;
			total += value.byteLength;
			if (total > cap) {
				await reader.cancel();
				return {
					error: `Image exceeds the ${Math.round(cap / 1024 / 1024)} MB limit.`,
				};
			}
			chunks.push(value);
		}
	} catch (err) {
		return { error: `Read failed: ${(err as Error).message}` };
	}

	const bytes = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return { bytes };
}

/** Follows redirects by hand so every hop is checked against the allowlist. */
async function fetchFollowingRedirects(
	url: string,
	signal: AbortSignal,
): Promise<{ response: Response; finalUrl: string } | { error: string }> {
	let current = url;

	for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
		if (!isAllowed(current)) {
			return { error: "Only CodeStitch's own image CDN can be downloaded." };
		}

		let response: Response;
		try {
			response = await fetch(current, {
				credentials: "omit",
				redirect: "manual",
				signal,
			});
		} catch (err) {
			return {
				error: signal.aborted
					? "Timed out."
					: `Network error: ${(err as Error).message}`,
			};
		}

		// `redirect: "manual"` surfaces a redirect as an opaqueredirect response,
		// whose headers are hidden — so a redirect cannot be followed safely and
		// is refused rather than silently trusted.
		if (response.type === "opaqueredirect" || (response.status >= 300 && response.status < 400)) {
			const location = response.headers.get("location");
			if (!location) {
				return {
					error: "The CDN redirected somewhere this extension cannot verify.",
				};
			}
			current = new URL(location, current).toString();
			continue;
		}

		if (!response.ok) {
			return { error: `HTTP ${response.status} ${response.statusText}` };
		}
		return { response, finalUrl: current };
	}

	return { error: "Too many redirects." };
}

async function fetchAsset(
	url: string,
	maxBytes?: number,
): Promise<FetchAssetResponse> {
	if (!isAllowed(url)) {
		return { ok: false, error: "Only CodeStitch's own image CDN can be downloaded." };
	}

	const abort = new AbortController();
	const timer = setTimeout(() => abort.abort(), 12_000);

	try {
		const result = await fetchFollowingRedirects(url, abort.signal);
		if ("error" in result) return { ok: false, error: result.error };

		const { response } = result;
		const contentType = response.headers.get("content-type") ?? "";
		if (!/^image\//i.test(contentType)) {
			return { ok: false, error: `Not an image (${contentType || "unknown type"}).` };
		}

		const cap = Math.max(0, Math.min(MAX_FILE_BYTES, maxBytes ?? MAX_FILE_BYTES));
		if (cap === 0) {
			return { ok: false, error: "No download budget left." };
		}

		const read = await readCapped(response, cap);
		if ("error" in read) return { ok: false, error: read.error };

		// Messages are JSON-serialised, so bytes travel as base64: an ArrayBuffer
		// would not survive the trip.
		return {
			ok: true,
			base64: toBase64(read.bytes),
			contentType,
			originalUrl: url,
			byteLength: read.bytes.byteLength,
		};
	} finally {
		clearTimeout(timer);
	}
}

// The listener is only registered inside a real extension runtime, so this
// module can also be imported directly by unit tests.
if (typeof chrome !== "undefined" && chrome.runtime?.onMessage) {
	chrome.runtime.onMessage.addListener(
		(message: FetchAssetRequest, _sender, sendResponse) => {
			if (message?.type !== "componentize:fetch-asset") return false;
			fetchAsset(message.url, message.maxBytes).then(sendResponse, (err: unknown) =>
				sendResponse({ ok: false, error: String(err) }),
			);
			return true; // keep the channel open for the async reply
		},
	);
}
