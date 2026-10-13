import { describe, expect, it } from "vitest";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { codeFiles, extractGetCode, variantFor } from "../scripts/lib/get-code.mjs";
import { loadPage } from "./helpers/loadFixture";

describe("fixture capture helpers", () => {
	it("maps every variant name, dark ones included", () => {
		expect(["CSS", "CSS Dark", "LESS Dark", "scss  dark", "SASS Dark"].map(variantFor)).toEqual([
			"CSS",
			"CSS Dark",
			"LESS Dark",
			"SCSS Dark",
			"SCSS Dark",
		]);
		expect(variantFor("PHP")).toBeUndefined();
	});

	it("derives the same set of files the 2501 fixture folder holds", () => {
		const data = extractGetCode(loadPage("2501"))!;
		const derived = Object.keys(codeFiles(data.stitch.codes)).sort();
		const folder = readdirSync(join(process.cwd(), "tests", "fixtures", "stitch-not-found-2501"))
			.filter((f) => f === "html.html" || f === "js.js" || f.startsWith("css-"))
			.sort();
		expect(derived).toEqual(folder);
		expect(derived).toContain("css-LESS-Dark.txt");
	});
});
