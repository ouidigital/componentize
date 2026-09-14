import { describe, expect, it } from "vitest";
import { isAllowed, readCapped } from "../src/background/worker";

/**
 * The manifest permission is deliberately broad (`*.digitaloceanspaces.com`),
 * so these guards are the actual security boundary.
 */
describe("isAllowed", () => {
	it("accepts CodeStitch's own CDN hosts over https", () => {
		for (const url of [
			"https://csimg.nyc3.cdn.digitaloceanspaces.com/Images/a.jpg",
			"https://nyc3.digitaloceanspaces.com/csimages2/b.png",
		]) {
			expect(isAllowed(url), url).toBe(true);
		}
	});

	it("rejects any other bucket on the same provider", () => {
		// A suffix match would accept these — an attacker can create a bucket.
		for (const url of [
			"https://evil.digitaloceanspaces.com/x.jpg",
			"https://csimg.nyc3.cdn.digitaloceanspaces.com.evil.test/x.jpg",
			"https://attacker.nyc3.digitaloceanspaces.com/x.jpg",
		]) {
			expect(isAllowed(url), url).toBe(false);
		}
	});

	it("rejects non-https and malformed URLs", () => {
		for (const url of [
			"http://csimg.nyc3.cdn.digitaloceanspaces.com/a.jpg",
			"file:///etc/passwd",
			"data:image/png;base64,AAAA",
			"not a url",
		]) {
			expect(isAllowed(url), url).toBe(false);
		}
	});
});

/** Builds a Response whose body streams in chunks of the given size. */
function streamingResponse(totalBytes: number, chunkSize = 1024): Response {
	let sent = 0;
	const stream = new ReadableStream<Uint8Array>({
		pull(controller) {
			if (sent >= totalBytes) {
				controller.close();
				return;
			}
			const size = Math.min(chunkSize, totalBytes - sent);
			sent += size;
			controller.enqueue(new Uint8Array(size));
		},
	});
	return new Response(stream);
}

describe("readCapped", () => {
	it("reads a body that fits", async () => {
		const result = await readCapped(streamingResponse(4096), 1024 * 1024);
		expect("bytes" in result && result.bytes.byteLength).toBe(4096);
	});

	it("stops mid-stream once the cap is passed", async () => {
		// Content-Length can be absent or dishonest, so the limit has to hold
		// against bytes actually received rather than a declared size.
		const result = await readCapped(streamingResponse(5 * 1024 * 1024), 64 * 1024);
		expect("error" in result).toBe(true);
		expect("error" in result && result.error).toMatch(/limit/i);
	});

	it("reports an empty body rather than hanging", async () => {
		const result = await readCapped(new Response(null), 1024);
		expect("error" in result).toBe(true);
	});
});
