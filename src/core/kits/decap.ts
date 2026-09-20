import type { ConvertOptions, OutputFile } from "../types";
import type { GenerationContext, ImportLine, KitGenerator } from "./kit";
import { sharedImports } from "./kit";

/**
 * Intermediate-Astro-Decap-CMS: sections are self-contained with their copy
 * written inline. Decap manages only the blog, so nothing here is wired to a
 * content collection.
 */
export const decapKit: KitGenerator = {
	id: "decap",

	capabilities: { textExtraction: false, localizedLinks: false, optionalI18n: false },

	usesI18n(_options: ConvertOptions): boolean {
		return false;
	},

	localizesLinks(_options: ConvertOptions): boolean {
		return false;
	},

	/** Unreachable: this kit never extracts text, so no key is ever read back. */
	translationReference(_namespace: string, key: string): string {
		return key;
	},

	/** Unreachable: localizesLinks() is false, so routes stay plain strings. */
	routeExpression(route: string): string {
		return `"${route}"`;
	},

	imports(ctx: GenerationContext): ImportLine[] {
		return sharedImports(ctx);
	},

	preamble(): string[] {
		return [];
	},

	extraFiles(): OutputFile[] {
		return [];
	},
};
