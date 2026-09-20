import type { ConvertOptions, OutputFile } from "../types";
import type { GenerationContext, ImportLine, KitGenerator } from "./kit";
import { sharedImports, usesRouteHelper } from "./kit";
import { localeFiles } from "./locales";

/**
 * Advanced-Astro-i18n v3.0.2: components are shared across locales and pull
 * every string through t("namespace:key"), with routes built by
 * getLocalizedRoute. Superseded by advanced-v4, and kept unchanged for projects
 * still on that commit.
 */
export const i18nKit: KitGenerator = {
	id: "i18n",

	capabilities: { textExtraction: true, localizedLinks: true, optionalI18n: false },

	usesI18n(options: ConvertOptions): boolean {
		return options.i18n;
	},

	localizesLinks(options: ConvertOptions): boolean {
		return options.i18n;
	},

	translationReference(namespace: string, key: string): string {
		return `t("${namespace}:${key}")`;
	},

	routeExpression(route: string): string {
		return `getLocalizedRoute(locale, "${route}")`;
	},

	imports(ctx: GenerationContext): ImportLine[] {
		const lines: ImportLine[] = [];

		if (this.usesI18n(ctx.options)) {
			lines.push({
				group: "Utils",
				statement: 'import { getLocaleFromUrl } from "@js/localeUtils";',
			});
			const helpers = ["useTranslations"];
			if (usesRouteHelper(ctx)) helpers.push("getLocalizedRoute");
			lines.push({
				group: "Utils",
				statement: `import { ${helpers.join(", ")} } from "@js/translationUtils";`,
			});
		}

		return [...lines, ...sharedImports(ctx)];
	},

	preamble(ctx: GenerationContext): string[] {
		if (!this.usesI18n(ctx.options)) return [];
		return [
			"const locale = getLocaleFromUrl(Astro.url);",
			"const t = useTranslations(locale);",
		];
	},

	extraFiles(ctx: GenerationContext): OutputFile[] {
		if (!this.usesI18n(ctx.options) || !ctx.messages || ctx.messageCount === 0) {
			return [];
		}
		// This kit has no single-locale mode: its locale list is the kit's own.
		return localeFiles(ctx, {
			locales: ctx.profile.locales,
			allowExtraLocales: true,
			settingsPath: "src/config/siteSettings.ts",
		});
	},
};
