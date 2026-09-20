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
 * moved to `@js/routes`, where `getLocalizedRoute` translates a slug against
 * the project's own `navData.json` before adding the locale prefix.
 *
 * The name is the one v3 used, but this is not that function: v3 exported it
 * from `@js/translationUtils` and translated a path one segment at a time from
 * a separate config. Here it takes a whole default-locale path, which is why a
 * nested page like `/projects/project-1` resolves at all.
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
		// Routing always goes through the kit's helper: it is how this kit
		// writes a link even when the project keeps a single locale.
		return true;
	},

	translationReference(namespace: string, key: string): string {
		return propertyAccess(`content.${namespace}`, key);
	},

	/**
	 * A query string or fragment is kept outside the call. The kit's helper
	 * normalises whatever it is given to a trailing slash, which would turn
	 * `/contact?ref=hero` into `/contact?ref=hero/`.
	 */
	routeExpression(route: string): string {
		const marker = route.search(/[?#]/);
		const path = marker === -1 ? route : route.slice(0, marker);
		const suffix = marker === -1 ? "" : route.slice(marker);
		const call = `getLocalizedRoute(locale, "${path}")`;
		return suffix ? `${call} + "${suffix}"` : call;
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
				statement: 'import { getLocalizedRoute } from "@js/routes";',
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
		return [`const { ${bindings} } = await getSiteContext(Astro.url);`];
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
