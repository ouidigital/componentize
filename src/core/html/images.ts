import type { AssetPayload, FetchAsset, ImagesMode, OutputFile } from "../types";
import type { KitProfile } from "../kits/profile";
import type { WarningCollector } from "../readiness";
import {
	assetSpecifier,
	importIdentifier,
	sanitizeAssetName,
	shortHash,
} from "../naming";
import { COMPONENT_MARKER, expr } from "./serialize";
import { astroObjectLiteral, extractSourceAttributes } from "./attributes";
import type { CssUrlRef } from "../css/transform";

/**
 * Default folder for downloaded stitch images, overridable per conversion.
 * astro-icon requires icons in src/icons, so that one is fixed.
 */
export const DEFAULT_ASSET_DIR = "src/assets/images";
export const ICON_DIR = "src/icons";

const CDN_HOSTS = /(^|\.)digitaloceanspaces\.com$/i;
const SUPPORTED_RASTER_EXTENSIONS = new Set([
	"jpg",
	"jpeg",
	"png",
	"webp",
	"avif",
	"gif",
]);

/** Per-conversion download budget, enforced here because the worker is stateless. */
const MAX_TOTAL_BYTES = 50 * 1024 * 1024;

export function isStitchCdnUrl(url: string): boolean {
	try {
		const u = new URL(url);
		return u.protocol === "https:" && CDN_HOSTS.test(u.hostname);
	} catch {
		return false;
	}
}

export interface ImportSpec {
	identifier: string;
	/** Import specifier, e.g. "@assets/images/codestitch/hero-1a2b3c4d.jpg". */
	specifier: string;
	/** Original CDN URL, for the TODO comment when the asset is not bundled. */
	sourceUrl: string;
	group: "Images";
}

export interface CssVar {
	varName: string;
	identifier: string;
	url: string;
	/** True when the CSS asset should be passed through Astro's image service. */
	optimize: boolean;
}

export interface ImagesResult {
	imports: ImportSpec[];
	/** Downloaded assets to bundle alongside the component. */
	files: OutputFile[];
	/** CSS custom properties for url() rewrites: varName -> import identifier. */
	cssVars: CssVar[];
	/** True when at least one asset could not be bundled locally. */
	anyUnbundled: boolean;
}

interface AssetRegistryEntry {
	identifier: string;
	specifier: string;
	bundled: boolean;
}

/**
 * Downloads stitch assets and hands out stable import identifiers.
 *
 * Filenames are sanitised and content-hashed: a stitch may reference two
 * different files that share a basename, and remote names must never be able
 * to steer a path.
 */
class AssetRegistry {
	private readonly entries = new Map<string, AssetRegistryEntry>();
	private readonly taken = new Set<string>();
	private totalBytes = 0;

	readonly files: OutputFile[] = [];
	anyUnbundled = false;

	constructor(
		private readonly mode: ImagesMode,
		private readonly warnings: WarningCollector,
		private readonly assetsDir: string,
		private readonly fetchAsset?: FetchAsset,
	) {}

	/**
	 * Registers an SVG as an astro-icon icon rather than an image import.
	 *
	 * astro:assets refuses to process SVG sources unless a project opts in with
	 * `image.dangerouslyProcessSVG`, so an `<Image src={someSvg}>` fails the
	 * build outright. Both kits already ship astro-icon, which renders SVGs
	 * inline from src/icons — and inline SVG is what stitch CSS expects to
	 * style anyway.
	 *
	 * Returns the icon name to use, or undefined if the file is unavailable.
	 */
	async registerIcon(url: string, kitIcons: string[]): Promise<string | undefined> {
		const { base } = sanitizeAssetName(url);

		// The kit already ships an icon by this name: reuse it, ship nothing.
		if (kitIcons.includes(base)) return base;

		const cached = this.icons.get(url);
		if (cached) return cached;

		const payload = await this.download(url);
		if (!payload) return undefined;

		// Suffix the name so a stitch icon can never shadow one of the kit's.
		const hash = shortHash(payload.base64.slice(0, 4096) + payload.base64.length);
		const name = `${base}-${hash}`;
		this.icons.set(url, name);
		this.files.push({
			path: `${ICON_DIR}/${name}.svg`,
			contents: payload.base64,
			encoding: "base64",
		});
		return name;
	}

	private readonly icons = new Map<string, string>();

	async register(url: string): Promise<AssetRegistryEntry | undefined> {
		const existing = this.entries.get(url);
		if (existing) return existing;

		const { base, ext } = sanitizeAssetName(url);
		const identifier = importIdentifier(base, this.taken);

		let payload: AssetPayload | undefined;
		if (this.mode === "assets" && this.fetchAsset) {
			payload = await this.download(url);
		}

		// No bytes means no local file, and an import pointing at a CDN URL would
		// simply fail to resolve. The caller leaves the original markup in place
		// instead, so the component still renders from the CDN.
		if (!payload) {
			this.anyUnbundled = true;
			return undefined;
		}

		const hash = shortHash(payload.base64.slice(0, 4096) + payload.base64.length);
		const fileName = `${base}-${hash}.${ext}`;
		const entry: AssetRegistryEntry = {
			identifier,
			specifier: assetSpecifier(this.assetsDir, fileName),
			bundled: true,
		};
		this.entries.set(url, entry);
		this.files.push({
			path: `${this.assetsDir}/${fileName}`,
			contents: payload.base64,
			encoding: "base64",
		});
		return entry;
	}

	private async download(url: string): Promise<AssetPayload | undefined> {
		const remaining = MAX_TOTAL_BYTES - this.totalBytes;
		if (remaining <= 0) {
			this.warnings.draft(
				"asset-budget-exceeded",
				"Stopped downloading images after 50 MB — the remaining ones still point at the CodeStitch CDN.",
			);
			return undefined;
		}
		try {
			// The budget is passed down so the fetch aborts mid-stream rather than
			// letting one final asset overshoot it.
			const payload = await this.fetchAsset!(url, remaining);
			if (!payload) {
				this.warnings.draft(
					"asset-download-failed",
					`Could not download ${url}, so the component still points at the CodeStitch CDN for it.`,
				);
				return undefined;
			}

			// Prefer the exact size; fall back to the base64 estimate (4 chars per
			// 3 bytes, minus padding) when a stub or older worker omits it.
			const size = payload.byteLength ?? decodedBase64Length(payload.base64);
			if (size > remaining) {
				this.warnings.draft(
					"asset-budget-exceeded",
					`${url} would push this conversion past the 50 MB image budget, so it still points at the CodeStitch CDN.`,
				);
				return undefined;
			}
			this.totalBytes += size;
			return payload;
		} catch (err) {
			this.warnings.draft(
				"asset-download-failed",
				`Could not download ${url} (${(err as Error).message}), so the component still points at the CodeStitch CDN for it.`,
			);
			return undefined;
		}
	}
}

/** Decoded byte length of a base64 string, without decoding it. */
function decodedBase64Length(base64: string): number {
	const padding = base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0;
	return Math.max(0, (base64.length * 3) / 4 - padding);
}

function attr(el: Element, name: string): string | undefined {
	const value = el.getAttribute(name);
	return value === null || value === "" ? undefined : value;
}

function hasAttribute(el: Element, name: string): boolean {
	return el.hasAttribute(name);
}

function isAriaHidden(el: Element): boolean {
	return el.getAttribute("aria-hidden")?.toLowerCase() === "true";
}

function isSvgUrl(url: string): boolean {
	return sanitizeAssetName(url).ext === "svg";
}

/** Astro's image service can optimise these formats without a format hint. */
function isSupportedRasterExtension(ext: string): boolean {
	return SUPPORTED_RASTER_EXTENSIONS.has(ext);
}

function isEligibleRasterUrl(url: string | undefined): url is string {
	return Boolean(url && isStitchCdnUrl(url) && !isSvgUrl(url));
}

interface ImageCandidate {
	element: Element;
	/** A picture candidate is represented by its fallback, but is prioritised as a picture. */
	fallback?: Element;
}

function elementsInDomOrder(roots: Element[]): Element[] {
	const elements: Element[] = [];
	for (const root of roots) {
		if (root.matches("picture, img")) elements.push(root);
		elements.push(...Array.from(root.querySelectorAll("picture, img")));
	}
	return elements;
}

/** Selects once, before downloads begin, so a failed asset can never promote another one. */
function firstEligibleRasterCandidate(roots: Element[]): ImageCandidate | undefined {
	for (const element of elementsInDomOrder(roots)) {
		const tag = element.tagName.toLowerCase();
		if (tag === "picture") {
			const fallback = element.querySelector("img");
			if (fallback && isEligibleRasterUrl(attr(fallback, "src"))) {
				return { element, fallback };
			}
			continue;
		}
		if (element.parentElement?.closest("picture")) continue;
		if (isEligibleRasterUrl(attr(element, "src"))) return { element };
	}
	return undefined;
}

function altState(element: Element): {
	hasAlt: boolean;
	value: string;
	announced: boolean;
} {
	const hasAlt = hasAttribute(element, "alt");
	const value = element.getAttribute("alt") ?? "";
	return { hasAlt, value, announced: value.trim().length > 0 };
}

function missingAltComment(doc: Document): Comment {
	return doc.createComment("TODO: add descriptive alt text to this image");
}

function addPriority(attrs: Record<string, string>): void {
	delete attrs.loading;
	delete attrs.decoding;
	delete attrs.fetchpriority;
	attrs.priority = "";
}

function applyImageLayout(
	attrs: Record<string, string>,
	imageLayout: KitProfile["imageLayout"],
): void {
	// A missing config value needs an explicit constrained choice because Astro's
	// own default is none. An explicit constrained value is already supplied by
	// the pinned kit config, while other explicit values stay self-describing in
	// the generated component, including an explicit none.
	if (imageLayout === null) {
		attrs.layout = "constrained";
	} else if (imageLayout !== "constrained") {
		attrs.layout = imageLayout;
	}
}

function replaceWithComments(
	source: Element,
	replacement: Element,
	comments: Comment[],
): void {
	if (comments.length === 0) {
		source.replaceWith(replacement);
		return;
	}
	source.replaceWith(comments[0]!);
	let last: Node = comments[0]!;
	for (const comment of comments.slice(1)) {
		last.parentNode?.insertBefore(comment, last.nextSibling);
		last = comment;
	}
	last.parentNode?.insertBefore(replacement, last.nextSibling);
}

/** Distinct source files behind a <picture>, ignoring query strings. */
function distinctBasenames(urls: string[]): string[] {
	return [...new Set(urls.map((u) => sanitizeAssetName(u).base))];
}

interface PictureSource {
	media?: string;
	type?: string;
	url: string;
	/**
	 * True when the source carried more than one candidate, a density/width
	 * descriptor, or a media query outside the plain min-/max-width form. Such a
	 * source cannot be reproduced by the kits' components, so it is never
	 * silently reduced to its first candidate.
	 */
	complex: boolean;
	/** The candidates that would be dropped, for the warning text. */
	droppedCandidates: string[];
}

/** A media query the CSPicture contract can express. */
function isSimpleMediaQuery(media: string | undefined): boolean {
	if (!media) return false;
	return /^\(\s*(min|max)-width:\s*[\d.]+(px|r?em)\s*\)$/i.test(media.trim());
}

function parseSrcset(srcset: string): {
	url?: string;
	complex: boolean;
	dropped: string[];
} {
	const candidates = srcset
		.split(",")
		.map((c) => c.trim())
		.filter(Boolean);
	if (candidates.length === 0) return { complex: false, dropped: [] };

	const [first, ...rest] = candidates as [string, ...string[]];
	const parts = first.split(/\s+/);
	const url = parts[0];
	// A descriptor (2x, 800w) means the browser picks between renditions.
	const hasDescriptor = parts.length > 1;

	return {
		url,
		complex: hasDescriptor || rest.length > 0,
		dropped: hasDescriptor ? candidates : rest,
	};
}

function collectPictureUrls(picture: Element): {
	sources: PictureSource[];
	fallback?: Element;
	fallbackUrl?: string;
} {
	const sources: PictureSource[] = [];
	for (const source of Array.from(picture.querySelectorAll("source"))) {
		const srcset = attr(source, "srcset");
		if (!srcset) continue;
		const { url, complex, dropped } = parseSrcset(srcset);
		if (!url) continue;
		const media = attr(source, "media");
		sources.push({
			media,
			type: attr(source, "type"),
			url,
			// An unrecognised media query is as unreproducible as a multi-candidate
			// srcset, so it counts as complex too.
			complex: complex || (media !== undefined && !isSimpleMediaQuery(media)),
			droppedCandidates: dropped,
		});
	}
	const fallback = picture.querySelector("img") ?? undefined;
	return { sources, fallback, fallbackUrl: fallback ? attr(fallback, "src") : undefined };
}

/**
 * Builds an Astro component element the serializer will emit as `<Tag … />`.
 *
 * Created outside the HTML namespace on purpose: HTML elements upper-case their
 * tag name and lower-case their attributes, which would turn `<Picture
 * pictureAttributes=…>` into `<PICTURE pictureattributes=…>`. In the null
 * namespace both keep the exact casing Astro needs.
 */
function componentEl(doc: Document, tag: string, attrs: Record<string, string>): Element {
	const el = doc.createElementNS(null, tag);
	el.setAttribute(COMPONENT_MARKER, "");
	for (const [name, value] of Object.entries(attrs)) el.setAttribute(name, value);
	return el;
}

export interface ImagesPassOptions {
	doc: Document;
	roots: Element[];
	mode: ImagesMode;
	profile: KitProfile;
	warnings: WarningCollector;
	fetchAsset?: FetchAsset;
	/** Kit-relative folder for downloaded images. */
	assetsDir: string;
	/** Remote URLs found in the stylesheet, rewritten via define:vars. */
	cssUrls: CssUrlRef[];
	/** Explicit opt-in; the core never infers hero status from a section id. */
	prioritizeFirstImage?: boolean;
}

/**
 * Rewrites stitch imagery to the kit's own conventions, or leaves it on the CDN
 * when the user asked for raw markup.
 */
export async function applyImagesPass(
	options: ImagesPassOptions,
): Promise<ImagesResult> {
	const {
		doc,
		roots,
		mode,
		profile,
		warnings,
		fetchAsset,
		cssUrls,
		assetsDir,
		prioritizeFirstImage = false,
	} = options;
	const registry = new AssetRegistry(mode, warnings, assetsDir, fetchAsset);
	const imports: ImportSpec[] = [];
	const cssVars: ImagesResult["cssVars"] = [];
	const priorityCandidate = prioritizeFirstImage
		? firstEligibleRasterCandidate(roots)
		: undefined;
	let missingAltCount = 0;
	let responsiveAttrsRemoved = 0;

	const addImport = (entry: AssetRegistryEntry, sourceUrl: string) => {
		if (imports.some((i) => i.identifier === entry.identifier)) return;
		imports.push({
			identifier: entry.identifier,
			specifier: entry.specifier,
			sourceUrl,
			group: "Images",
		});
	};

	if (mode === "raw") {
		// Markup is left exactly as CodeStitch wrote it.
		if (cssUrls.length > 0 || roots.some((r) => r.querySelector("img, picture"))) {
			warnings.info(
				"images-raw",
				"Images still load from the CodeStitch CDN. Swap them for local assets before going live.",
			);
		}
		return { imports, files: [], cssVars, anyUnbundled: false };
	}

	for (const root of roots) {
		// --- <picture> elements ---
		for (const picture of Array.from(root.querySelectorAll("picture"))) {
			const { sources, fallback, fallbackUrl } = collectPictureUrls(picture);
			const allUrls = [...sources.map((s) => s.url), ...(fallbackUrl ? [fallbackUrl] : [])]
				.filter(isStitchCdnUrl);

			if (allUrls.length === 0 || !fallback) continue;

			const fallbackAlt = altState(fallback);
			const fallbackAttrs = extractSourceAttributes(fallback, "raster");
			const pictureAttrs = extractSourceAttributes(picture, "picture");
			const needsMissingAlt =
				!fallbackAlt.hasAlt && !isAriaHidden(fallback) && !isAriaHidden(picture);
			const artDirected = distinctBasenames(allUrls).length > 1;
			const isPriorityCandidate = priorityCandidate?.element === picture;

			// Art direction maps onto CSPicture only when the stitch matches its
			// contract exactly: two media sources plus a fallback, simple srcsets.
			// Any source the kits' components cannot reproduce — several srcset
			// candidates, a density/width descriptor, an exotic media query, a
			// format switch — is reported rather than quietly reduced to one URL.
			const complexSources = sources.filter((source) => source.complex);
			const formatSwitching = sources.some((source) => source.type);
			if (complexSources.length > 0 || formatSwitching) {
				const dropped = [
					...new Set(complexSources.flatMap((source) => source.droppedCandidates)),
				];
				warnings.draft(
					"srcset-simplified",
					`This image offered several renditions${
						dropped.length > 0 ? ` (${dropped.slice(0, 3).join(", ")}${dropped.length > 3 ? ", …" : ""})` : ""
					} and only one was kept — restore the rest by hand if you need them.`,
				);
			}

			const mapsToCsPicture =
				artDirected &&
				profile.cspicture.supportsArtDirection &&
				sources.length === 2 &&
				sources.every((source) => isSimpleMediaQuery(source.media) && !source.complex) &&
				!formatSwitching &&
				Boolean(fallbackUrl);

			const comments: Comment[] = [];
			if (needsMissingAlt) comments.push(missingAltComment(doc));

			if (mapsToCsPicture) {
				const [mobile, desktop] = sources as [PictureSource, PictureSource];
				const mobileEntry = await registry.register(mobile.url);
				const desktopEntry = await registry.register(desktop.url);
				const fallbackEntry = await registry.register(fallbackUrl!);
				if (!mobileEntry || !desktopEntry || !fallbackEntry) continue;

				addImport(mobileEntry, mobile.url);
				addImport(desktopEntry, desktop.url);
				addImport(fallbackEntry, fallbackUrl!);

				const replacement = componentEl(doc, "CSPicture", {
					mobileImgUrl: expr(mobileEntry.identifier),
					desktopImgUrl: expr(desktopEntry.identifier),
					fallbackImgUrl: expr(fallbackEntry.identifier),
					alt: fallbackAlt.value,
				});
				const mobileWidth = /max-width:\s*([\d.]+px)/.exec(mobile.media ?? "")?.[1];
				const desktopWidth = /min-width:\s*([\d.]+px)/.exec(desktop.media ?? "")?.[1];
				if (mobileWidth) replacement.setAttribute("mobileMediaWidth", mobileWidth);
				if (desktopWidth) replacement.setAttribute("desktopMediaWidth", desktopWidth);
				if (isPriorityCandidate) {
					comments.push(
						doc.createComment(
							"Note: this art-directed image uses CSPicture, whose kit implementation hard-codes lazy loading, so first-image priority could not be applied.",
						),
					);
					warnings.info(
						"cspicture-priority-limited",
						"The first eligible image is art-directed and uses CSPicture, whose kit implementation hard-codes lazy loading; no later image was promoted.",
					);
				}
				replaceWithComments(picture, replacement, comments);
				if (needsMissingAlt) missingAltCount++;
				if (hasAttribute(fallback, "srcset") || hasAttribute(fallback, "sizes")) {
					responsiveAttrsRemoved++;
				}
				warnings.info(
					"cspicture-used",
					`Used ${profile.label}'s CSPicture component for the art-directed image (separate mobile and desktop files).`,
				);
				continue;
			}

			// Otherwise: a single <Picture> built from the fallback image.
			const chosenUrl = fallbackUrl ?? allUrls[0]!;

			// An SVG cannot go through astro:assets (see registerIcon), so a
			// <picture> wrapping one becomes an <Icon> instead.
			if (isSvgUrl(chosenUrl)) {
				const iconName = await registry.registerIcon(chosenUrl, profile.icons);
				if (!iconName) continue;
				const iconAttrs: Record<string, string> = {
					...extractSourceAttributes(fallback, "icon"),
					...extractSourceAttributes(picture, "icon"),
					name: iconName,
				};
				const sourceTitle = iconAttrs.title;
				delete iconAttrs.alt;
				const decorative = isAriaHidden(fallback) || isAriaHidden(picture);
				if (!decorative && fallbackAlt.announced) iconAttrs.title = fallbackAlt.value;
				else if (!decorative && sourceTitle !== undefined) iconAttrs.title = sourceTitle;
				else delete iconAttrs.title;
				replaceWithComments(picture, componentEl(doc, "Icon", iconAttrs), comments);
				if (needsMissingAlt) missingAltCount++;
				if (hasAttribute(fallback, "srcset") || hasAttribute(fallback, "sizes")) {
					responsiveAttrsRemoved++;
				}
				continue;
			}

			const entry = await registry.register(chosenUrl);
			if (!entry) continue;
			addImport(entry, chosenUrl);

			const attrs: Record<string, string> = {
				src: expr(entry.identifier),
				alt: fallbackAlt.value,
				formats: expr('["avif", "webp"]'),
			};
			for (const [name, value] of Object.entries(fallbackAttrs)) {
				if (name !== "alt") attrs[name] = value;
			}
			if (Object.keys(pictureAttrs).length > 0) {
				// The object is serialised as JavaScript, so data-* keys and quotes
				// inside style values remain valid Astro syntax.
				attrs.pictureAttributes = expr(astroObjectLiteral(pictureAttrs));
			}
			applyImageLayout(attrs, profile.imageLayout);
			if (isPriorityCandidate) addPriority(attrs);

			const replacement = componentEl(doc, "Picture", attrs);

			if (artDirected) {
				const dropped = sources
					.filter((s) => s.media)
					.map((s) => `${s.media} -> ${s.url}`)
					.join("; ");
				comments.push(
					doc.createComment(
						`TODO: this stitch used different images per breakpoint (${dropped}). ` +
							(profile.cspicture.supportsArtDirection
								? "Wire them up with the kit's CSPicture component."
								: `${profile.label}'s CSPicture only takes a single src, so add your own <picture> if you need art direction.`),
					),
				);
				warnings.draft(
					"art-direction-dropped",
					"This stitch shows different images on mobile and desktop, and only the desktop one was kept — see the TODO in the markup.",
				);
			}
			replaceWithComments(picture, replacement, comments);
			if (needsMissingAlt) missingAltCount++;
			if (hasAttribute(fallback, "srcset") || hasAttribute(fallback, "sizes")) {
				responsiveAttrsRemoved++;
			}
		}

		// --- standalone <img> ---
		for (const img of Array.from(root.querySelectorAll("img"))) {
			if (img.parentElement?.closest("picture")) continue;
			const src = attr(img, "src");
			if (!src || !isStitchCdnUrl(src)) continue;

			const { base, ext } = sanitizeAssetName(src);
			const imageAlt = altState(img);
			const sourceAttrs = extractSourceAttributes(img, "raster");
			const needsMissingAlt = !imageAlt.hasAlt && !isAriaHidden(img);
			const comments = needsMissingAlt ? [missingAltComment(doc)] : [];

			// Every SVG goes through astro-icon: astro:assets refuses to process
			// SVG sources, so an <Image> pointing at one fails the build.
			if (ext === "svg") {
				const iconName = await registry.registerIcon(src, profile.icons);
				if (iconName) {
					const iconAttrs: Record<string, string> = {
						...extractSourceAttributes(img, "icon"),
						name: iconName,
					};
					const sourceTitle = iconAttrs.title;
					delete iconAttrs.alt;
					if (!isAriaHidden(img) && imageAlt.announced) iconAttrs.title = imageAlt.value;
					else if (!isAriaHidden(img) && sourceTitle !== undefined) iconAttrs.title = sourceTitle;
					else delete iconAttrs.title;
					replaceWithComments(img, componentEl(doc, "Icon", iconAttrs), comments);
					if (needsMissingAlt) missingAltCount++;
					if (!profile.icons.includes(base)) {
						warnings.info(
							"icon-added",
							`Added ${iconName}.svg to src/icons and rendered it with <Icon> — ${profile.label} had no matching icon.`,
						);
					}
					continue;
				}
				// Download failed: leave the CDN <img> in place rather than emit
				// an import that cannot resolve. registerIcon already warned.
				continue;
			}

			const entry = await registry.register(src);
			if (!entry) continue;
			addImport(entry, src);

			const attrs: Record<string, string> = {
				src: expr(entry.identifier),
				alt: imageAlt.value,
			};
			for (const [name, value] of Object.entries(sourceAttrs)) {
				if (name !== "alt") attrs[name] = value;
			}
			applyImageLayout(attrs, profile.imageLayout);
			if (priorityCandidate?.element === img) addPriority(attrs);
			replaceWithComments(img, componentEl(doc, "Image", attrs), comments);
			if (needsMissingAlt) missingAltCount++;
			if (hasAttribute(img, "srcset") || hasAttribute(img, "sizes")) {
				responsiveAttrsRemoved++;
			}
		}
	}

	if (responsiveAttrsRemoved > 0) {
		warnings.draft(
			"responsive-attrs-removed",
			`Removed srcset/sizes from ${responsiveAttrsRemoved} source ${responsiveAttrsRemoved === 1 ? "image" : "images"} because Astro's <Image>/<Picture> components generate their own responsive sources.`,
		);
	}
	if (missingAltCount > 0) {
		warnings.draft(
			"missing-alt",
			`${missingAltCount} ${missingAltCount === 1 ? "image is" : "images are"} missing alt text; each received alt="" and a nearby TODO so you can add an accessible description or confirm it is decorative.`,
		);
	}

	// --- url(...) references from the stylesheet ---
	for (const ref of cssUrls) {
		const entry = await registry.register(ref.url);
		if (!entry) continue;
		addImport(entry, ref.url);
		cssVars.push({
			varName: `${entry.identifier}Bg`,
			identifier: entry.identifier,
			url: ref.url,
			optimize: isSupportedRasterExtension(sanitizeAssetName(ref.url).ext),
		});
	}

	return {
		imports,
		files: registry.files,
		cssVars,
		anyUnbundled: registry.anyUnbundled,
	};
}
