import type { CssFlavor, Readiness } from "./types";
import type { GenerationContext, ImportGroup, ImportLine, KitGenerator } from "./kits/kit";
import { componentDoc, readinessDocLines, READINESS_DOC_START } from "./kits/kit";

/** Import groups in the order the kits' own components use them. */
const GROUP_ORDER: ImportGroup[] = ["Utils", "Components", "Data", "Images"];

/** The banner every CodeStitch-derived component opens with. */
function banner(title: string): string[] {
	const width = 44;
	const rule = `<!-- ${"=".repeat(width)} -->`;
	const padded = title.slice(0, width);
	const left = Math.max(0, Math.floor((width - padded.length) / 2));
	const right = Math.max(0, width - padded.length - left);
	return [rule, `<!-- ${" ".repeat(left)}${padded}${" ".repeat(right)} -->`, rule];
}

function styleLang(flavor: CssFlavor): string {
	return flavor === "css" ? "<style>" : `<style lang="${flavor}">`;
}

export interface AssembleOptions {
	ctx: GenerationContext;
	kit: KitGenerator;
	readiness: Readiness;
	markup: string;
	css: string;
	script?: string;
	/** Human title for the banner, e.g. "Hero" or "Landing + Services". */
	title: string;
}

/**
 * Builds the final .astro file: frontmatter, banner, markup, styles, script —
 * the order every component in both kits follows.
 */
export function assembleComponent(options: AssembleOptions): string {
	const { ctx, kit, readiness, markup, css, script, title } = options;

	// --- frontmatter ---
	const lines: string[] = ["---", ...componentDoc(ctx, readiness), ""];

	const imports: ImportLine[] = [
		...kit.imports(ctx),
		...ctx.imageImports.map((img) => ({
			group: "Images" as const,
			statement: `import ${img.identifier} from "${img.specifier}";`,
			comment: img.specifier.startsWith("http")
				? `TODO: download ${img.sourceUrl} into src/assets/images/`
				: undefined,
		})),
	];

	// CSS background images are handed to the stylesheet as custom properties,
	// which is how the kits' own components do it.
	const cssVarLines = ctx.cssVars.flatMap((v) =>
		v.optimize
			? [
					`const ${v.varName}Image = await getImage({ src: ${v.identifier} });`,
					`const ${v.varName} = \`url("\${${v.varName}Image.src}")\`;`,
				]
			: [`const ${v.varName} = \`url("\${${v.identifier}.src}")\`;`],
	);

	for (const group of GROUP_ORDER) {
		const inGroup = imports.filter((i) => i.group === group);
		if (inGroup.length === 0) continue;
		lines.push(`// ${group}`);
		for (const imp of inGroup) {
			lines.push(imp.comment ? `${imp.statement} // ${imp.comment}` : imp.statement);
		}
		lines.push("");
	}

	const preamble = kit.preamble(ctx);
	if (preamble.length > 0) lines.push(...preamble, "");
	if (cssVarLines.length > 0) lines.push(...cssVarLines, "");

	while (lines[lines.length - 1] === "") lines.pop();
	lines.push("---", "");

	// --- markup ---
	lines.push(...banner(title), "", markup, "");

	// --- styles ---
	const defineVars =
		ctx.cssVars.length > 0
			? ` define:vars={{ ${ctx.cssVars.map((v) => v.varName).join(", ")} }}`
			: "";
	const styleOpen = styleLang(ctx.options.cssFlavor).replace(/>$/, `${defineVars}>`);
	lines.push(styleOpen, css, "</style>");

	// --- script ---
	if (script) lines.push("", "<script>", script, "</script>");

	return `${lines.join("\n").replace(/\n{3,}/g, "\n\n")}\n`;
}

/**
 * Rewrites the verdict stamped in a component's JSDoc header.
 *
 * The file is assembled once, with the verdict for the complete file set. When
 * the user takes only the .astro away, that verdict no longer describes what
 * they hold — so the header is restamped to match. Without this the panel would
 * say Draft while the file itself claimed "Ready: builds as-is".
 */
export function stampReadiness(astro: string, readiness: Readiness): string {
	const lines = astro.split("\n");
	const start = lines.findIndex((line) => READINESS_DOC_START.test(line));
	if (start === -1) return astro;

	// The verdict runs from its first line to the end of the JSDoc block.
	let end = start;
	while (end < lines.length && lines[end]!.trim() !== "*/") end++;
	if (end >= lines.length) return astro;

	// readinessDocLines opens with a blank " *" separator, already present above.
	const replacement = readinessDocLines(readiness).slice(1);
	return [...lines.slice(0, start), ...replacement, ...lines.slice(end)].join("\n");
}
