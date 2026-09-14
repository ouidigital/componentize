import type { CssVariant, StitchData } from "@core/types";
import {
	CM_TYPE,
	PremiumLockedError,
	SEL,
	SelectorDriftError,
	StitchUnavailableError,
	pageErrorDetail,
	queryAllRequired,
	stitchIdFromUrl,
	type CodeType,
} from "./selectors";

const CSS_VARIANTS: readonly CssVariant[] = [
	"CSS",
	"CSS Dark",
	"LESS",
	"LESS Dark",
	"SCSS",
	"SCSS Dark",
];

const CORE_KEYS = ["CSS", "LESS", "SCSS"] as const;

/** Reads a .tab's textarea value by data-codeid. */
function codeById(doc: ParentNode, codeId: string): string | undefined {
	const tab = doc.querySelector(`#CODE_TABS .CODE_TABS__BODY div.tab[data-codeid="${CSS.escape(codeId)}"]`);
	const ta = tab?.querySelector<HTMLTextAreaElement>(SEL.textarea);
	const value = ta?.value;
	return value && value.trim() ? value : undefined;
}

/**
 * Content sniffing — the last line of defence if both data-codetype and
 * data-cmtype disappear. Mirrors the shapes verified on live stitch pages.
 */
function sniffVariant(code: string): CssVariant | "core" | undefined {
	const head = code.trimStart();
	if (head.startsWith(":root")) return "core";

	const dark = /body\.dark-mode/.test(code);
	// LESS keeps parens division; SCSS rewrites it to calc().
	if (/\(\d+\s*\/\s*16r?em\)/.test(code)) return dark ? "LESS Dark" : "LESS";
	if (/calc\(\s*\d+\s*\/\s*16\s*\*\s*1r?em\s*\)/.test(code)) {
		return dark ? "SCSS Dark" : "SCSS";
	}
	if (/[#.][\w-]+\s*\{[^}]*\}\s*[\r\n]+\s*[#.]/.test(code)) {
		return dark ? "CSS Dark" : "CSS";
	}
	return undefined;
}

/**
 * Scrapes every code field from a stitch page.
 *
 * Layered classification: (1) data-codetype tab links + data-css-type radios,
 * (2) textarea data-cmtype, (3) content sniffing.
 */
export function scrapeStitch(doc: Document, url: string): StitchData {
	const id = stitchIdFromUrl(url);
	if (!id) throw new SelectorDriftError("stitch id in URL");

	if (!doc.querySelector(SEL.codeTabs)) {
		// Distinguish "CodeStitch refused to show this" from "CodeStitch changed".
		const detail = pageErrorDetail(doc);
		if (detail) throw new StitchUnavailableError(detail);
		throw new SelectorDriftError("#CODE_TABS code viewer");
	}
	const tabs = queryAllRequired(doc, SEL.tabs, "code tab panels");

	// Any content at all? Empty textareas across the board means locked/premium.
	const anyContent = tabs.some((t) => {
		const ta = t.querySelector<HTMLTextAreaElement>(SEL.textarea);
		return !!ta?.value.trim();
	});
	if (!anyContent) throw new PremiumLockedError();

	const links = Array.from(
		doc.querySelectorAll<HTMLAnchorElement>(SEL.tabLinks),
	);
	const linkOf = (type: CodeType) =>
		links.find((a) => a.dataset["codetype"] === type);

	// --- HTML (required) ---
	let html = ((): string | undefined => {
		const codeId = linkOf("html")?.dataset["codeid"];
		if (codeId) return codeById(doc, codeId);
		return undefined;
	})();

	// --- JS (optional: the tab only exists when the stitch ships JS) ---
	let js = ((): string | undefined => {
		const codeId = linkOf("js")?.dataset["codeid"];
		if (codeId) return codeById(doc, codeId);
		return undefined;
	})();

	// --- CSS variants, from the authoritative radios ---
	const css: Partial<Record<CssVariant, string>> = {};
	for (const radio of doc.querySelectorAll<HTMLInputElement>(SEL.cssRadios)) {
		const variant = radio.dataset["cssType"] as CssVariant | undefined;
		if (!variant || !CSS_VARIANTS.includes(variant)) continue;
		const code = codeById(doc, radio.value);
		if (code) css[variant] = code;
	}

	// --- Core styles (fixed codeids) ---
	const coreStyles: Partial<Record<"CSS" | "LESS" | "SCSS", string>> = {};
	for (const key of CORE_KEYS) {
		const code = codeById(doc, `core-styles-${key}`);
		if (code) coreStyles[key] = code;
	}

	// --- Fallback ladder for anything still missing ---
	if (!html || !js || Object.keys(css).length === 0) {
		for (const tab of tabs) {
			const ta = tab.querySelector<HTMLTextAreaElement>(SEL.textarea);
			const code = ta?.value;
			if (!code?.trim()) continue;
			const cmType = ta?.dataset["cmtype"];

			if (!html && cmType === CM_TYPE.html) {
				html = code;
				continue;
			}
			if (!js && cmType === CM_TYPE.js) {
				js = code;
				continue;
			}
			if (cmType === CM_TYPE.css || !cmType) {
				const sniffed = sniffVariant(code);
				if (!sniffed) continue;
				if (sniffed === "core") {
					coreStyles.CSS ??= code;
				} else if (!css[sniffed]) {
					css[sniffed] = code;
				}
			}
		}
	}

	if (!html) throw new SelectorDriftError("HTML code field");

	const categoryHeading =
		doc.querySelector(SEL.heading)?.textContent?.trim() || undefined;

	return { id, url, html, js, css, coreStyles, categoryHeading };
}
