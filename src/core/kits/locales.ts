import type { OutputFile } from "../types";
import type { GenerationContext } from "./kit";

export interface LocaleFileOptions {
	/** Locales to write a file for, in the order they should appear. */
	locales: string[];
	/** Whether the caller's kit understands ConvertOptions.extraLocales. */
	allowExtraLocales: boolean;
	/** Where the kit declares its locales, named in the warning. */
	settingsPath: string;
}

/**
 * Writes the extracted copy as one JSON file per locale.
 *
 * Every locale starts from the default locale's English copy, because a
 * machine translation nobody asked for is worse than an obvious placeholder —
 * so each non-default locale is reported as untranslated and the result is a
 * Draft until somebody translates it.
 */
export function localeFiles(
	ctx: GenerationContext,
	options: LocaleFileOptions,
): OutputFile[] {
	const required = options.locales;
	const extra = options.allowExtraLocales
		? (ctx.options.extraLocales ?? []).filter((l) => !required.includes(l))
		: [];
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
			`${locale} is not configured in ${ctx.profile.label} — add it to ${options.settingsPath} (locales, localeMap, languageSwitcherMap) and ${ctx.profile.configPath}, and add pages for it.`,
		);
	}

	return locales.map((locale) => ({
		path: `src/locales/${locale}/${ctx.namespace}.json`,
		contents: json,
		encoding: "utf8" as const,
	}));
}
