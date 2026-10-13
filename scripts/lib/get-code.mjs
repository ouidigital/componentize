/**
 * Pure helpers for reading CodeStitch's Get code page outside the browser.
 * Used by scripts/capture-fixture.mjs and tested in tests/capture-fixture.test.ts.
 */

/**
 * The stitch JSON. CodeStitch encodes it with escaped slashes, so `</script>`
 * cannot occur inside it and a non-greedy match to the closing tag is exact.
 */
export function extractGetCode(html) {
	const match = /<script>\s*window\.GET_CODE\s*=\s*([\s\S]*?)\s*;\s*<\/script>/.exec(html);
	return match ? JSON.parse(match[1]) : undefined;
}

export const VARIANTS = ["CSS", "CSS Dark", "LESS", "LESS Dark", "SCSS", "SCSS Dark"];

/** A stored code type name as one of the six variants; SASS counts as SCSS. */
export function variantFor(typeName) {
	const name = String(typeName).toUpperCase().replace(/\s+/g, " ").trim().replace(/^SASS\b/, "SCSS");
	// Both sides in the same case: the variants are written "CSS Dark".
	return VARIANTS.find((v) => v.toUpperCase() === name);
}

export const lf = (s) => s.replace(/\r\n?/g, "\n");

/** The derived fixture files for a stitch's codes (core styles come from the page). */
export function codeFiles(codes) {
	const files = {};
	const htmlCodes = codes.filter((c) => c.type === "html");
	const htmlCode = htmlCodes.find((c) => String(c.typeName).toUpperCase() === "HTML") ?? htmlCodes[0];
	if (htmlCode?.content?.trim()) files["html.html"] = lf(htmlCode.content);
	const jsCode = codes.find((c) => c.type === "js" && c.content.trim());
	if (jsCode) files["js.js"] = lf(jsCode.content);
	for (const code of codes) {
		if (code.type !== "css" || !code.content.trim()) continue;
		const variant = variantFor(code.typeName);
		const name = variant && `css-${variant.replace(/\s+/g, "-")}.txt`;
		if (name && !(name in files)) files[name] = lf(code.content);
	}
	return files;
}
