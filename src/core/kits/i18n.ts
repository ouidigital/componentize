import type { ConvertOptions, OutputFile } from "../types";
import type { GenerationContext, ImportLine, KitGenerator } from "./kit";

/**
 * Advanced-Astro-i18n: components are shared across locales and pull every
 * string through t("namespace:key"), with routes built by getLocalizedRoute.
 */
export const i18nKit: KitGenerator = {
	id: "i18n",

	usesI18n(options: ConvertOptions): boolean {
		return options.i18n;
	},

	imports(ctx: GenerationContext): ImportLine[] {
		const lines: ImportLine[] = [];
		const usesI18n = this.usesI18n(ctx.options);

		if (usesI18n) {
			lines.push({
				group: "Utils",
				statement: 'import { getLocaleFromUrl } from "@js/localeUtils";',
			});
			const helpers = ["useTranslations"];
			if (ctx.messageCount >= 0 && needsLocalizedRoute(ctx)) {
				helpers.push("getLocalizedRoute");
			}
			lines.push({
				group: "Utils",
				statement: `import { ${helpers.join(", ")} } from "@js/translationUtils";`,
			});
		}

		const astroAssets = ["Picture", "Image"].filter((c) => ctx.usedComponents.has(c));
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
		if (ctx.usedComponents.has("__businessData") && ctx.profile.businessData.exists) {
			lines.push({
				group: "Data",
				statement: `import { ${ctx.profile.businessData.exportName} } from "${ctx.profile.businessData.importPath}";`,
			});
		}
		if (ctx.usedComponents.has("CSPicture")) {
			lines.push({
				group: "Components",
				statement: 'import CSPicture from "@components/CSPicture/CSPicture.astro";',
			});
		}
		return lines;
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

		const required = ctx.profile.locales;
		const extra = (ctx.options.extraLocales ?? []).filter((l) => !required.includes(l));
		const locales = [...required, ...extra];
		const defaultLocale = ctx.profile.defaultLocale ?? required[0] ?? "en";
		const json = `${JSON.stringify(ctx.messages, null, "\t")}\n`;

		const untranslated = locales.filter((l) => l !== defaultLocale);
		if (untranslated.length > 0) {
			ctx.warnings.draft(
				"locales-untranslated",
				`The ${untranslated.join(", ")} locale ${untranslated.length === 1 ? "file holds" : "files hold"} the English copy — translate ${untranslated.length === 1 ? "it" : "them"} before this goes live.`,
			);
		}
		for (const locale of extra) {
			ctx.warnings.draft(
				"locale-not-configured",
				`${locale} is not configured in ${ctx.profile.label} — add it to src/config/siteSettings.ts (locales, localeMap, languageSwitcherMap) and astro.config.mjs, and add pages for it.`,
			);
		}

		return locales.map((locale) => ({
			path: `src/locales/${locale}/${ctx.namespace}.json`,
			contents: json,
			encoding: "utf8" as const,
		}));
	},
};

/** getLocalizedRoute is only imported when the markup actually links somewhere. */
function needsLocalizedRoute(ctx: GenerationContext): boolean {
	return ctx.usedComponents.has("__localizedRoute");
}
