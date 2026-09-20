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

/** What a kit is able to do at all, before the user's options narrow it. */
export interface KitCapabilities {
	/** The kit keeps copy in locale files, so text can be extracted. */
	textExtraction: boolean;
	/** The kit resolves links through a locale-aware route helper. */
	localizedLinks: boolean;
	/**
	 * The kit ships a setup script that can strip i18n out entirely, so a
	 * project built on it may legitimately have a single locale.
	 */
	optionalI18n: boolean;
}

export interface KitGenerator {
	readonly id: string;
	readonly capabilities: KitCapabilities;
	/** True when copy should be routed through the kit's translation layer. */
	usesI18n(options: ConvertOptions): boolean;
	/** True when links use the target kit's locale-aware route helper. */
	localizesLinks(options: ConvertOptions): boolean;
	/**
	 * How the component reads one extracted string back. Only called when
	 * usesI18n() is true, so kits without a translation layer return the key.
	 */
	translationReference(namespace: string, key: string): string;
	/** The expression a resolved link's destination is written as. */
	routeExpression(route: string): string;
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

/**
 * The imports every kit shares: Astro's own image components, astro-icon, the
 * kit's business data and its CSPicture wrapper. Which ones appear is decided
 * by what the markup passes actually produced, never by the kit.
 */
export function sharedImports(ctx: GenerationContext): ImportLine[] {
	const lines: ImportLine[] = [];

	const astroAssets = ["Picture", "Image"].filter((c) => ctx.usedComponents.has(c));
	if (ctx.cssVars.some((v) => v.optimize)) astroAssets.push("getImage");
	if (astroAssets.length > 0) {
		lines.push({
			group: "Components",
			statement: `import { ${astroAssets.join(", ")} } from "astro:assets";`,
		});
	}
	if (ctx.usedComponents.has("Icon")) {
		lines.push({
			group: "Components",
			statement: 'import { Icon } from "astro-icon/components";',
		});
	}
	if (ctx.usedComponents.has("CSPicture")) {
		lines.push({
			group: "Components",
			statement: 'import CSPicture from "@components/CSPicture/CSPicture.astro";',
		});
	}
	if (ctx.usedComponents.has("__businessData") && ctx.profile.businessData.exists) {
		lines.push({
			group: "Data",
			statement: `import { ${ctx.profile.businessData.exportName} } from "${ctx.profile.businessData.importPath}";`,
		});
	}
	return lines;
}

/** True when the markup contains a link the kit's route helper must resolve. */
export function usesRouteHelper(ctx: GenerationContext): boolean {
	return ctx.usedComponents.has("__localizedRoute");
}

/** True when the component reads any extracted copy back out. */
export function usesTranslatedCopy(ctx: GenerationContext): boolean {
	return ctx.messageCount > 0;
}
