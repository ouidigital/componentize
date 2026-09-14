import type { WarningCollector } from "../readiness";
import { camelCase } from "../naming";
import { normalizeText } from "./parse";
import { expr } from "./serialize";

/**
 * Replaces user-facing copy with t("namespace:key") lookups and builds the
 * matching locale JSON.
 *
 * Text nodes are translated individually, so markup nested inside a paragraph
 * (a link, a <br>, an <em>) keeps its structure — `set:html` would flatten
 * content and markup into one opaque string, and is only used as a last resort.
 */

export interface I18nResult {
	/** Nested translation tree for the default locale. */
	messages: Record<string, unknown>;
	/** Number of strings extracted. */
	count: number;
}

/** Attributes that hold copy a reader actually sees. */
const TEXT_ATTRIBUTES = ["alt", "aria-label", "title", "placeholder"] as const;

/** Elements whose text is decoration, not copy. */
const SKIP_TAGS = new Set(["script", "style", "svg", "path", "br", "hr"]);

/** Maps a CodeStitch class or tag onto a readable key name. */
function keyNameFor(el: Element): string {
	const classes = (el.getAttribute("class") ?? "").split(/\s+/).filter(Boolean);
	for (const cls of classes) {
		if (cls.startsWith("cs-")) {
			const stem = cls.slice(3);
			if (stem === "button-solid" || stem === "button-transparent") return "button";
			if (stem === "topper") return "topper";
			if (stem === "title") return "title";
			if (stem === "text") return "text";
			return camelCase(stem);
		}
	}
	const tag = el.tagName.toLowerCase();
	if (/^h[1-6]$/.test(tag)) return "title";
	if (tag === "p") return "text";
	if (tag === "a" || tag === "button") return "link";
	if (tag === "li") return "item";
	if (tag === "span") return "label";
	return camelCase(tag);
}

/** A group of sibling elements repeating the same structure (cards, FAQ rows). */
function repeatedGroupKey(el: Element): string | undefined {
	const parent = el.parentElement;
	if (!parent) return undefined;
	const cls = (el.getAttribute("class") ?? "").split(/\s+/).find((c) => c.startsWith("cs-"));
	if (!cls) return undefined;
	const siblings = Array.from(parent.children).filter(
		(c) => c.tagName === el.tagName && (c.getAttribute("class") ?? "").includes(cls),
	);
	if (siblings.length < 2) return undefined;
	const stem = camelCase(cls.slice(3));
	return stem.endsWith("s") ? stem : `${stem}s`;
}

class KeyAllocator {
	private readonly used = new Set<string>();

	take(path: string[]): string {
		const base = path.join(".");
		let candidate = base;
		let n = 2;
		while (this.used.has(candidate)) candidate = `${base}-${n++}`;
		this.used.add(candidate);
		return candidate;
	}
}

function setDeep(tree: Record<string, unknown>, path: string, value: string): void {
	const parts = path.split(".");
	let node: Record<string, unknown> = tree;
	for (let i = 0; i < parts.length - 1; i++) {
		const key = parts[i]!;
		const next = parts[i + 1]!;
		// A numeric next segment means this level is an array.
		if (!(key in node) || typeof node[key] !== "object" || node[key] === null) {
			node[key] = /^\d+$/.test(next) ? [] : {};
		}
		node = node[key] as Record<string, unknown>;
	}
	node[parts[parts.length - 1]!] = value;
}

/** Text nodes with visible content, ignoring whitespace-only ones. */
function meaningfulTextNodes(el: Element): Text[] {
	return Array.from(el.childNodes).filter(
		(n): n is Text => n.nodeType === 3 && normalizeText(n.textContent ?? "").length > 0,
	);
}

function hasElementChildren(el: Element): boolean {
	return Array.from(el.children).some((c) => !SKIP_TAGS.has(c.tagName.toLowerCase()));
}

export interface I18nOptions {
	roots: Element[];
	namespace: string;
	warnings: WarningCollector;
}

export function applyI18nExtraction(options: I18nOptions): I18nResult {
	const { roots, namespace, warnings } = options;
	const messages: Record<string, unknown> = {};
	const keys = new KeyAllocator();
	let count = 0;

	const t = (key: string) => expr(`t("${namespace}:${key}")`);

	/** Path segments accumulated from repeated-structure ancestors. */
	const visit = (el: Element, prefix: string[]): void => {
		const tag = el.tagName.toLowerCase();
		if (SKIP_TAGS.has(tag)) return;

		// Translatable attributes — but not on decorative images.
		if (el.getAttribute("aria-hidden") !== "true") {
			for (const name of TEXT_ATTRIBUTES) {
				const value = el.getAttribute(name);
				if (!value || !value.trim()) continue;
				// Skip values already turned into expressions by an earlier pass.
				if (value.startsWith("⟦")) continue;
				const key = keys.take([...prefix, keyNameFor(el), name === "alt" ? "alt" : camelCase(name)]);
				setDeep(messages, key, normalizeText(value));
				el.setAttribute(name, t(key));
				count++;
			}
		}
		if (tag === "input" || tag === "button") {
			const value = el.getAttribute("value");
			if (value?.trim() && !value.startsWith("⟦")) {
				const key = keys.take([...prefix, keyNameFor(el), "value"]);
				setDeep(messages, key, normalizeText(value));
				el.setAttribute("value", t(key));
				count++;
			}
		}

		// Repeated siblings (cards, FAQ items) become numerically indexed arrays,
		// matching how the kit's own locale files store lists.
		const groupKey = repeatedGroupKey(el);
		let childPrefix = prefix;
		if (groupKey) {
			const parent = el.parentElement!;
			const index = Array.from(parent.children)
				.filter((c) => c.tagName === el.tagName)
				.indexOf(el);
			childPrefix = [...prefix, groupKey, String(index)];
		}

		const textNodes = meaningfulTextNodes(el);
		if (textNodes.length > 0) {
			const name = keyNameFor(el);
			textNodes.forEach((node, i) => {
				const segments =
					textNodes.length > 1
						? [...childPrefix, name, String(i)]
						: [...childPrefix, name];
				const key = keys.take(segments);
				setDeep(messages, key, normalizeText(node.textContent ?? ""));
				node.textContent = t(key);
				count++;
			});
		}

		if (hasElementChildren(el)) {
			for (const child of Array.from(el.children)) {
				visit(child, childPrefix);
			}
		}
	};

	for (const root of roots) {
		for (const child of Array.from(root.children)) visit(child, []);
		// Text sitting directly on the root element.
		for (const node of meaningfulTextNodes(root)) {
			const key = keys.take(["text"]);
			setDeep(messages, key, normalizeText(node.textContent ?? ""));
			node.textContent = t(key);
			count++;
		}
	}

	if (count === 0) {
		warnings.info(
			"i18n-nothing-extracted",
			"No translatable copy was found in this stitch, so no locale file was written.",
		);
	}

	return { messages, count };
}
