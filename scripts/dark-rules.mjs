#!/usr/bin/env node
/**
 * Extracts what a generated component's own dark-mode block actually changes.
 *
 * Checking that "something differs" in dark mode is meaningless: the kits' own
 * dark.less restyles every heading and paragraph site-wide, so that assertion
 * passes even when the component's dark rules are entirely broken. What matters
 * is whether *these* selectors get *these* properties, so they are pulled out of
 * the component and verified individually in the browser.
 */
import postcss from "postcss";
import postcssLess from "postcss-less";
import postcssScss from "postcss-scss";

const SYNTAX = { less: postcssLess, scss: postcssScss, css: undefined };

/** Resolves a nested rule to its full selector list. */
function resolveSelectors(rule) {
	let selectors = rule.selectors ?? [rule.selector];
	let parent = rule.parent;

	while (parent && parent.type === "rule") {
		const parentSelectors = parent.selectors ?? [parent.selector];
		const combined = [];
		for (const parentSel of parentSelectors) {
			for (const sel of selectors) {
				combined.push(
					sel.includes("&")
						? sel.replaceAll("&", parentSel)
						: `${parentSel} ${sel}`,
				);
			}
		}
		selectors = combined;
		parent = parent.parent;
	}
	return selectors;
}

/**
 * @returns {Array<{selector: string, props: string[]}>} selectors the dark block
 * targets, with the properties it sets on them — relative to the document, so
 * the `body.dark-mode` prefix is stripped.
 */
export function darkRulesIn(astroSource, flavor = "less") {
	const styleMatch = /<style[^>]*>([\s\S]*?)<\/style>/.exec(astroSource);
	if (!styleMatch) return [];

	let root;
	try {
		const syntax = SYNTAX[flavor];
		root = syntax ? syntax.parse(styleMatch[1]) : postcss.parse(styleMatch[1]);
	} catch {
		return [];
	}

	const found = new Map();

	root.walkRules((rule) => {
		const props = [];
		rule.each((node) => {
			if (node.type === "decl") props.push(node.prop.trim());
		});
		if (props.length === 0) return;

		for (const selector of resolveSelectors(rule)) {
			const normalised = selector.replace(/\s+/g, " ").trim();
			if (!normalised.startsWith("body.dark-mode")) continue;

			// What to query once dark mode is on.
			const target = normalised.slice("body.dark-mode".length).trim();
			if (!target || target.startsWith(":") || target.includes("&")) continue;
			// Pseudo-elements cannot be read back from a normal element.
			if (/::/.test(target)) continue;

			const key = target;
			const existing = found.get(key) ?? new Set();
			for (const prop of props) {
				// Custom properties and shorthands that do not resolve cleanly are
				// skipped; the goal is a signal, not exhaustive coverage.
				if (!prop.startsWith("--")) existing.add(prop);
			}
			found.set(key, existing);
		}
	});

	return [...found.entries()]
		.map(([selector, props]) => ({ selector, props: [...props] }))
		.filter((entry) => entry.props.length > 0);
}
