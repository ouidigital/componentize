/**
 * Serialises a transformed DOM to Astro markup.
 *
 * Transform passes never write Astro syntax into the DOM. Instead they wrap
 * values in sentinels, and this module — the only one that knows what Astro
 * expressions look like — turns them into `{expr}` / `attr={expr}` on the way
 * out. That keeps every pass a plain DOM operation and keeps the escaping rules
 * in exactly one place.
 *
 * It is also the only module that decides where a line may break, which is a
 * correctness question rather than a cosmetic one. Astro 7 removes whitespace
 * that contains a newline (`compressHTML: "jsx"`), while `compressHTML: true`
 * collapses it to a single space. So a break inserted where the source had no
 * whitespace invents a space in one mode, and a break where the source did have
 * one loses it in the other. Breaks therefore happen only at real source
 * whitespace, and carry an explicit `{" "}` so both modes render the same.
 */

import { hasSourceEdgeWhitespace } from "./whitespace";

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

/** An explicit space, preserved under every `compressHTML` setting. */
const SPACE_EXPRESSION = '{" "}';

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

/** Longest single line the inline form is allowed to produce. */
const MAX_INLINE_WIDTH = 110;

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

/** The rendered text of a node, with runs of whitespace collapsed and trimmed. */
function textOf(node: Node): string {
	return (node.textContent ?? "").replace(/\s+/g, " ").trim();
}

/** True when this node renders nothing at all. */
function isRendered(node: Node): boolean {
	if (node.nodeType === 3) return textOf(node).length > 0;
	if (node.nodeType === 8) return ((node as Comment).data ?? "").trim().length > 0;
	return node.nodeType === 1;
}

/**
 * True when whitespace next to this node is visible to a reader.
 *
 * Between two block elements it is not, so their formatting stays free. Text,
 * inline elements and the image components that stand in for them all sit in
 * the text flow, where a space either appears or does not.
 */
function isSpacingSensitive(node: Node): boolean {
	if (node.nodeType === 3) return true;
	if (node.nodeType !== 1) return false;
	const el = node as Element;
	return (
		el.hasAttribute(COMPONENT_MARKER) ||
		INLINE_ELEMENTS.has(el.tagName.toLowerCase())
	);
}

/**
 * True when whitespace between two nodes would actually be seen.
 *
 * Both sides have to sit in the text flow. A space between two block elements
 * renders as nothing, and one next to a comment renders as nothing either —
 * only a run of text and the inline things beside it can show a gap.
 */
function spacingVisibleBetween(a: Node, b: Node): boolean {
	return isSpacingSensitive(a) && isSpacingSensitive(b);
}

interface Child {
	node: Node;
	/** True when source whitespace stood between this node and the one before. */
	separated: boolean;
}

interface ChildList {
	items: Child[];
	/** True when the source had whitespace just inside the opening tag. */
	leading: boolean;
	/** True when the source had whitespace just inside the closing tag. */
	trailing: boolean;
}

/**
 * The children that render, each tagged with whether the source separated it
 * from its predecessor.
 *
 * The whitespace is read from the snapshot taken at parse time, because text
 * extraction replaces a node's text with a translation lookup and drops the
 * spaces that were around it.
 */
function renderedChildren(el: Element): ChildList {
	const items: Child[] = [];
	let pending = false;
	let leading = false;

	for (const node of Array.from(el.childNodes)) {
		if (node.nodeType === 3 && !isRendered(node)) {
			// A whitespace-only node renders nothing but does separate its neighbours.
			pending = true;
			continue;
		}
		if (!isRendered(node)) continue;

		if (node.nodeType === 8) {
			// A comment renders nothing, so whitespace carries straight across it:
			// `pending` is recorded but deliberately not cleared.
			if (items.length === 0) leading = pending;
			items.push({ node, separated: items.length > 0 && pending });
			continue;
		}

		const separated = pending || hasSourceEdgeWhitespace(node, "leading");
		if (items.length === 0) leading = separated;
		items.push({ node, separated: items.length > 0 && separated });
		pending = hasSourceEdgeWhitespace(node, "trailing");
	}

	return { items, leading, trailing: pending };
}

/**
 * True when this element's content may be spread over several lines.
 *
 * Indenting content onto its own line puts whitespace just inside the tags.
 * Where the source had none — `<a class="cs-button-solid">Read more</a>` — that
 * would add a space inside the link, so the element stays on one line however
 * long it runs.
 */
function canBreakInside(list: ChildList): boolean {
	const first = list.items[0]?.node;
	const last = list.items[list.items.length - 1]?.node;
	if (!first || !last) return true;
	return (
		(!isSpacingSensitive(first) || list.leading) &&
		(!isSpacingSensitive(last) || list.trailing)
	);
}

/**
 * Children grouped into runs that must share a line.
 *
 * A run holds nodes the source wrote with nothing between them, so breaking
 * the line would add a space that the design never had.
 */
function groupChildren(children: Child[]): Child[][] {
	const groups: Child[][] = [];
	for (const child of children) {
		const current = groups[groups.length - 1];
		const previous = current?.[current.length - 1];
		if (current && previous && !child.separated && spacingVisibleBetween(previous.node, child.node)) {
			current.push(child);
		} else {
			groups.push([child]);
		}
	}
	return groups;
}

/**
 * True when a visible space belongs after the group at `index`.
 *
 * The space is attached to the last group that actually renders something, and
 * the search for its partner skips comments: in `<picture/> <!-- next --> `
 * `<picture/>` the gap belongs between the two pictures, not after the comment.
 */
function needsSpaceAfter(groups: Child[][], index: number): boolean {
	const previous = groups[index]?.[groups[index]!.length - 1]?.node;
	if (!previous || !isSpacingSensitive(previous)) return false;

	let separated = false;
	for (const group of groups.slice(index + 1)) {
		for (const child of group) {
			separated ||= child.separated;
			if (child.node.nodeType === 8) continue;
			return separated && spacingVisibleBetween(previous, child.node);
		}
	}
	return false;
}

function serializeNode(node: Node, depth: number, out: string[], forceInline = false): void {
	const pad = forceInline ? "" : "\t".repeat(depth);

	// Text
	if (node.nodeType === 3) {
		const text = textOf(node);
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
	const childList = renderedChildren(el);
	const children = childList.items;

	// Components and self-closing tags: one attribute per line when there are
	// several, matching how the kits format <Picture …/>.
	if ((isComponent || isVoid) && children.length === 0) {
		if (attrs.length > 2 && !forceInline) {
			out.push(`${pad}<${tag}`);
			for (const attr of attrs) out.push(`${pad}\t${attr}`);
			out.push(`${pad}/>`);
		} else {
			const attrStr = attrs.length ? ` ${attrs.join(" ")}` : "";
			out.push(`${pad}<${tag}${attrStr} />`);
		}
		return;
	}

	const attrStr = attrs.length ? ` ${attrs.join(" ")}` : "";

	if (children.length === 0) {
		out.push(`${pad}<${tag}${attrStr}></${tag}>`);
		return;
	}

	// One line, when everything fits — or when breaking would change what the
	// markup renders, in which case a long line is the lesser problem.
	const inlineForm = inlineChildren(children);
	if (inlineForm !== undefined) {
		const width = pad.length + tag.length * 2 + inlineForm.length;
		if (forceInline || !canBreakInside(childList) || width < MAX_INLINE_WIDTH) {
			out.push(`${pad}<${tag}${attrStr}>${inlineForm}</${tag}>`);
			return;
		}
	}

	out.push(`${pad}<${tag}${attrStr}>`);
	serializeGroups(groupChildren(children), depth + 1, out);
	out.push(`${pad}</${tag}>`);
}

/**
 * The children rendered on a single line, or undefined when one of them
 * cannot be (a comment, or a block element with its own structure).
 */
function inlineChildren(children: Child[]): string | undefined {
	const parts: string[] = [];

	for (const [index, child] of children.entries()) {
		if (child.node.nodeType === 8) return undefined;
		if (child.node.nodeType === 1 && !isSpacingSensitive(child.node)) return undefined;

		if (index > 0) {
			const previous = children[index - 1]!;
			// A literal space survives both whitespace modes on one line.
			parts.push(child.separated && spacingVisibleBetween(previous.node, child.node) ? " " : "");
		}

		const lines: string[] = [];
		serializeNode(child.node, 0, lines, true);
		parts.push(lines.join(""));
	}

	return parts.join("");
}

/** Emits each group on its own line, with explicit spaces between them. */
function serializeGroups(groups: Child[][], depth: number, out: string[]): void {
	const pad = "\t".repeat(depth);

	for (const [index, group] of groups.entries()) {
		const space = needsSpaceAfter(groups, index) ? SPACE_EXPRESSION : "";

		if (group.length === 1) {
			const lines: string[] = [];
			serializeNode(group[0]!.node, depth, lines);
			if (space && lines.length > 0) lines[lines.length - 1] += space;
			out.push(...lines);
			continue;
		}

		// Nothing separated these in the source, so they share one line even
		// when that line runs long: a break here would invent a space.
		const joined = group
			.map((child) => {
				const lines: string[] = [];
				serializeNode(child.node, 0, lines, true);
				return lines.join("");
			})
			.join("");
		out.push(`${pad}${joined}${space}`);
	}
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
