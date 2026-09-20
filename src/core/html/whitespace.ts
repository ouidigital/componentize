/** Source whitespace at each text boundary, captured before any pass edits text. */
export interface SourceWhitespace {
	leading: boolean;
	trailing: boolean;
	whitespaceOnly: boolean;
}

const sourceWhitespace = new WeakMap<Text, SourceWhitespace>();

export function captureSourceWhitespace(roots: Element[]): void {
	for (const root of roots) {
		const walker = root.ownerDocument!.createTreeWalker(root, NodeFilter.SHOW_TEXT);
		for (let node = walker.nextNode(); node; node = walker.nextNode()) {
			const text = node as Text;
			const value = text.data;
			const whitespaceOnly = /^[\t\n\f\r ]+$/.test(value);
			sourceWhitespace.set(text, {
				leading: !whitespaceOnly && /^[\t\n\f\r ]/.test(value),
				trailing: !whitespaceOnly && /[\t\n\f\r ]$/.test(value),
				whitespaceOnly,
			});
		}
	}
}

export function whitespaceFor(node: Text): SourceWhitespace {
	return sourceWhitespace.get(node) ?? { leading: false, trailing: false, whitespaceOnly: false };
}

/** True when source whitespace touches the visible edge of an inline subtree. */
export function hasSourceEdgeWhitespace(node: Node, edge: "leading" | "trailing"): boolean {
	if (node.nodeType === 3) return whitespaceFor(node as Text)[edge];
	if (node.nodeType !== 1) return false;
	const children = Array.from(node.childNodes);
	const ordered = edge === "leading" ? children : children.reverse();
	for (const child of ordered) {
		if (child.nodeType === 8) continue;
		if (child.nodeType === 3 && whitespaceFor(child as Text).whitespaceOnly) continue;
		return hasSourceEdgeWhitespace(child, edge);
	}
	return false;
}
