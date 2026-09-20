import type { ConvertOptions, OutputFile } from "../types";
import type { GenerationContext, ImportLine, KitGenerator } from "./kit";
import { sharedImports, usesRouteHelper, usesTranslatedCopy } from "./kit";
import { localeFiles } from "./locales";
import { propertyAccess } from "../naming";

/**
 * Advanced-Astro-i18n v4.
 *
 * Two things changed from v3 and both reach every generated component. Copy is
 * read as data — `getSiteContext(Astro.url)` hands back a `content` object
 * keyed by locale-file name — rather than looked up through `t()`. And routing
 * split in two: `getRoute` only adds the locale prefix, while the translated
 * slug for a page lives in the project's own `navData.json`.
 *
 * Both helpers survive `npm run remove-i18n`, which swaps in single-locale
 * versions with the same names, so one generated shape serves a multilingual
 * project and an English-only one alike.
 */
export const advancedV4Kit: KitGenerator = {
	id: "advanced-v4",

	capabilities: { textExtraction: true, localizedLinks: true, optionalI18n: true },

	usesI18n(options: ConvertOptions): boolean {
		return options.i18n;
	},

	localizesLinks(_options: ConvertOptions): boolean {
		// Routing always goes through getRoute: it is how this kit writes a
		// link even when the project keeps a single locale.
		return true;
	},

	translationReference(namespace: string, key: string): string {
		return propertyAccess(`content.${namespace}`, key);
	},

	routeExpression(route: string): string {
		return `routeFor("${route}")`;
	},

	imports(ctx: GenerationContext): ImportLine[] {
		const lines: ImportLine[] = [];
		const routes = usesRouteHelper(ctx);

		if (routes || usesTranslatedCopy(ctx)) {
			lines.push({
				group: "Utils",
				statement: 'import { getSiteContext } from "@js/getSiteContext";',
			});
		}
		if (routes) {
			lines.push({
				group: "Utils",
				statement: 'import { getRoute } from "@js/routes";',
			});
			lines.push({
				group: "Data",
				statement: 'import navData from "@data/navData.json";',
			});
			lines.push({
				group: "Data",
				statement: 'import type { NavItem } from "src/typescript/global";',
			});
		}

		return [...lines, ...sharedImports(ctx)];
	},

	preamble(ctx: GenerationContext): string[] {
		const routes = usesRouteHelper(ctx);
		const copy = usesTranslatedCopy(ctx);
		if (!routes && !copy) return [];

		const bindings = [routes ? "locale" : undefined, copy ? "content" : undefined]
			.filter(Boolean)
			.join(", ");
		const lines = [`const { ${bindings} } = await getSiteContext(Astro.url);`];

		if (routes) {
			const defaultLocale = ctx.profile.defaultLocale ?? "en";
			lines.push(
				"",
				"// This kit translates a slug in navData.json and adds the locale prefix",
				"// in getRoute. Reading navData at runtime means a destination follows",
				"// the project's own routes rather than the ones this component shipped with.",
				"const navUrlsFor = (items: NavItem[], path: string): Record<string, string> | undefined => {",
				"\tfor (const item of items) {",
				`\t\tconst canonical = (item.urls?.["${defaultLocale}"] ?? "").replace(/\\/+$/, "") || "/";`,
				"\t\tif (canonical === path) return item.urls;",
				"\t\tconst nested = item.children?.length ? navUrlsFor(item.children, path) : undefined;",
				"\t\tif (nested) return nested;",
				"\t}",
				"\treturn undefined;",
				"};",
				"",
				"const routeFor = (path: string): string => {",
				"\tconst marker = path.search(/[?#]/);",
				"\tconst base = marker === -1 ? path : path.slice(0, marker);",
				"\tconst suffix = marker === -1 ? \"\" : path.slice(marker);",
				"\tconst urls = navUrlsFor(navData as NavItem[], base.replace(/\\/+$/, \"\") || \"/\");",
				`\treturn getRoute(locale, urls?.[locale] ?? urls?.["${defaultLocale}"] ?? base) + suffix;`,
				"};",
			);
		}

		return lines;
	},

	extraFiles(ctx: GenerationContext): OutputFile[] {
		if (!this.usesI18n(ctx.options) || !ctx.messages || ctx.messageCount === 0) {
			return [];
		}

		// A project that ran remove-i18n keeps one locale folder, and the kit's
		// content loader still reads it — so the copy is extracted either way,
		// and only the extra locale files depend on this setting.
		const defaultLocale = ctx.profile.defaultLocale ?? "en";
		const locales = ctx.options.multilingual === false
			? [defaultLocale]
			: ctx.profile.locales;

		return localeFiles(ctx, {
			locales,
			allowExtraLocales: ctx.options.multilingual !== false,
			settingsPath: "src/features/i18n/i18nConfig.ts",
		});
	},
};
