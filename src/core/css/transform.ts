import postcss, {
	type Root,
	type Rule,
	type Declaration,
	type Parser,
	type Stringifier,
} from "postcss";
import postcssLess from "postcss-less";
import postcssScss from "postcss-scss";
import type { CssFlavor } from "../types";
import type { KitProfile } from "../kits/profile";
import type { WarningCollector } from "../readiness";

/**
 * All CSS work is parser-backed. A hand-rolled scanner would eventually trip on
 * braces inside strings, data URLs, or nested rules — and stitch CSS carries
 * LESS idioms (`(16/16rem)`, `~"min(...)"`) that must survive byte-for-byte,
 * which postcss preserves by keeping raws untouched.
 */

type PostcssSyntax = { parse: Parser; stringify: Stringifier } | undefined;

/**
 * Parses with the flavour's own parser.
 *
 * Note: `postcss.parse(css, { syntax })` silently ignores the syntax and falls
 * back to the plain-CSS parser — which then rejects LESS `//` comments. The
 * syntax's `parse` must be called directly.
 */
function parseWith(syntax: PostcssSyntax, css: string): Root {
	return syntax ? (syntax.parse(css, { from: undefined }) as Root) : postcss.parse(css);
}

const SYNTAX = {
	less: postcssLess,
	scss: postcssScss,
	css: undefined,
} as const;

export interface CssUrlRef {
	/** Absolute URL as written in the stylesheet. */
	url: string;
	/** The declaration it appears in, e.g. "background-image". */
	prop: string;
}

export interface CssTransformResult {
	css: string;
	/** Remote image URLs referenced from the stylesheet (background-image, mask, content). */
	urls: CssUrlRef[];
	/** True when the trailing dark-mode block was found. */
	hasDarkBlock: boolean;
}

const REMOTE_IMAGE_HOSTS = /(^|\.)digitaloceanspaces\.com$/i;

function isRemoteImageUrl(url: string): boolean {
	try {
		const u = new URL(url);
		return u.protocol === "https:" && REMOTE_IMAGE_HOSTS.test(u.hostname);
	} catch {
		return false;
	}
}

/** Extracts url(...) targets from a declaration value. */
function urlsIn(value: string): string[] {
	return [...value.matchAll(/url\(\s*(['"]?)([^'")]+)\1\s*\)/g)]
		.map((m) => m[2]?.trim())
		.filter((u): u is string => Boolean(u));
}

/**
 * Which global helper class a rule targets, if any.
 *
 * Matches the bare selector (`.cs-title`) and a scoped one that adds nothing but
 * an ancestor (`#hero-1621 .cs-title`) — both say the same thing about the same
 * element. A compound selector (`.cs-title.featured`, `.cs-title:hover`) is a
 * different target and is never treated as a redeclaration.
 */
function globalSelectorFor(rule: Rule, profile: KitProfile): string | undefined {
	const known = Object.keys(profile.globalRules);
	// A selector list is only comparable if every part targets the same class.
	const parts = rule.selector.split(",").map((p) => p.trim()).filter(Boolean);
	if (parts.length === 0) return undefined;

	const matches = parts.map((part) => {
		const last = part.split(/\s+|>|\+|~/).filter(Boolean).pop() ?? "";
		return known.includes(last) ? last : undefined;
	});

	const first = matches[0];
	return first && matches.every((m) => m === first) ? first : undefined;
}

/** Normalises a declaration value the same way the profile builder does. */
function normalizeValue(value: string): string {
	return value.replace(/\s+/g, " ").replace(/\s*,\s*/g, ",").trim().toLowerCase();
}

/**
 * Strips a redeclaration of a kit global only when every declaration repeats
 * what the kit already says, value included.
 *
 * Comparing property names alone would delete a rule that reuses the kit's
 * properties with different values — the component would still build, and would
 * still be called Ready, while rendering wrongly. Anything that differs, adds a
 * property, or nests is a genuine per-stitch variant, which CodeStitch's own
 * docs expect and which must survive untouched.
 */
function isRedundantGlobalRedeclaration(
	rule: Rule,
	selector: string,
	profile: KitProfile,
): boolean {
	const global = profile.globalRules[selector];
	if (!global) return false;

	// Nested rules mean component-specific behaviour; never strip those.
	let hasNested = false;
	rule.each((node) => {
		if (node.type === "rule" || node.type === "atrule") hasNested = true;
	});
	if (hasNested) return false;

	let count = 0;
	let allRepeat = true;
	rule.each((node) => {
		if (node.type !== "decl") return;
		const decl = node as Declaration;
		count++;
		const globalValue = global[decl.prop.trim()];
		if (
			globalValue === undefined ||
			normalizeValue(decl.value) !== globalValue ||
			decl.important
		) {
			allRepeat = false;
		}
	});

	return count > 0 && allRepeat;
}

export interface CssTransformOptions {
	flavor: CssFlavor;
	profile: KitProfile;
	warnings: WarningCollector;
	/** Section ids present in the markup, used to sanity-check the dark block. */
	sectionIds: string[];
	darkModeRequested: boolean;
}

/**
 * Cleans stitch CSS for embedding in an Astro component:
 *  - removes only those :root custom properties the kit already defines
 *  - removes redundant redeclarations of the kit's global helper classes
 *  - removes the demo Roboto font-family (CodeStitch's docs say to)
 *  - collects remote image URLs for the asset pass
 *
 * Any parse failure returns the input untouched and marks the output Draft:
 * a component that still needs a look is far better than one silently mangled.
 */
export function transformCss(
	source: string,
	options: CssTransformOptions,
): CssTransformResult {
	const { flavor, profile, warnings } = options;
	const syntax = SYNTAX[flavor];
	const urls: CssUrlRef[] = [];

	let root: Root;
	try {
		root = parseWith(syntax, source);
	} catch (err) {
		warnings.draft(
			"css-parse-failed",
			`The ${flavor.toUpperCase()} could not be parsed, so it was copied through unchanged — review it before shipping. (${(err as Error).message})`,
		);
		return {
			css: source,
			urls: collectUrlsByRegex(source),
			hasDarkBlock: /body\.dark-mode/.test(source),
		};
	}

	const hasDarkBlock = /body\.dark-mode/.test(source);

	root.walkDecls((decl) => {
		// Remote image URLs anywhere in the stylesheet.
		for (const url of urlsIn(decl.value)) {
			if (isRemoteImageUrl(url)) urls.push({ url, prop: decl.prop });
		}

		// Demo font-family: CodeStitch ships Roboto as a functional default and
		// their docs explicitly say to remove it so the site's own font applies.
		if (
			decl.prop.toLowerCase() === "font-family" &&
			/roboto/i.test(decl.value)
		) {
			decl.remove();
		}
	});

	// :root — per declaration, not per block. Unknown custom properties are the
	// component's own and must survive.
	root.walkRules((rule) => {
		if (rule.selector.trim() !== ":root") return;
		const kept: string[] = [];
		rule.each((node) => {
			if (node.type !== "decl") return;
			const decl = node as Declaration;
			if (profile.globalRootVars.includes(decl.prop.trim())) decl.remove();
			else kept.push(decl.prop.trim());
		});
		if (kept.length === 0) {
			rule.remove();
		} else {
			warnings.info(
				"root-vars-kept",
				`Kept component-specific custom ${kept.length === 1 ? "property" : "properties"} ${kept.join(", ")} in a :root block — move them to your global stylesheet if they are shared.`,
			);
		}
	});

	// Redundant redeclarations of the kit's global helper classes.
	root.walkRules((rule) => {
		const sel = globalSelectorFor(rule, profile);
		if (!sel) return;
		if (isRedundantGlobalRedeclaration(rule, sel, profile)) {
			rule.remove();
			warnings.info(
				"global-rule-stripped",
				`Removed a redeclaration of ${sel}, which ${profile.label} already defines globally.`,
			);
		}
	});

	let css: string;
	try {
		css = syntax ? root.toString(syntax) : root.toString();
	} catch (err) {
		warnings.draft(
			"css-stringify-failed",
			`The stylesheet could not be re-serialised and was copied through unchanged. (${(err as Error).message})`,
		);
		return { css: source, urls, hasDarkBlock };
	}

	// Round-trip validation: never emit CSS we cannot re-parse.
	try {
		parseWith(syntax, css);
	} catch (err) {
		warnings.draft(
			"css-roundtrip-failed",
			`Transformed styles failed re-parsing, so the original was kept. (${(err as Error).message})`,
		);
		return { css: source, urls, hasDarkBlock };
	}

	if (options.darkModeRequested && !hasDarkBlock) {
		warnings.info(
			"no-dark-block",
			"This stitch ships no dark-mode styles, so the component has none.",
		);
	}

	return { css: cleanupBlankRuns(css), urls, hasDarkBlock };
}

/** Fallback URL collection for the pass-through path. */
function collectUrlsByRegex(source: string): CssUrlRef[] {
	return urlsIn(source)
		.filter(isRemoteImageUrl)
		.map((url) => ({ url, prop: "unknown" }));
}

/** Removing rules leaves runs of blank lines; collapse them to at most one. */
function cleanupBlankRuns(css: string): string {
	return css.replace(/\n{3,}/g, "\n\n").trimEnd();
}

/** Re-indents a stylesheet by one tab for embedding inside <style>. */
export function indentCss(css: string): string {
	return css
		.split("\n")
		.map((line) => (line.trim() ? `\t${line}` : ""))
		.join("\n");
}

/** Rewrites remote url(...) references to a CSS custom property token. */
export function rewriteCssUrl(css: string, url: string, varName: string): string {
	const escaped = url.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	return css.replace(
		new RegExp(`url\\(\\s*(['"]?)${escaped}\\1\\s*\\)`, "g"),
		`var(--${varName})`,
	);
}
