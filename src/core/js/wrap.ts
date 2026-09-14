import { parse } from "acorn";
import MagicString from "magic-string";
import type { KitProfile } from "../kits/profile";
import type { WarningCollector } from "../readiness";

/**
 * Stitch JS is written for a static page: it runs once, at load. Under Astro's
 * client-side navigation it must re-run after every swap, which is what the
 * astro:page-load wrapper does — but listeners bound to `document`/`window`
 * survive swaps and would then accumulate one copy per navigation. Those get an
 * AbortController that is aborted at the top of each run.
 *
 * Element-scoped listeners need no cleanup: their elements are replaced on swap.
 */

interface AcornNode {
	type: string;
	start: number;
	end: number;
	[key: string]: unknown;
}

/** Globals whose listeners outlive a page swap. */
const PERSISTENT_TARGETS = new Set(["document", "window"]);

/** APIs that keep running after a swap and cannot be auto-cleaned. */
const LEAKY_APIS: Record<string, string> = {
	setInterval: "setInterval",
	setTimeout: "setTimeout",
	MutationObserver: "MutationObserver",
	IntersectionObserver: "IntersectionObserver",
	ResizeObserver: "ResizeObserver",
	requestAnimationFrame: "requestAnimationFrame",
};

export interface JsWrapResult {
	/** Ready-to-embed script body, or undefined when JS was suppressed. */
	script?: string;
	suppressed: boolean;
}

/**
 * CodeStitch's sitewide navigation hooks — see the note in build-kit-profiles.mjs.
 * The two kits implement their nav script differently but drive the same
 * elements, so shared hooks (not shared tokens) identify a duplicate.
 */
const NAV_HOOKS = [
	"cs-navigation",
	"cs-toggle",
	"cs-active",
	"cs-open",
	"cs-ul-wrapper",
	"cs-dropdown",
	"cs-drop-ul",
	"cs-li-link",
	"mobile-menu-toggle",
	"cs-expanded-ul",
];

function navHooks(src: string): string[] {
	return NAV_HOOKS.filter((h) => src.includes(h));
}

/** Same normalisation as scripts/build-kit-profiles.mjs. */
function fingerprint(src: string): string[] {
	const tokens = src
		.replace(/\/\*[\s\S]*?\*\/|\/\/.*/g, "")
		.match(/[A-Za-z_$][\w$]*|["'][^"']*["']/g);
	if (!tokens) return [];
	const noise = new Set([
		"const", "let", "var", "function", "return", "if", "else", "for", "of",
		"in", "document", "window", "true", "false", "null", "undefined", "this",
	]);
	return [...new Set(tokens.filter((t) => !noise.has(t)))].sort();
}

/** Jaccard similarity of two token sets. */
function similarity(a: string[], b: string[]): number {
	if (a.length === 0 || b.length === 0) return 0;
	const sa = new Set(a);
	const sb = new Set(b);
	let shared = 0;
	for (const t of sa) if (sb.has(t)) shared++;
	return shared / (sa.size + sb.size - shared);
}

/**
 * True when this script drives the same sitewide navigation the kit already
 * drives — including it again would double-bind every hamburger click.
 *
 * Primary signal is shared nav hooks (implementation-independent); a very high
 * token similarity also counts, for a kit script that is a near-verbatim copy.
 * Anything else is kept, with a warning, rather than silently dropped.
 */
export function looksLikeKitNavScript(js: string, profile: KitProfile): boolean {
	if (!profile.navScript.exists) return false;

	const kitHooks = new Set(profile.navScript.hooks ?? []);
	const shared = navHooks(js).filter((h) => kitHooks.has(h));
	// #cs-navigation plus at least two more hooks means it is wiring the kit's nav.
	if (shared.includes("cs-navigation") && shared.length >= 3) return true;

	return similarity(fingerprint(js), profile.navScript.fingerprint) >= 0.6;
}

function walk(node: AcornNode, visit: (n: AcornNode) => void): void {
	visit(node);
	for (const key of Object.keys(node)) {
		if (key === "type" || key === "start" || key === "end") continue;
		const value = node[key];
		if (Array.isArray(value)) {
			for (const child of value) {
				if (child && typeof child === "object" && "type" in child) {
					walk(child as AcornNode, visit);
				}
			}
		} else if (value && typeof value === "object" && "type" in value) {
			walk(value as AcornNode, visit);
		}
	}
}

interface RewriteOutcome {
	code: string;
	needsController: boolean;
	/** Reasons the rewrite could not be completed safely. */
	blockers: string[];
	leaks: string[];
}

/**
 * Adds `{ signal }` to every document/window listener, merging into any options
 * argument that is already there rather than appending a stray fourth argument.
 */
function addSignals(js: string): RewriteOutcome {
	const blockers: string[] = [];
	const leaks = new Set<string>();
	let needsController = false;

	let ast: AcornNode;
	try {
		ast = parse(js, {
			ecmaVersion: "latest",
			sourceType: "script",
			allowReturnOutsideFunction: true,
		}) as unknown as AcornNode;
	} catch (err) {
		return {
			code: js,
			needsController: false,
			blockers: [`it could not be parsed (${(err as Error).message})`],
			leaks: [],
		};
	}

	const s = new MagicString(js);

	walk(ast, (node) => {
		// Timers and observers: `setInterval(...)`, `window.setTimeout(...)`,
		// and constructor forms like `new IntersectionObserver(...)`.
		if (node.type === "CallExpression" || node.type === "NewExpression") {
			const callee = node["callee"] as AcornNode | undefined;
			if (callee?.type === "Identifier") {
				const leak = LEAKY_APIS[callee["name"] as string];
				if (leak) leaks.add(leak);
			} else if (callee?.type === "MemberExpression") {
				const prop = callee["property"] as AcornNode | undefined;
				if (prop?.type === "Identifier") {
					const leak = LEAKY_APIS[prop["name"] as string];
					if (leak) leaks.add(leak);
				}
			}
		}

		if (node.type === "CallExpression") {
			const callee = node["callee"] as AcornNode | undefined;
			const args = (node["arguments"] as AcornNode[] | undefined) ?? [];

			// document/window addEventListener -> needs a signal.
			if (callee?.type === "MemberExpression") {
				const obj = callee["object"] as AcornNode | undefined;
				const prop = callee["property"] as AcornNode | undefined;
				const isAdd =
					prop?.type === "Identifier" && prop["name"] === "addEventListener";
				const targetName =
					obj?.type === "Identifier" ? (obj["name"] as string) : undefined;

				if (isAdd && targetName && PERSISTENT_TARGETS.has(targetName)) {
					needsController = true;
					const optionsArg = args[2];

					if (!optionsArg) {
						const last = args[args.length - 1];
						if (last) s.appendLeft(last.end, ", { signal }");
						else blockers.push("an addEventListener call had no arguments");
					} else if (optionsArg.type === "ObjectExpression") {
						const props = (optionsArg["properties"] as AcornNode[]) ?? [];
						const lastProp = props[props.length - 1];
						if (!lastProp) {
							s.overwrite(optionsArg.start, optionsArg.end, "{ signal }");
						} else {
							// Append after the final property, not before the closing
							// brace, so existing spacing is preserved.
							s.appendLeft(lastProp.end, ", signal");
						}
					} else if (
						optionsArg.type === "Literal" &&
						typeof optionsArg["value"] === "boolean"
					) {
						// The legacy `useCapture` boolean form.
						s.overwrite(
							optionsArg.start,
							optionsArg.end,
							`{ capture: ${String(optionsArg["value"])}, signal }`,
						);
					} else {
						// A variable or expression: merging would change semantics we
						// cannot see. Leave the source alone and say so.
						blockers.push(
							"a document/window listener passes computed options, so its cleanup could not be wired automatically",
						);
					}
				}
			}
		}
	});

	return {
		code: blockers.length > 0 ? js : s.toString(),
		needsController,
		blockers,
		leaks: [...leaks],
	};
}

function indent(code: string, depth: number): string {
	const pad = "\t".repeat(depth);
	return code
		.split("\n")
		.map((line) => (line.trim() ? `${pad}${line}` : ""))
		.join("\n");
}

export interface WrapJsOptions {
	profile: KitProfile;
	warnings: WarningCollector;
	/** True when the stitch's root element is a nav/header. */
	isNav: boolean;
	/**
	 * Keep a nav script that duplicates the kit's sitewide one, instead of
	 * leaving it out. The result is then a Draft — see ConvertOptions.
	 */
	keepKitNavScript?: boolean;
}

/**
 * Produces the component's <script> body: the stitch JS re-run on every client
 * navigation, with listener cleanup where it can be wired safely.
 */
export function wrapJs(js: string, options: WrapJsOptions): JsWrapResult {
	const { profile, warnings, isNav, keepKitNavScript = false } = options;
	const source = js.trim();
	if (!source) return { suppressed: false };

	const duplicatesKitNav = isNav && looksLikeKitNavScript(source, profile);
	if (duplicatesKitNav && !keepKitNavScript) {
		warnings.info(
			"nav-js-suppressed",
			`Left out the stitch's navigation script: ${profile.label} already runs an equivalent one sitewide, and including both would bind every menu click twice.`,
		);
		return { suppressed: true };
	}
	if (duplicatesKitNav) {
		// Kept on request. Both scripts drive the same menu, so this cannot ship as-is.
		warnings.draft(
			"nav-js-duplicate",
			`This navigation script and ${profile.label}'s sitewide nav.js both drive #cs-navigation, so every menu click would fire twice. Delete this <script> or stop importing the kit's nav.js before shipping.`,
		);
	} else if (isNav) {
		warnings.info(
			"nav-js-kept",
			`Kept this navigation stitch's script because it differs from ${profile.label}'s sitewide nav script — check for duplicated menu behaviour.`,
		);
	}

	// Already wrapped by hand? Leave it exactly as written.
	if (/astro:page-load/.test(source)) {
		warnings.info(
			"js-already-wrapped",
			"The stitch script already listens for astro:page-load, so it was kept as-is.",
		);
		return { script: indent(source, 1), suppressed: false };
	}

	const { code, needsController, blockers, leaks } = addSignals(source);

	for (const blocker of blockers) {
		warnings.draft(
			"js-cleanup-unwired",
			`The script was kept exactly as written because ${blocker}. Listeners on document/window may stack up after client-side navigation — add cleanup before shipping.`,
		);
	}
	if (leaks.length > 0) {
		warnings.draft(
			"js-leaky-api",
			`The script uses ${leaks.join(", ")}, which keeps running after a client-side navigation. Cancel it on astro:before-swap, or the component will leave work behind on every page change.`,
		);
	}

	const body = indent(code, needsController && blockers.length === 0 ? 2 : 2);

	if (needsController && blockers.length === 0) {
		return {
			suppressed: false,
			script: [
				"\tlet componentController;",
				"",
				'\tdocument.addEventListener("astro:page-load", () => {',
				"\t\t// Drop the previous page's listeners before binding new ones.",
				"\t\tcomponentController?.abort();",
				"\t\tcomponentController = new AbortController();",
				"\t\tconst { signal } = componentController;",
				"",
				body,
				"\t});",
			].join("\n"),
		};
	}

	return {
		suppressed: false,
		script: ['\tdocument.addEventListener("astro:page-load", () => {', body, "\t});"].join(
			"\n",
		),
	};
}
