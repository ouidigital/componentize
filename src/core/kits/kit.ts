import type { ConvertOptions, OutputFile, Readiness } from "../types";
import type { KitProfile } from "./profile";
import type { CssVar, ImportSpec } from "../html/images";
import type { WarningCollector } from "../readiness";

/** Import groups, emitted in the order the kits' own components use. */
export type ImportGroup = "Utils" | "Components" | "Data" | "Images";

export interface ImportLine {
	group: ImportGroup;
	statement: string;
	/** Trailing comment, e.g. a TODO about a missing asset. */
	comment?: string;
}

export interface GenerationContext {
	componentName: string;
	namespace: string;
	stitchId: string;
	stitchUrl: string;
	options: ConvertOptions;
	profile: KitProfile;
	warnings: WarningCollector;
	/** Astro component tags used in the markup (Picture, Image, Icon, CSPicture). */
	usedComponents: Set<string>;
	imageImports: ImportSpec[];
	/** CSS custom properties to expose via define:vars. */
	cssVars: CssVar[];
	/** Translation messages for the default locale, when i18n ran. */
	messages?: Record<string, unknown>;
	messageCount: number;
}

export interface KitGenerator {
	readonly id: string;
	/** True when text should be routed through t() for this kit + options. */
	usesI18n(options: ConvertOptions): boolean;
	/** Import lines the component needs, beyond image imports. */
	imports(ctx: GenerationContext): ImportLine[];
	/** Statements after the imports, e.g. the locale/t() preamble. */
	preamble(ctx: GenerationContext): string[];
	/** Files beyond the .astro component (locale JSON, etc.). */
	extraFiles(ctx: GenerationContext): OutputFile[];
}

/** JSDoc header stamped into every generated component. */
export function componentDoc(
	ctx: GenerationContext,
	readiness: Readiness,
): string[] {
	const lines = [
		"/**",
		` * ${ctx.componentName} — generated from CodeStitch stitch #${ctx.stitchId}.`,
		` * Source: ${ctx.stitchUrl}`,
		` * Target: ${ctx.profile.label} @ ${ctx.profile.sha.slice(0, 8)}`,
	];

	lines.push(...readinessDocLines(readiness));
	lines.push(" */");
	return lines;
}

/** The verdict half of the JSDoc header, on its own. */
export function readinessDocLines(readiness: Readiness): string[] {
	if (readiness.state === "ready") {
		return [" *", " * Ready: builds as-is in the kit above."];
	}
	return [
		" *",
		" * Draft — needs attention before shipping:",
		...readiness.reasons.map((reason) => ` *   - ${reason}`),
	];
}

/** Where the verdict block starts, so it can be replaced without a full re-render. */
export const READINESS_DOC_START = /^ \* (Ready: |Draft — )/m;
