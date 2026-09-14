import { describe, expect, it } from "vitest";
import { transformCss } from "@core/css/transform";
import { profileFor } from "@core/kits/profile";
import { WarningCollector } from "@core/readiness";
import { loadFixture, FIXTURE_DIRS } from "./helpers/loadFixture";

function run(css: string, flavor: "less" | "scss" | "css" = "less", dark = false) {
	const warnings = new WarningCollector();
	const result = transformCss(css, {
		flavor,
		profile: profileFor("i18n"),
		warnings,
		sectionIds: ["hero-1621"],
		darkModeRequested: dark,
	});
	return { ...result, collector: warnings };
}

describe("transformCss", () => {
	it("preserves LESS parens-division and escaped min() byte-for-byte", () => {
		const css = `#hero-1621 {
	padding: 0 (16/16rem);
	max-width: (1280/16em);
	font-size: ~"min(2.31vw, .7em)";
}`;
		const { css: out } = run(css);
		expect(out).toContain("(16/16rem)");
		expect(out).toContain("(1280/16em)");
		expect(out).toContain('~"min(2.31vw, .7em)"');
	});

	it("strips a redeclaration that repeats the kit's values exactly", () => {
		// Same properties AND same values as the kit's own .cs-topper -> no-op.
		const css = `.cs-topper {
	font-size: var(--topperFontSize);
	font-weight: 700;
	color: var(--primaryLight);
}
#hero-1621 { padding: 1rem; }`;
		const { css: out, collector } = run(css);
		expect(out).not.toContain(".cs-topper");
		expect(out).toContain("#hero-1621");
		expect(collector.has("global-rule-stripped")).toBe(true);
	});

	it("keeps a rule that reuses the kit's properties with different values", () => {
		// Deleting this would still build, and would still be called Ready, while
		// quietly rendering the wrong colour and weight.
		const css = `.cs-topper {
	font-size: var(--topperFontSize);
	font-weight: 400;
	color: #ff6a3e;
}`;
		const { css: out, collector } = run(css);
		expect(out).toContain("font-weight: 400");
		expect(out).toContain("#ff6a3e");
		expect(collector.has("global-rule-stripped")).toBe(false);
	});

	it("strips a scoped rule that only repeats the kit's global values", () => {
		const css = `#hero-1621 .cs-text {
	font-size: var(--bodyFontSize);
	line-height: 1.5em;
}`;
		const { css: out } = run(css);
		expect(out).not.toContain(".cs-text");
	});

	it("keeps a compound selector even when the values match", () => {
		// .cs-title:hover is a different target, not a redeclaration.
		const css = `.cs-title:hover {
	font-weight: 900;
}`;
		const { css: out } = run(css);
		expect(out).toContain(".cs-title:hover");
	});

	it("keeps an !important override", () => {
		const css = `.cs-text {
	line-height: 1.5em !important;
}`;
		const { css: out } = run(css);
		expect(out).toContain("!important");
	});

	it("keeps a scoped .cs-button-solid variant", () => {
		// CodeStitch's Core Styles ships no .cs-button-solid at all, so scoped
		// button rules are real per-stitch variants, not redeclarations.
		const css = `#hero-1621 .cs-button-solid {
	display: inline-flex;
	gap: 0.75rem;
	overflow: hidden;
}`;
		const { css: out } = run(css);
		expect(out).toContain(".cs-button-solid");
		expect(out).toContain("gap: 0.75rem");
	});

	it("keeps a global-class rule that adds its own declarations", () => {
		const css = `.cs-title {
	font-size: var(--headerFontSize);
	text-shadow: 0 1px 2px #000;
}`;
		const { css: out } = run(css);
		expect(out).toContain("text-shadow");
	});

	it("removes only kit-defined :root vars and keeps component-specific ones", () => {
		const css = `:root {
	--primary: #ff6a3e;
	--sectionPadding: clamp(3.75rem, 7.82vw, 6.25rem) 1rem;
	--myComponentGap: 2rem;
}
#hero-1621 { gap: var(--myComponentGap); }`;
		const { css: out, collector } = run(css);
		expect(out).not.toContain("--primary:");
		expect(out).not.toContain("--sectionPadding:");
		expect(out).toContain("--myComponentGap");
		expect(collector.has("root-vars-kept")).toBe(true);
	});

	it("drops the :root block entirely when it only held kit variables", () => {
		const css = `:root { --primary: #ff6a3e; }
#hero-1621 { color: var(--primary); }`;
		const { css: out } = run(css);
		expect(out).not.toContain(":root");
		expect(out).toContain("#hero-1621");
	});

	it("removes the demo Roboto font-family but keeps other font stacks", () => {
		const css = `#hero-1621 {
	font-family: 'Roboto', Arial, sans-serif;
	color: red;
}
#hero-1621 .cs-icon { font-family: "MyIconFont"; }`;
		const { css: out } = run(css);
		expect(out).not.toMatch(/font-family:\s*'Roboto'/);
		expect(out).toContain("color: red");
		expect(out).toContain('font-family: "MyIconFont"');
	});

	it("collects remote image urls from CSS declarations", () => {
		const css = `#hero-1621 {
	background-image: url("https://csimg.nyc3.cdn.digitaloceanspaces.com/Images/bg.jpg");
}
#hero-1621 .cs-mask { mask-image: url(https://nyc3.digitaloceanspaces.com/csimages2/m.svg); }
#hero-1621 .local { background: url("/local/thing.png"); }`;
		const { urls } = run(css);
		expect(urls.map((u) => u.url)).toEqual([
			"https://csimg.nyc3.cdn.digitaloceanspaces.com/Images/bg.jpg",
			"https://nyc3.digitaloceanspaces.com/csimages2/m.svg",
		]);
		expect(urls[0]!.prop).toBe("background-image");
	});

	it("parses LESS inline comments, and keeps them", () => {
		// Regression: postcss.parse(css, { syntax }) silently ignores the syntax
		// and uses the plain-CSS parser, which rejects `//` comments — every LESS
		// stitch containing one would then skip all transforms.
		const css = `#hero-1621 {
	width: (20/16rem);
	//center image inside button
	position: absolute;
	// spaced comment too
	:root { --primary: #fff; }
}`;
		const { css: out, collector } = run(css);
		expect(collector.has("css-parse-failed")).toBe(false);
		expect(out).toContain("//center image inside button");
		expect(out).toContain("// spaced comment too");
	});

	it("passes unparseable CSS through untouched and marks it Draft", () => {
		const broken = `#hero-1621 { color: red;`;
		const { css: out, collector } = run(broken);
		expect(out).toBe(broken);
		expect(collector.has("css-parse-failed")).toBe(true);
	});

	it("detects the dark-mode block in a real dark variant", () => {
		const stitch = loadFixture(FIXTURE_DIRS.notFound);
		const { hasDarkBlock } = run(stitch.css["LESS Dark"]!, "less", true);
		expect(hasDarkBlock).toBe(true);
	});

	it("round-trips every real fixture stylesheet without corrupting it", () => {
		for (const dir of Object.values(FIXTURE_DIRS)) {
			const stitch = loadFixture(dir);
			for (const [variant, flavor] of [
				["LESS", "less"],
				["SCSS", "scss"],
				["CSS", "css"],
			] as const) {
				const source = stitch.css[variant];
				if (!source) continue;
				const { css: out, collector } = run(source, flavor);
				expect(
					collector.warnings.filter((w) => w.severity === "draft"),
					`${dir} ${variant} should transform cleanly`,
				).toEqual([]);
				// Selectors survive; only global/`:root` noise may be removed.
				expect(out).toContain("@media");
			}
		}
	});
});
