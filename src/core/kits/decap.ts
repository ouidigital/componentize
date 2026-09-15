import type { ConvertOptions, OutputFile } from "../types";
import type { GenerationContext, ImportLine, KitGenerator } from "./kit";

/**
 * Intermediate-Astro-Decap-CMS: sections are self-contained with their copy
 * written inline. Decap manages only the blog, so nothing here is wired to a
 * content collection.
 */
export const decapKit: KitGenerator = {
	id: "decap",

	usesI18n(_options: ConvertOptions): boolean {
		return false;
	},

	imports(ctx: GenerationContext): ImportLine[] {
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

	preamble(): string[] {
		return [];
	},

	extraFiles(): OutputFile[] {
		return [];
	},
};
