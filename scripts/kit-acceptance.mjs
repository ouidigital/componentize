#!/usr/bin/env node
/**
 * The proof behind a "Ready" verdict.
 *
 * For each fixture and kit: generate the component, extract it over a checkout
 * of the PINNED kit, generate a scratch page that actually imports and renders
 * it, then run `astro build`. Placing a file under src/components proves
 * nothing — an unreferenced component never enters the build graph.
 *
 * Usage: node scripts/kit-acceptance.mjs [--kit i18n|decap] [--keep]
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, writeFile, readFile, rm, cp } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { checkRendered, startPreview } from "./acceptance-browser.mjs";
import { darkRulesIn } from "./dark-rules.mjs";

const exec = promisify(execFile);
const require = createRequire(import.meta.url);
const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const WORK = join(ROOT, ".acceptance");

const args = process.argv.slice(2);
const onlyKit = args.includes("--kit") ? args[args.indexOf("--kit") + 1] : undefined;
const keep = args.includes("--keep");

const KITS = {
	i18n: {
		profile: "advanced-i18n",
		repo: "https://github.com/CodeStitchOfficial/Advanced-Astro-i18n.git",
		/** Where a scratch page goes, and how it imports the component. */
		pageDir: "src/pages",
	},
	decap: {
		profile: "intermediate-decap",
		repo: "https://github.com/CodeStitchOfficial/Intermediate-Astro-Decap-CMS.git",
		pageDir: "src/pages",
	},
};

/**
 * Fixtures to run. `interactive` describes the stitch's own behaviour, which is
 * exercised before and after a client-side navigation — that is what proves the
 * astro:page-load wrapping actually works.
 */
const CASES = [
	{ fixture: "stitch-not-found-2501", name: "NotFound-2501" },
	{
		fixture: "stitch-faq-1741",
		name: "Faq-1741",
		interactive: {
			name: "the FAQ accordion",
			trigger: ".cs-faq-item .cs-button",
			toggles: { selector: ".cs-faq-item", className: "active" },
		},
	},
	{ fixture: "stitch-hero-2274", name: "Hero-2274" },
	{ fixture: "stitch-contact-2320", name: "Contact-2320" },
	// The nav's script is the kit's own, so there is nothing component-local to
	// exercise here — the build check is what matters for it.
	{ fixture: "stitch-nav-757", name: "Navigation-757" },
];

const skipBrowser = args.includes("--no-browser");

/**
 * An empty page the navigation check travels through.
 *
 * It must not render any component: the kit's own pages register
 * astro:page-load handlers that survive later swaps and would bind to the
 * component under test, hiding a broken one.
 */
const WAYPOINT_PAGE = "acceptance-waypoint";

async function run(cmd, cmdArgs, cwd, label) {
	try {
		const { stdout, stderr } = await exec(cmd, cmdArgs, {
			cwd,
			maxBuffer: 32 * 1024 * 1024,
			env: { ...process.env, CI: "1" },
		});
		return { ok: true, output: stdout + stderr };
	} catch (err) {
		return {
			ok: false,
			output: `${err.stdout ?? ""}${err.stderr ?? ""}${err.message}`,
			label,
		};
	}
}

async function ensureKit(kitId) {
	const kit = KITS[kitId];
	const profile = require(join(ROOT, "src/core/kits/profiles", `${kit.profile}.json`));
	const dir = join(WORK, `${kitId}-${profile.sha.slice(0, 8)}`);

	if (!existsSync(join(dir, "package.json"))) {
		await mkdir(dir, { recursive: true });
		console.log(`  cloning ${kit.repo} @ ${profile.sha.slice(0, 8)} …`);
		let res = await run("git", ["init", "-q"], dir);
		if (!res.ok) throw new Error(res.output);
		await run("git", ["remote", "add", "origin", kit.repo], dir);
		res = await run("git", ["fetch", "-q", "--depth", "1", "origin", profile.sha], dir);
		if (!res.ok) throw new Error(`fetch failed: ${res.output}`);
		res = await run("git", ["checkout", "-q", "FETCH_HEAD"], dir);
		if (!res.ok) throw new Error(`checkout failed: ${res.output}`);
	}

	await applyKitWorkarounds(kitId, dir);

	if (!existsSync(join(dir, "node_modules"))) {
		console.log("  npm install (once per kit) …");
		const res = await run("npm", ["install", "--no-audit", "--no-fund"], dir);
		if (!res.ok) throw new Error(`npm install failed: ${res.output}`);
	}

	return { dir, profile };
}

/**
 * Known defects in a pinned kit that stop it building on its own.
 *
 * Advanced-Astro-i18n passes SVGs to <Picture> in its own Services.astro, which
 * Astro 6 refuses to process unless the project opts in. Without this the kit
 * cannot build at all, and no component could be verified against it. The patch
 * is applied to the scratch checkout only, and recorded in the README.
 */
async function applyKitWorkarounds(kitId, dir) {
	if (kitId !== "i18n") return;
	const configPath = join(dir, "astro.config.mjs");
	const config = await readFile(configPath, "utf8");
	if (config.includes("dangerouslyProcessSVG")) return;
	await writeFile(
		configPath,
		config.replace(
			/export default defineConfig\(\{/,
			"export default defineConfig({\n\t// acceptance-harness workaround: the kit's own Services.astro\n\t// feeds SVGs to <Picture>, which Astro 6 rejects by default.\n\timage: { dangerouslyProcessSVG: true },",
		),
		"utf8",
	);
	// Keep the patch across resetKit() by committing it to the scratch clone.
	await run("git", ["add", "-A"], dir);
	await run("git", ["-c", "user.email=a@b.c", "-c", "user.name=acceptance", "commit", "-qm", "acceptance workaround"], dir);
}

/**
 * The ids of the component's root elements, from its generated markup.
 *
 * Plural on purpose: a stitch can contain several sections, and its dark-mode
 * rules may target only the later ones.
 */
function rootIdsOf(astroSource) {
	const markup = astroSource.slice(astroSource.indexOf("---", 3));
	return [...markup.matchAll(/<(?:section|header)[^>]*\sid="([^"]+)"/g)].map(
		(match) => match[1],
	);
}

/** Returns the checkout to its pinned state, dropping anything we added. */
async function resetKit(dir) {
	await run("git", ["checkout", "-q", "--", "."], dir);
	await run("git", ["clean", "-qfd", "src"], dir);
}

/**
 * A signature of the distinct errors in a build log, so a baseline failure can
 * be told apart from one our component introduced.
 */
function errorSignature(output) {
	const lines = output
		.split("\n")
		.map((l) => l.trim())
		.filter((l) => /^[A-Z][A-Za-z0-9]*:\s+\S|^error:/.test(l))
		.filter((l) => !/^(Note|Warning|Hint|Info|Tip):/i.test(l));
	return [...new Set(lines)].sort();
}

/** Generates the component files by running the real pipeline through vitest. */
async function generate(kitId, testCase) {
	const outDir = join(WORK, "generated", `${kitId}-${testCase.name}`);
	await rm(outDir, { recursive: true, force: true });
	await mkdir(outDir, { recursive: true });

	const res = await run(
		"npx",
		[
			"vitest",
			"run",
			"tests/generate-for-acceptance.test.ts",
			
		],
		ROOT,
		"generate",
	);
	if (!res.ok) throw new Error(`generation failed: ${res.output}`);
	return outDir;
}

async function main() {
	const kitIds = onlyKit ? [onlyKit] : Object.keys(KITS);
	await mkdir(WORK, { recursive: true });

	// One generation pass writes every case to .acceptance/generated/.
	console.log("Generating components …");
	const gen = await run(
		"npx",
		["vitest", "run", "tests/generate-for-acceptance.test.ts"],
		ROOT,
	);
	if (!gen.ok) {
		console.error(gen.output);
		process.exit(1);
	}

	const results = [];
	const shotDir = join(WORK, "screenshots");
	await mkdir(shotDir, { recursive: true });

	for (const kitId of kitIds) {
		console.log(`\n=== ${kitId} ===`);
		const { dir, profile } = await ensureKit(kitId);

		// Baseline: does the pinned kit build on its own? Some kit revisions do
		// not, and a component must not be blamed for the kit's own breakage.
		await resetKit(dir);
		const baseline = await run("npx", ["astro", "build"], dir, "baseline");
		const baselineErrors = errorSignature(baseline.output.replace(/\[[0-9;]*m/g, ""));
		if (!baseline.ok) {
			console.log(
				`  NOTE  the pristine kit does not build at ${profile.sha.slice(0, 8)}:`,
			);
			for (const err of baselineErrors) console.log(`        ${err}`);
			console.log("        components are judged on whether they add new errors.");
		}

		for (const testCase of CASES) {
			const genDir = join(WORK, "generated", `${kitId}-${testCase.name}`);
			if (!existsSync(genDir)) continue;

			const manifest = require(join(genDir, "manifest.json"));
			const label = `${kitId}/${testCase.name}`;

			await resetKit(dir);
			// Extract the generated files over the kit checkout.
			await cp(join(genDir, "files"), dir, { recursive: true });

			// An empty waypoint for the navigation check to travel through.
			await writeFile(
				join(dir, KITS[kitId].pageDir, `${WAYPOINT_PAGE}.astro`),
				[
					"---",
					`import BaseLayout from "@layouts/BaseLayout.astro";`,
					"---",
					"",
					`<BaseLayout title="Waypoint" description="Empty page for navigation checks">`,
					"\t<p>waypoint</p>",
					"</BaseLayout>",
					"",
				].join("\n"),
				"utf8",
			);

			// A scratch page that imports AND renders the component — without
			// this the component never enters the build graph.
			//
			// The name must NOT start with an underscore: Astro treats
			// `src/pages/_*` as private and never routes it, which would make this
			// whole check pass without ever building the component.
			const pageName = `acceptance-${testCase.name.toLowerCase()}`;
			const importPath = `@components/${manifest.componentName}/${manifest.componentName}.astro`;
			// A file name may contain hyphens; the binding it is imported under
			// may not, so the two are tracked separately.
			const binding = manifest.componentIdentifier ?? manifest.componentName;
			// Rendered through the kit's own BaseLayout, exactly as a user would
			// use it. That matters for more than realism: the layout is what
			// mounts <ClientRouter />, and without it `astro:page-load` never
			// fires — the component's script would silently never run.
			await writeFile(
				join(dir, KITS[kitId].pageDir, `${pageName}.astro`),
				[
					"---",
					`import BaseLayout from "@layouts/BaseLayout.astro";`,
					`import ${binding} from "${importPath}";`,
					"---",
					"",
					`<BaseLayout title="Acceptance" description="Acceptance check for ${manifest.componentName}">`,
					`\t<${binding} />`,
					"</BaseLayout>",
					"",
				].join("\n"),
				"utf8",
			);

			const build = await run("npx", ["astro", "build"], dir, label);
			const clean = build.output.replace(/\[[0-9;]*m/g, "");

			// Guard against a vacuous pass: the scratch page must actually have
			// been rendered, and its HTML must contain the component's markup.
			const renderedPath = [
				join(dir, "dist", pageName, "index.html"),
				join(dir, "dist", `${pageName}.html`),
			].find((candidate) => existsSync(candidate));

			// A Ready component must not ship unresolved work.
			const astroPath = join(genDir, "files", manifest.componentPath);
			const source = existsSync(astroPath)
				? require("node:fs").readFileSync(astroPath, "utf8")
				: "";
			const hasTodo = /TODO/.test(source);

			const problems = [];
			if (build.ok && !renderedPath) {
				problems.push(
					"the scratch page was not rendered, so the component was never built",
				);
			} else if (build.ok && renderedPath) {
				const rendered = require("node:fs").readFileSync(renderedPath, "utf8");
				if (!/<(section|header)\b/i.test(rendered)) {
					problems.push("the rendered page contains no component markup");
				}
			}
			const newErrors = errorSignature(clean).filter(
				(e) => !baselineErrors.includes(e),
			);
			if (!build.ok && (baseline.ok || newErrors.length > 0)) {
				problems.push(
					newErrors.length > 0
						? `astro build failed: ${newErrors.join("; ")}`
						: "astro build failed",
				);
			}
			if (manifest.readiness === "ready" && hasTodo) {
				problems.push("Ready output contains a TODO");
			}
			if (
				/Could not resolve|Cannot find module|does not provide an export/.test(clean) &&
				!/Could not resolve|Cannot find module|does not provide an export/.test(
					baseline.output,
				)
			) {
				problems.push("unresolved import");
			}

			// Rendering and behaviour, not just compilation.
			if (problems.length === 0 && !skipBrowser && renderedPath) {
				let preview;
				try {
					preview = await startPreview(dir);
					const viewProblems = await checkRendered({
						baseUrl: preview.url,
						pagePath: `/${pageName}`,
						interactive: testCase.interactive,
						expectPriority: manifest.expectPriority,
						expectResponsiveImages: manifest.expectResponsiveImages,
						// The component's own dark rules, verified individually.
						darkRules: darkRulesIn(source),
						rootIds: rootIdsOf(source),
						waypointPath: `/${WAYPOINT_PAGE}`,
						screenshotDir: shotDir,
						screenshotName: label.replace("/", "-"),
					});
					problems.push(...viewProblems);
				} catch (err) {
					problems.push(`could not preview the built site: ${err.message}`);
				} finally {
					preview?.proc.kill("SIGTERM");
				}
			}

			results.push({
				label,
				readiness: manifest.readiness,
				problems,
				baselineBroken: !baseline.ok,
				output: clean,
			});
			const verdict =
				problems.length === 0 ? (baseline.ok ? "PASS" : "PASS*") : "FAIL";
			console.log(
				`  ${verdict}  ${label}  (${manifest.readiness})` +
					(problems.length ? ` — ${problems.join("; ")}` : ""),
			);
			if (problems.length > 0) {
				console.log(clean.split("\n").slice(-25).join("\n"));
			}

			await resetKit(dir);
		}
	}

	if (!keep) {
		await rm(join(WORK, "generated"), { recursive: true, force: true });
	}

	const failed = results.filter((r) => r.problems.length > 0);
	console.log(
		`\n${results.length - failed.length}/${results.length} components built in their pinned kit.`,
	);
	if (results.some((r) => r.problems.length === 0 && r.baselineBroken)) {
		console.log(
			"PASS* = the kit itself does not build at its pinned commit; the component added no new errors.",
		);
	}
	process.exit(failed.length > 0 ? 1 : 0);
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
