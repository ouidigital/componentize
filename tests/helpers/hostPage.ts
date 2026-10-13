import { readFileSync } from "node:fs";
import { join } from "node:path";
import { findGetCodeScript, parseGetCode } from "@content/scrape";

const STUB = readFileSync(join(process.cwd(), "tests", "e2e", "stubs", "get-code.js"), "utf8");

/**
 * Puts a page into the test document. Inline scripts are not evaluated by the
 * test environment, so `render` runs the CodeStitch stand-in explicitly, the
 * way the real page runs its own script at load.
 */
export function mountHostPage(
	html: string,
	{ render = true, prefs }: { render?: boolean; prefs?: Record<string, unknown> } = {},
): Document {
	document.documentElement.innerHTML = html
		.replace(/^[\s\S]*?<html[^>]*>/i, "")
		.replace(/<\/html>\s*$/i, "");
	if (render) runStub(prefs);
	return document;
}

export function runStub(prefs?: Record<string, unknown>): void {
	const w = window as unknown as Record<string, unknown>;
	w["GET_CODE"] = parseGetCode(findGetCodeScript(document)!.textContent ?? "");
	w["__STUB_PREFS"] = prefs;
	new Function(STUB)();
}

export function click(selector: string): void {
	const el = document.querySelector<HTMLElement>(selector);
	if (!el) throw new Error(`no ${selector}`);
	el.click();
}

export function typeInto(selector: string, value: string): void {
	const el = document.querySelector<HTMLInputElement>(selector);
	if (!el) throw new Error(`no ${selector}`);
	el.value = value;
	el.dispatchEvent(new Event("input", { bubbles: true }));
}

export const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
