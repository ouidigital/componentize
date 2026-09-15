/**
 * Attributes that can safely cross from a scraped HTML element to an Astro
 * image component. Keeping this allowlist in one place prevents each image
 * conversion path from slowly acquiring a different set of forwarded props.
 */

export type SourceAttributeKind = "raster" | "picture" | "icon";

const COMMON = new Set([
	"id",
	"class",
	"style",
	"title",
	"width",
	"height",
	"aria-hidden",
]);

const RASTER_ONLY = new Set([
	"referrerpolicy",
	"crossorigin",
	"fetchpriority",
	"loading",
	"decoding",
]);

/**
 * Extracts only attributes supported by the generated component contract.
 * Event handlers and arbitrary source attributes are intentionally ignored.
 * `alt` is included for Icon conversion so it can become `title`; raster
 * callers add it as a dedicated prop after deciding whether it is missing.
 */
export function extractSourceAttributes(
	element: Element,
	kind: SourceAttributeKind,
): Record<string, string> {
	const out: Record<string, string> = {};
	for (const source of Array.from(element.attributes)) {
		const name = source.name.toLowerCase();
		if (COMMON.has(name) || (kind === "icon" && name === "alt")) {
			out[name] = source.value;
			continue;
		}
		if (name.startsWith("data-")) {
			out[name] = source.value;
			continue;
		}
		if (kind !== "raster" || !RASTER_ONLY.has(name)) continue;
		if (name === "loading" && source.value.toLowerCase() === "lazy") continue;
		if (name === "decoding" && source.value.toLowerCase() === "async") continue;
		out[name] = source.value;
	}
	return out;
}

/** Serialises an Astro object prop without interpolating unescaped strings. */
export function astroObjectLiteral(values: Record<string, string>): string {
	const entries = Object.entries(values).map(([key, value]) => {
		const property = /^[A-Za-z_$][\w$]*$/.test(key) ? key : JSON.stringify(key);
		return `${property}: ${JSON.stringify(value)}`;
	});
	return `{ ${entries.join(", ")} }`;
}
