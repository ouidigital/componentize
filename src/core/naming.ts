/**
 * Component/namespace naming and the sanitizers that guard everything a
 * user-supplied or remote string can turn into (identifiers, paths, ZIP entries).
 */

const RESERVED_WORDS = new Set([
	"break", "case", "catch", "class", "const", "continue", "debugger", "default",
	"delete", "do", "else", "enum", "export", "extends", "false", "finally",
	"for", "function", "if", "import", "in", "instanceof", "new", "null",
	"return", "super", "switch", "this", "throw", "true", "try", "typeof",
	"var", "void", "while", "with", "yield", "let", "static", "await",
	"implements", "interface", "package", "private", "protected", "public",
	"Astro", "Fragment",
]);

/** Splits an id/slug into words: "not-found", "cs_navigation", "fooBar" -> tokens. */
function words(input: string): string[] {
	return input
		.replace(/([a-z0-9])([A-Z])/g, "$1 $2")
		.split(/[^A-Za-z0-9]+/)
		.filter(Boolean);
}

export function pascalCase(input: string): string {
	return words(input)
		.map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
		.join("");
}

export function camelCase(input: string): string {
	const p = pascalCase(input);
	return p.charAt(0).toLowerCase() + p.slice(1);
}

/**
 * Strips a trailing numeric stitch id from a section id.
 * "not-found-2501" -> "not-found"; "cs-navigation" -> "cs-navigation".
 */
export function slugFromSectionId(sectionId: string): string {
	return sectionId.replace(/-\d+$/, "");
}

export class InvalidNameError extends Error {
	override readonly name = "InvalidNameError";
}

/**
 * Validates the component's file name.
 *
 * A file name is not an identifier: `Hero-1621.astro` is a perfectly good
 * component, imported under whatever binding the importer chooses. So hyphens,
 * underscores and digits are all allowed here — only what would be unsafe as a
 * path segment is refused.
 */
export function assertValidComponentFileName(name: string): string {
	if (!/^[A-Za-z][A-Za-z0-9._-]*$/.test(name)) {
		throw new InvalidNameError(
			`"${name}" cannot be used as a file name — start with a letter and use letters, digits, hyphens, underscores or dots.`,
		);
	}
	if (name.includes("..")) {
		throw new InvalidNameError(`"${name}" cannot contain "..".`);
	}
	if (name.toLowerCase().endsWith(".astro")) {
		// The extension is added when the path is built.
		return assertValidComponentFileName(name.slice(0, -".astro".length));
	}
	return name;
}

/**
 * The JS binding a file name is imported under.
 *
 * `Hero-1621.astro` becomes `Hero1621`: hyphens are legal in a file name but
 * not in an identifier, and this is the name the import statement and the
 * component tag use.
 */
export function identifierFor(fileName: string): string {
	let identifier = pascalCase(fileName) || "Component";
	if (/^\d/.test(identifier)) identifier = `Component${identifier}`;
	if (RESERVED_WORDS.has(identifier)) identifier = `${identifier}Component`;
	return identifier;
}

/**
 * Derives the default file name: PascalCase slug, a hyphen, then the stitch id
 * — `Hero-1621`, `SideBySide-1982`, `NotFound-2501`. Keeping the id means a
 * second Hero never overwrites the first, and it points back at the stitch.
 */
export function deriveComponentName(
	sectionId: string,
	stitchId: string,
	isNav: boolean,
): string {
	const base = isNav ? "Navigation" : pascalCase(slugFromSectionId(sectionId));
	const safeBase = base || "Component";
	// A section id may already carry the stitch id (e.g. "hero-1621").
	const name = safeBase.endsWith(stitchId)
		? `${safeBase.slice(0, -stitchId.length)}-${stitchId}`
		: `${safeBase}-${stitchId}`;
	return assertValidComponentFileName(name);
}

/** i18n namespace for t("ns:key") lookups — camelCase of the component. */
export function namespaceFor(componentName: string): string {
	return camelCase(componentName);
}

/**
 * Validates a kit-relative directory for downloaded images.
 *
 * It has to sit under src/assets so the `@assets` alias resolves; anywhere else
 * and the generated imports would not compile.
 */
export function assertValidAssetsDir(dir: string): string {
	const normalized = dir.trim().replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
	if (!normalized) throw new InvalidNameError("The images folder cannot be empty.");
	if (normalized.split("/").some((seg) => seg === ".." || seg === "." || !seg)) {
		throw new InvalidNameError(`"${dir}" is not a valid folder.`);
	}
	if (!/^src\/assets(\/|$)/.test(normalized)) {
		throw new InvalidNameError(
			`Images must live under src/assets so the @assets alias resolves — "${dir}" does not.`,
		);
	}
	if (!/^[A-Za-z0-9/_-]+$/.test(normalized)) {
		throw new InvalidNameError(
			`"${dir}" contains characters that are not safe in a path.`,
		);
	}
	return normalized;
}

/** The import specifier for a file in an assets directory. */
export function assetSpecifier(assetsDir: string, fileName: string): string {
	return `@assets/${assetsDir.replace(/^src\/assets\/?/, "")}/${fileName}`
		.replace(/\/{2,}/g, "/");
}

/**
 * Sanitizes a remote asset filename into a safe basename, dropping any path
 * information the URL may carry. Returns { base, ext } without a dot in ext.
 */
export function sanitizeAssetName(url: string): { base: string; ext: string } {
	let pathname: string;
	try {
		pathname = new URL(url).pathname;
	} catch {
		pathname = url;
	}
	const raw = decodeURIComponent(pathname.split("/").pop() ?? "asset");
	const dot = raw.lastIndexOf(".");
	const rawBase = dot > 0 ? raw.slice(0, dot) : raw;
	const rawExt = dot > 0 ? raw.slice(dot + 1) : "";

	const base =
		rawBase
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, "-")
			.replace(/^-+|-+$/g, "")
			.slice(0, 60) || "asset";
	const ext = rawExt.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 8) || "bin";

	return { base, ext };
}

/** Short, stable content hash used to keep same-named assets from colliding. */
export function shortHash(input: string): string {
	// FNV-1a, 32-bit — no crypto dependency needed for collision-avoidance suffixes.
	let h = 0x811c9dc5;
	for (let i = 0; i < input.length; i++) {
		h ^= input.charCodeAt(i);
		h = Math.imul(h, 0x01000193) >>> 0;
	}
	return h.toString(16).padStart(8, "0");
}

/** Turns an asset filename into a valid, unique-ish JS import identifier. */
export function importIdentifier(base: string, taken: Set<string>): string {
	let ident = camelCase(base) || "asset";
	if (/^\d/.test(ident)) ident = `img${pascalCase(ident)}`;
	if (RESERVED_WORDS.has(ident)) ident = `${ident}Asset`;

	let candidate = ident;
	let n = 2;
	while (taken.has(candidate)) candidate = `${ident}${n++}`;
	taken.add(candidate);
	return candidate;
}

/**
 * Normalizes a kit-relative output path and confines it beneath src/.
 * Guards ZIP entries against traversal from any upstream-derived segment.
 */
export function assertSafeOutputPath(path: string): string {
	const normalized = path.replace(/\\/g, "/").replace(/\/{2,}/g, "/");
	if (
		normalized.startsWith("/") ||
		normalized.split("/").some((seg) => seg === ".." || seg === ".")
	) {
		throw new InvalidNameError(`Unsafe output path: "${path}"`);
	}
	if (!/^(src|public)\//.test(normalized) && normalized !== "INSTALL.md") {
		throw new InvalidNameError(`Output path outside allowed roots: "${path}"`);
	}
	return normalized;
}
