import type { CssVariant, StitchData } from "@core/types";
import {
	GET_CODE_PREFIX,
	PremiumLockedError,
	SEL,
	SelectorDriftError,
	StitchUnavailableError,
	coreTextarea,
	pageErrorDetail,
	stitchIdFromUrl,
} from "./selectors";

/** One stored code record, exactly as CodeStitch serialises it. */
export interface GetCodeCode {
	/** "HTML", "CSS", "CSS Dark", "LESS", "SCSS Dark", "JS", or an agency type such as "PHP". */
	typeName: string;
	/** "html" | "css" | "js". */
	type: string;
	/**
	 * Not trustworthy: on stitch 2501 the "CSS Dark" record carries
	 * `isDark: false`. Variants are keyed by typeName instead.
	 */
	isDark?: boolean | null;
	name?: string | null;
	content: string;
}

/** The parts of `window.GET_CODE` the extension reads. */
export interface GetCodeData {
	stitch: {
		id: number | string;
		title: string;
		section: string | null;
		category: string | null;
		codes: GetCodeCode[];
	};
	showCoreStyles: boolean;
	loggedIn: boolean;
	saveUrl: string | null;
	preferences: unknown;
}

const CSS_VARIANTS: readonly CssVariant[] = [
	"CSS",
	"CSS Dark",
	"LESS",
	"LESS Dark",
	"SCSS",
	"SCSS Dark",
];

const CORE_KEYS = [
	["css", "CSS"],
	["less", "LESS"],
	["scss", "SCSS"],
] as const;

/** The inline script that defines the stitch, if the page has one. */
export function findGetCodeScript(doc: ParentNode): HTMLScriptElement | undefined {
	for (const script of doc.querySelectorAll<HTMLScriptElement>(SEL.getCodeScript)) {
		if (GET_CODE_PREFIX.test(script.textContent ?? "")) return script;
	}
	return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isCode(value: unknown): value is GetCodeCode {
	return (
		isRecord(value) &&
		typeof value["typeName"] === "string" &&
		typeof value["type"] === "string" &&
		typeof value["content"] === "string"
	);
}

/**
 * Parses the text of the GET_CODE script: `window.GET_CODE = {...};`.
 *
 * Anything that is not that exact shape is a layout change, not a bad stitch.
 */
export function parseGetCode(text: string): GetCodeData {
	const drift = () => new SelectorDriftError("GET_CODE stitch data");
	if (!GET_CODE_PREFIX.test(text)) throw drift();

	const json = text.replace(GET_CODE_PREFIX, "").replace(/;\s*$/, "");
	let data: unknown;
	try {
		data = JSON.parse(json);
	} catch {
		throw drift();
	}

	if (!isRecord(data) || !isRecord(data["stitch"])) throw drift();
	const stitch = data["stitch"];
	const codes = stitch["codes"];
	if (!Array.isArray(codes) || !codes.every(isCode)) throw drift();

	const text_ = (v: unknown) => (typeof v === "string" ? v : null);
	return {
		stitch: {
			id: typeof stitch["id"] === "number" ? stitch["id"] : String(stitch["id"] ?? ""),
			title: text_(stitch["title"]) ?? "",
			section: text_(stitch["section"]),
			category: text_(stitch["category"]),
			codes,
		},
		showCoreStyles: data["showCoreStyles"] !== false,
		loggedIn: data["loggedIn"] === true,
		saveUrl: text_(data["saveUrl"]),
		preferences: data["preferences"] ?? null,
	};
}

/**
 * The CSS variant a stored code type stands for. CodeStitch treats SASS as
 * SCSS, so does this. Agency-specific types are not variants.
 */
export function cssVariantFor(typeName: string): CssVariant | undefined {
	const name = typeName
		.toUpperCase()
		.replace(/\s+/g, " ")
		.trim()
		.replace(/^SASS\b/, "SCSS");
	return CSS_VARIANTS.find((variant) => variant.toUpperCase() === name);
}

/** CodeStitch stores code with Windows line endings; nothing downstream wants them. */
function lf(text: string): string {
	return text.replace(/\r\n?/g, "\n");
}

/**
 * Reads a stitch from its Get code page.
 *
 * The URL stays the stitch's identity: it is what decided the panel should
 * mount at all, and a client-side navigation can leave a stale document behind
 * a new URL for a moment.
 */
export function scrapeStitch(doc: Document, url: string): StitchData {
	const id = stitchIdFromUrl(url);
	if (!id) throw new SelectorDriftError("stitch id in URL");

	const script = findGetCodeScript(doc);
	if (!script) {
		// Distinguish "CodeStitch refused to show this" from "CodeStitch changed".
		const detail = pageErrorDetail(doc);
		if (detail) throw new StitchUnavailableError(detail);
		throw new SelectorDriftError("GET_CODE stitch data");
	}
	const data = parseGetCode(script.textContent ?? "");
	const codes = data.stitch.codes;

	// Prefer the type literally named HTML, as CodeStitch's own export does, so
	// an agency type such as "PHP" (type html) is not picked by accident.
	const htmlCodes = codes.filter((c) => c.type === "html");
	const htmlCode =
		htmlCodes.find((c) => c.typeName.toUpperCase() === "HTML") ?? htmlCodes[0];
	if (!htmlCode?.content.trim()) throw new PremiumLockedError();

	const jsCode = codes.find((c) => c.type === "js" && c.content.trim());

	const css: Partial<Record<CssVariant, string>> = {};
	for (const code of codes) {
		if (code.type !== "css" || !code.content.trim()) continue;
		const variant = cssVariantFor(code.typeName);
		if (variant && !(variant in css)) css[variant] = lf(code.content);
	}

	const coreStyles: Partial<Record<"CSS" | "LESS" | "SCSS", string>> = {};
	for (const [flavour, key] of CORE_KEYS) {
		const value = doc.querySelector<HTMLTextAreaElement>(coreTextarea(flavour))?.value;
		if (value?.trim()) coreStyles[key] = lf(value);
	}

	return {
		id,
		url,
		html: lf(htmlCode.content),
		js: jsCode ? lf(jsCode.content) : undefined,
		css,
		coreStyles,
		categoryHeading: data.stitch.category?.trim() || undefined,
	};
}
