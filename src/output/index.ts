import { zip } from "fflate";
import type { ConvertResult, OutputFile } from "@core/types";

/** Copies text to the clipboard. Must run inside a user gesture. */
export async function copyToClipboard(text: string): Promise<void> {
	await navigator.clipboard.writeText(text);
}

function base64ToBytes(base64: string): Uint8Array {
	const binary = atob(base64);
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
	return bytes;
}

/*
 * Primitives only. The panel composes them and checks, between building a file
 * and handing it over, that the settings have not changed in the meantime; a
 * helper here that built and downloaded in one call would hide that moment.
 */

/** Triggers a download without the `downloads` permission. */
export function downloadBlob(blob: Blob, filename: string): void {
	const url = URL.createObjectURL(blob);
	const anchor = document.createElement("a");
	anchor.href = url;
	anchor.download = filename;
	anchor.style.display = "none";
	document.body.appendChild(anchor);
	anchor.click();
	anchor.remove();
	// Revoke on the next turn so the download has started.
	setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/**
 * The component on its own, as a file.
 *
 * `source` comes from componentSourceFor(), so the verdict in its header
 * describes this delivery rather than the full file set.
 */
export function astroBlob(source: string): Blob {
	return new Blob([source], { type: "text/plain;charset=utf-8" });
}

export function astroFileName(result: ConvertResult): string {
	return `${result.componentName}.astro`;
}

function toZipEntries(files: OutputFile[]): Record<string, Uint8Array> {
	const entries: Record<string, Uint8Array> = {};
	const encoder = new TextEncoder();
	for (const file of files) {
		entries[file.path] =
			file.encoding === "base64"
				? base64ToBytes(file.contents)
				: encoder.encode(file.contents);
	}
	return entries;
}

/**
 * Builds the ZIP asynchronously: a gallery stitch can carry a dozen images, and
 * a synchronous zip would freeze the CodeStitch page while it ran.
 *
 * Paths mirror the kit layout, so the archive extracts straight over a project.
 */
export function buildZip(result: ConvertResult): Promise<Blob> {
	return new Promise((resolve, reject) => {
		zip(toZipEntries(result.files), { level: 6 }, (err, data) => {
			if (err) reject(err);
			else resolve(new Blob([data as BlobPart], { type: "application/zip" }));
		});
	});
}

/** The filename says whether this is drop-in or still needs work. */
export function zipFileName(result: ConvertResult): string {
	const suffix = result.readiness.state === "draft" ? "-draft" : "";
	return `${result.componentName}${suffix}.zip`;
}
