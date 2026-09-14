/**
 * Serialises a transformed DOM to Astro markup.
 *
 * Transform passes never write Astro syntax into the DOM. Instead they wrap
 * values in sentinels, and this module — the only one that knows what Astro
 * expressions look like — turns them into `{expr}` / `attr={expr}` on the way
 * out. That keeps every pass a plain DOM operation and keeps the escaping rules
 * in exactly one place.
 */

const OPEN = "⟦expr:";
const CLOSE = "⟧";

/** Wraps a JS expression so the serializer emits it unquoted. */
export function expr(code: string): string {
	return `${OPEN}${code}${CLOSE}`;
}

export function isExpr(value: string): boolean {
	return value.startsWith(OPEN) && value.endsWith(CLOSE);
}

export function exprCode(value: string): string {
	return value.slice(OPEN.length, -CLOSE.length);
}

/** Splits text that mixes literal runs with sentinels. */
function splitSentinels(text: string): Array<{ literal: boolean; value: string }> {
	const parts: Array<{ literal: boolean; value: string }> = [];
	let rest = text;
	while (rest.length > 0) {
		const start = rest.indexOf(OPEN);
		if (start === -1) {
			parts.push({ literal: true, value: rest });
			break;
		}
		if (start > 0) parts.push({ literal: true, value: rest.slice(0, start) });
		const end = rest.indexOf(CLOSE, start);
		if (end === -1) {
			parts.push({ literal: true, value: rest.slice(start) });
			break;
		}
		parts.push({
			literal: false,
			value: rest.slice(start + OPEN.length, end),
		});
		rest = rest.slice(end + CLOSE.length);
	}
	return parts;
}

/** Elements that carry no closing tag. */
const VOID_ELEMENTS = new Set([
	"area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta",
	"param", "source", "track", "wbr",
]);

/** Elements whose children stay on one line with their text. */
const INLINE_ELEMENTS = new Set([
	"a", "abbr", "b", "br", "button", "cite", "code", "em", "i", "img", "kbd",
	"label", "mark", "picture", "q", "s", "small", "span", "strong", "sub",
	"sup", "svg", "time", "u", "wbr",
]);

/**
 * Astro components are emitted as elements whose tag name is capitalised, with
 * this marker attribute so multi-line prop formatting can be applied.
 */
export const COMPONENT_MARKER = "data-cz-component";

function escapeText(text: string): string {
	return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function escapeAttr(value: string): string {
	return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
}

function serializeAttrs(el: Element): string[] {
	const out: string[] = [];
	for (const attr of Array.from(el.attributes)) {
		if (attr.name === COMPONENT_MARKER) continue;
		const value = attr.value;
		if (isExpr(value)) {
			out.push(`${attr.name}={${exprCode(value)}}`);
		} else if (value === "") {
			// Boolean-ish attributes keep their bare form.
			out.push(/^(disabled|checked|required|readonly|autofocus|hidden|inert|priority)$/.test(attr.name)
				? attr.name
				: `${attr.name}=""`);
		} else {
			out.push(`${attr.name}="${escapeAttr(value)}"`);
		}
	}
	return out;
}

function serializeTextNode(text: string): string {
	return splitSentinels(text)
		.map((part) => (part.literal ? escapeText(part.value) : `{${part.value}}`))
		.join("");
}

/** True when an element's children can all sit on one line. */
function isInlineContent(el: Element): boolean {
	if (el.hasAttribute(COMPONENT_MARKER)) return false;
	return Array.from(el.childNodes).every((node) => {
		if (node.nodeType === 3) return true; // text
		if (node.nodeType === 8) return false; // comment
		if (node.nodeType !== 1) return true;
		const child = node as Element;
		return (
			INLINE_ELEMENTS.has(child.tagName.toLowerCase()) &&
			!child.hasAttribute(COMPONENT_MARKER) &&
			isInlineContent(child)
		);
	});
}

function hasMeaningfulContent(el: Element): boolean {
	return Array.from(el.childNodes).some((node) => {
		if (node.nodeType === 3) return (node.textContent ?? "").trim().length > 0;
		return node.nodeType === 1 || node.nodeType === 8;
	});
}

function serializeNode(node: Node, depth: number, out: string[]): void {
	const pad = "\t".repeat(depth);

	// Text
	if (node.nodeType === 3) {
		const raw = node.textContent ?? "";
		const text = raw.replace(/\s+/g, " ").trim();
		if (text) out.push(`${pad}${serializeTextNode(text)}`);
		return;
	}

	// Comment
	if (node.nodeType === 8) {
		const data = (node as Comment).data.trim();
		if (data) out.push(`${pad}<!-- ${data} -->`);
		return;
	}

	if (node.nodeType !== 1) return;

	const el = node as Element;
	const isComponent = el.hasAttribute(COMPONENT_MARKER);
	const tag = isComponent ? el.tagName : el.tagName.toLowerCase();
	const attrs = serializeAttrs(el);
	const isVoid = VOID_ELEMENTS.has(el.tagName.toLowerCase());

	// Components and self-closing tags: one attribute per line when there are
	// several, matching how the kits format <Picture …/>.
	if (isComponent || isVoid) {
		const selfClosing = isComponent || isVoid;
		if (attrs.length > 2) {
			out.push(`${pad}<${tag}`);
			for (const attr of attrs) out.push(`${pad}\t${attr}`);
			out.push(`${pad}${selfClosing ? "/>" : ">"}`);
		} else {
			const attrStr = attrs.length ? ` ${attrs.join(" ")}` : "";
			out.push(`${pad}<${tag}${attrStr}${selfClosing ? " />" : ">"}`);
		}
		if (isComponent && !isVoid && hasMeaningfulContent(el)) {
			// Components with children are rare here; emit them expanded.
			out.pop();
			const attrStr = attrs.length ? ` ${attrs.join(" ")}` : "";
			out.push(`${pad}<${tag}${attrStr}>`);
			for (const child of Array.from(el.childNodes)) {
				serializeNode(child, depth + 1, out);
			}
			out.push(`${pad}</${tag}>`);
		}
		return;
	}

	const attrStr = attrs.length ? ` ${attrs.join(" ")}` : "";

	if (!hasMeaningfulContent(el)) {
		out.push(`${pad}<${tag}${attrStr}></${tag}>`);
		return;
	}

	if (isInlineContent(el)) {
		const inner: string[] = [];
		for (const child of Array.from(el.childNodes)) {
			if (child.nodeType === 3) {
				const text = (child.textContent ?? "").replace(/\s+/g, " ");
				if (text.trim()) {
					inner.push(
						inner.length === 0 ? serializeTextNode(text.trimStart()) : serializeTextNode(text),
					);
				} else if (inner.length > 0) {
					inner.push(" ");
				}
			} else if (child.nodeType === 1) {
				const nested: string[] = [];
				serializeNode(child, 0, nested);
				inner.push(nested.map((l) => l.trim()).join(""));
			}
		}
		const joined = inner.join("").replace(/\s+/g, " ").trim();
		if (joined.length + pad.length + tag.length * 2 < 110) {
			out.push(`${pad}<${tag}${attrStr}>${joined}</${tag}>`);
			return;
		}
	}

	out.push(`${pad}<${tag}${attrStr}>`);
	for (const child of Array.from(el.childNodes)) {
		serializeNode(child, depth + 1, out);
	}
	out.push(`${pad}</${tag}>`);
}

/** Serialises the stitch's root elements as tab-indented Astro markup. */
export function serializeRoots(roots: Element[]): string {
	const out: string[] = [];
	for (const root of roots) {
		serializeNode(root, 0, out);
		out.push("");
	}
	return out.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd();
}
