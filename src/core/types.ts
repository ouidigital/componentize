/** Shared types for the pure conversion core. Nothing here may touch chrome.* or page globals. */

export type CssFlavor = "less" | "scss" | "css";

export type CssVariant =
	| "CSS"
	| "CSS Dark"
	| "LESS"
	| "LESS Dark"
	| "SCSS"
	| "SCSS Dark";

export type KitId = "i18n" | "decap";

export type ImagesMode = "assets" | "raw";

/** Raw fields scraped from a stitch page. */
export interface StitchData {
	/** Numeric stitch id from the URL, e.g. "2501". */
	id: string;
	url: string;
	html: string;
	js?: string;
	css: Partial<Record<CssVariant, string>>;
	coreStyles: Partial<Record<"CSS" | "LESS" | "SCSS", string>>;
	/** h2.heading text, e.g. "Landing + Services". */
	categoryHeading?: string;
}

/** A placeholder link the user may map to a real route. */
export interface LinkMapping {
	/** Stable identity for the anchor within the parsed document. */
	id: string;
	/** Visible link text, shown in the panel. */
	text: string;
	/** Original href value ("" for CodeStitch placeholders). */
	originalHref: string;
	/** User-supplied route, e.g. "/about". Empty/undefined = unresolved. */
	route?: string;
	/**
	 * Destination derived from the link itself, offered as the default. May be a
	 * route ("/about"), an absolute URL, or an expression in braces
	 * ("{BUSINESS.socials.facebook}"). Undefined when nothing sensible can be read.
	 */
	suggestedRoute?: string;
	/** The social network this link points at, when it is one. */
	social?: string;
}

export interface ConvertOptions {
	kit: KitId;
	cssFlavor: CssFlavor;
	darkMode: boolean;
	includeCoreStyles: boolean;
	includeJs: boolean;
	/** Full text extraction; only meaningful for the i18n kit. */
	i18n: boolean;
	imagesMode: ImagesMode;
	/** Extra locales beyond the profile's required set. */
	extraLocales?: string[];
	/**
	 * The component's file name, without the .astro extension.
	 * Hyphens are fine — `Hero-1621` produces `Hero-1621.astro`.
	 */
	componentName?: string;
	/**
	 * Kit-relative folder for downloaded images. Must sit under src/assets so
	 * the `@assets` alias resolves. Defaults to a folder named after the stitch.
	 */
	assetsDir?: string;
	linkMappings?: LinkMapping[];
	/**
	 * Fill unmapped links with a route derived from their own label
	 * ("Privacy Policy" -> /privacy-policy). On unless explicitly disabled.
	 */
	guessRoutes?: boolean;
	/**
	 * Include a navigation stitch's script even when it duplicates the kit's
	 * sitewide nav.js. Off by default: the duplicate is left out with a note.
	 * When on, the script is kept and the result is a Draft, because both
	 * scripts would drive the same menu.
	 */
	keepKitNavScript?: boolean;
}

/**
 * Fetches a remote asset. Injected by the caller so the core stays pure:
 * the content script routes this through the service worker, tests stub it.
 *
 * `maxBytes` is the caller's remaining download budget; the fetch must abort
 * rather than return anything larger. Returns undefined when the asset could
 * not be fetched, in which case the caller leaves the original markup alone.
 */
export type FetchAsset = (
	url: string,
	maxBytes?: number,
) => Promise<AssetPayload | undefined>;

export interface AssetPayload {
	base64: string;
	contentType: string;
	originalUrl: string;
	/** Exact decoded size, so the caller can keep an accurate budget. */
	byteLength?: number;
}

export type OutputEncoding = "utf8" | "base64";

export interface OutputFile {
	/** Kit-relative path, e.g. "src/components/Hero1621/Hero1621.astro". */
	path: string;
	contents: string;
	encoding: OutputEncoding;
}

/**
 * Severity drives the Ready/Draft verdict.
 * - "info": worth telling the user, does not affect readiness.
 * - "draft": the output is not drop-in Ready; the reason is listed in the panel.
 */
export type WarningSeverity = "info" | "draft";

export interface Warning {
	severity: WarningSeverity;
	/** Stable machine code, e.g. "unresolved-link", "scss-requires-sass". */
	code: string;
	message: string;
}

export type ResultState = "ready" | "draft";

export interface Readiness {
	state: ResultState;
	/** Human-readable reasons; empty when state is "ready". */
	reasons: string[];
}

export interface ConvertResult {
	/** File name without the extension, e.g. "Hero-1621". */
	componentName: string;
	/**
	 * The JS binding the component should be imported under, e.g. "Hero1621".
	 * A file name may contain hyphens; an identifier may not.
	 */
	componentIdentifier: string;
	/** files[0] is always the .astro component. */
	files: OutputFile[];
	warnings: Warning[];
	readiness: Readiness;
}
