/**
 * Renders assets/icon.svg to the PNG sizes the manifest declares.
 *
 * Chromium is the renderer because Playwright already ships one for the E2E
 * suite — no image toolchain to install, and it rasterises the same way the
 * browser that displays the icon will.
 *
 * Usage: npm run icons
 */
import { chromium } from "@playwright/test";
import { readFileSync, mkdirSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = join(root, "public/icons");
const SIZES = [16, 48, 128];

/**
 * A size may ship its own drawing. The full mark's detail turns to a smudge at
 * 16px, so that size gets an optically simplified variant; everything else
 * falls back to the one master.
 */
function sourceFor(size) {
	const specific = join(root, `assets/icon-${size}.svg`);
	const file = existsSync(specific) ? specific : join(root, "assets/icon.svg");
	return { svg: readFileSync(file, "utf8"), file };
}

mkdirSync(outDir, { recursive: true });

const browser = await chromium.launch({ channel: "chromium" });
try {
	for (const size of SIZES) {
		const { svg, file } = sourceFor(size);
		const page = await browser.newPage({
			viewport: { width: size, height: size },
			deviceScaleFactor: 1,
		});
		await page.setContent(
			`<!doctype html><style>
				html,body{margin:0;padding:0;background:transparent}
				svg{display:block;width:${size}px;height:${size}px}
			</style>${svg}`,
		);
		const out = join(outDir, `icon-${size}.png`);
		await page.screenshot({ path: out, omitBackground: true });
		await page.close();
		console.log(`icon-${size}.png  <-  ${file.slice(root.length + 1)}`);
	}
} finally {
	await browser.close();
}
