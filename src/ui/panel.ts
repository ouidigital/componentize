import type {
	ConvertOptions,
	ConvertResult,
	CssFlavor,
	KitId,
	LinkMapping,
	Readiness,
	StitchData,
} from "@core/types";
import {
	componentSourceFor,
	convert,
	defaultAssetsDirFor,
	defaultComponentName,
	inspectJs,
	inspectLinks,
} from "@core/convert";
import { profileFor } from "@core/kits/profile";
import { InvalidNameError } from "@core/naming";
import { parseStitchHtml } from "@core/html/parse";
import { copyToClipboard, downloadAstro, downloadZip } from "@output/index";
import { readinessFor, type Delivery } from "@core/readiness";
import { DEFAULT_PREFS, loadPrefs, savePrefs, type Prefs } from "./prefs";
import panelCss from "./panel.css?inline";

/**
 * The panel is hand-rolled inside a shadow root: CodeStitch's own stylesheet
 * cannot reach in, and nothing we add leaks out onto their page.
 */

export interface PanelDeps {
	stitch: StitchData;
	fetchAsset: (url: string) => Promise<
		{ base64: string; contentType: string; originalUrl: string } | undefined
	>;
}

const KIT_LABELS: Array<{ value: KitId; label: string }> = [
	{ value: "i18n", label: "Advanced Astro i18n" },
	{ value: "decap", label: "Intermediate Astro + Decap" },
];

const FLAVORS: Array<{ value: CssFlavor; label: string }> = [
	{ value: "less", label: "LESS" },
	{ value: "scss", label: "SCSS (needs sass)" },
	{ value: "css", label: "CSS" },
];

/** Which output button is mid-flight, so only that one shows a spinner. */
type BusyAction = "copy" | "astro" | "zip";

function el<K extends keyof HTMLElementTagNameMap>(
	tag: K,
	props: Partial<HTMLElementTagNameMap[K]> & { class?: string } = {},
	children: Array<Node | string> = [],
): HTMLElementTagNameMap[K] {
	const node = document.createElement(tag);
	const { class: className, ...rest } = props;
	if (className) node.className = className;
	Object.assign(node, rest);
	for (const child of children) {
		node.append(typeof child === "string" ? document.createTextNode(child) : child);
	}
	return node;
}

/* ------------------------------------------------------------------ icons -- */

/**
 * Icons are inline SVG, built element by element.
 *
 * They cannot be image files (no web_accessible_resources) and must not be
 * glyphs: the panel's text is asserted verbatim by the E2E suite, and an SVG
 * contributes nothing to textContent where a character would.
 */

const SVG_NS = "http://www.w3.org/2000/svg";

type IconPart = [tag: string, attrs: Record<string, string>];

type IconName =
	| "mark"
	| "ready"
	| "draft"
	| "note"
	| "alert"
	| "copy"
	| "download"
	| "zip"
	| "spinner";

const FILLED = { fill: "currentColor", stroke: "none" };

const ICONS: Record<IconName, IconPart[]> = {
	// Brackets around stacked blocks: a snippet becoming a component.
	mark: [
		["path", { d: "M6.2 2.6H4.4a1.8 1.8 0 0 0-1.8 1.8v7.2a1.8 1.8 0 0 0 1.8 1.8h1.8" }],
		["path", { d: "M9.8 2.6h1.8a1.8 1.8 0 0 1 1.8 1.8v7.2a1.8 1.8 0 0 1-1.8 1.8H9.8" }],
		["rect", { x: "6.6", y: "5.3", width: "2.8", height: "1.7", rx: "0.85", ...FILLED }],
		["rect", { x: "6.6", y: "9", width: "2.8", height: "1.7", rx: "0.85", ...FILLED }],
	],
	ready: [
		["circle", { cx: "8", cy: "8", r: "6.1" }],
		["path", { d: "M5.3 8.2 7.1 10l3.7-3.9" }],
	],
	draft: [
		["circle", { cx: "8", cy: "8", r: "6.1" }],
		["path", { d: "M8 4.9v3.8" }],
		["path", { d: "M8 11.2h.01" }],
	],
	note: [
		["circle", { cx: "8", cy: "8", r: "6.1" }],
		["path", { d: "M8 7.3v3.8" }],
		["path", { d: "M8 4.8h.01" }],
	],
	alert: [
		["path", { d: "M8.7 2.9 14.9 13.1a.8.8 0 0 1-.7 1.2H1.8a.8.8 0 0 1-.7-1.2L7.3 2.9a.8.8 0 0 1 1.4 0Z" }],
		["path", { d: "M8 6.5v2.8" }],
		["path", { d: "M8 11.4h.01" }],
	],
	copy: [
		["rect", { x: "5.6", y: "5.6", width: "8", height: "8", rx: "1.8" }],
		["path", { d: "M11.1 5.6V4.2a1.8 1.8 0 0 0-1.8-1.8H4.2a1.8 1.8 0 0 0-1.8 1.8v5.1a1.8 1.8 0 0 0 1.8 1.8h1.4" }],
	],
	download: [
		["path", { d: "M8 2.6v7.7" }],
		["path", { d: "M4.9 7.2 8 10.3l3.1-3.1" }],
		["path", { d: "M2.8 13.3h10.4" }],
	],
	zip: [
		["path", { d: "M2.4 5.7h11.2v6.1a1.8 1.8 0 0 1-1.8 1.8H4.2a1.8 1.8 0 0 1-1.8-1.8V5.7Z" }],
		["rect", { x: "1.6", y: "2.6", width: "12.8", height: "3.1", rx: "1" }],
		["path", { d: "M6.6 8.7h2.8" }],
	],
	spinner: [["circle", { cx: "8", cy: "8", r: "6", "stroke-dasharray": "27 11" }]],
};

function icon(name: IconName, className?: string): SVGSVGElement {
	const node = document.createElementNS(SVG_NS, "svg");
	node.setAttribute("viewBox", "0 0 16 16");
	node.setAttribute("fill", "none");
	node.setAttribute("stroke", "currentColor");
	node.setAttribute("stroke-width", "1.7");
	node.setAttribute("stroke-linecap", "round");
	node.setAttribute("stroke-linejoin", "round");
	node.setAttribute("aria-hidden", "true");
	if (className) node.setAttribute("class", className);
	for (const [tag, attrs] of ICONS[name]) {
		const part = document.createElementNS(SVG_NS, tag);
		for (const [key, value] of Object.entries(attrs)) part.setAttribute(key, value);
		node.append(part);
	}
	return node;
}

/* ----------------------------------------------------------------- pieces -- */

function brand(): HTMLElement {
	return el("div", { class: "brand" }, [
		icon("mark", "mark"),
		el("h2", { class: "title" }, ["Componentize"]),
	]);
}

/** The one piece of self-promotion: quiet, at the bottom, out of the way. */
function footer(): HTMLElement {
	return el("div", { class: "footer" }, [
		"by ",
		el(
			"a",
			{
				href: "https://oui.digital",
				target: "_blank",
				rel: "noopener noreferrer",
				title: "Built by Oui Digital",
			},
			["oui.digital"],
		),
	]);
}

function callout(
	className: string,
	glyph: IconName,
	heading: HTMLElement,
	body?: HTMLElement,
): HTMLElement {
	const node = el("div", { class: className }, [
		el("div", { class: "callout-head" }, [icon(glyph), heading]),
	]);
	if (body) node.append(body);
	return node;
}

export class ComponentizePanel {
	readonly host: HTMLElement;
	private readonly root: ShadowRoot;
	private readonly stitch: StitchData;
	private readonly fetchAsset: PanelDeps["fetchAsset"];

	private prefs: Prefs = { ...DEFAULT_PREFS };
	private componentName: string;
	private assetsDir: string;
	private links: LinkMapping[];
	private lastResult?: ConvertResult;
	/** Readiness of the last delivery, which may be stricter than the conversion's. */
	private lastReadiness?: Readiness;
	private busy = false;
	private busyAction?: BusyAction;
	/**
	 * Per-stitch override: include a navigation script the kit already ships.
	 * Deliberately not a preference — it is a decision about this stitch, and
	 * carrying it to the next one would silently double-bind another menu.
	 */
	private keepNavJs = false;
	/** Per-stitch choice; unlike Prefs, it must not carry to another stitch. */
	private prioritizeFirstImage: boolean;

	constructor(deps: PanelDeps) {
		this.stitch = deps.stitch;
		this.fetchAsset = deps.fetchAsset;
		this.componentName = defaultComponentName(deps.stitch);
		this.assetsDir = defaultAssetsDirFor(deps.stitch);
		this.links = inspectLinks(deps.stitch);
		const { rootIds } = parseStitchHtml(deps.stitch.html);
		this.prioritizeFirstImage = rootIds.some((id) => id.startsWith("hero-"));

		this.host = document.createElement("div");
		this.host.id = "componentize-root";
		this.root = this.host.attachShadow({ mode: "open" });

		const style = document.createElement("style");
		style.textContent = panelCss;
		this.root.append(style);
		this.root.append(el("div", { class: "panel" }));
	}

	async init(): Promise<void> {
		this.prefs = await loadPrefs();
		this.render();
	}

	private get options(): ConvertOptions {
		const { duplicatesKitNav } = inspectJs(this.stitch, this.prefs.kit);
		return {
			...this.prefs,
			// A duplicate nav script is the core's call: left out with a note, or
			// kept as a Draft. It is always handed over, and the toggle decides
			// only whether to override that default.
			includeJs: duplicatesKitNav ? true : this.prefs.includeJs,
			keepKitNavScript: duplicatesKitNav && this.keepNavJs,
			componentName: this.componentName,
			assetsDir: this.assetsDir,
			linkMappings: this.links,
			prioritizeFirstImage:
				this.prefs.imagesMode === "assets" && this.prioritizeFirstImage,
		};
	}

	private update(patch: Partial<Prefs>): void {
		this.prefs = { ...this.prefs, ...patch };
		savePrefs(this.prefs);
		this.lastResult = undefined;
		this.lastReadiness = undefined;
		this.render();
	}

	/**
	 * Drops a verdict that no longer describes the current settings.
	 *
	 * The badge and reasons are removed directly rather than by re-rendering:
	 * this runs on every keystroke in the name and route fields, and a full
	 * re-render would take the caret with it.
	 */
	private invalidateResult(): void {
		this.lastResult = undefined;
		this.lastReadiness = undefined;

		const panel = this.root.querySelector(".panel");
		if (!panel) return;
		for (const selector of [".badge", ".reasons", ".notes", ".files"]) {
			panel.querySelector(selector)?.remove();
		}
		const status = panel.querySelector(".status");
		if (status) status.textContent = "";
		this.pendingStatus = undefined;
	}

	private async generate(): Promise<ConvertResult> {
		return convert(this.stitch, this.options, this.fetchAsset);
	}

	private async run(
		action: (result: ConvertResult) => Promise<void> | void,
		status: string,
		delivery: Delivery,
		busyAction: BusyAction,
	): Promise<void> {
		if (this.busy) return;
		this.busy = true;
		this.busyAction = busyAction;
		this.render();
		try {
			const result = await this.generate();
			this.lastResult = result;
			// The verdict must describe what the user actually walks away with.
			this.lastReadiness = readinessFor(result, delivery);
			await action(result);
			this.setStatus(status);
		} catch (err) {
			this.setError(
				err instanceof InvalidNameError
					? err.message
					: `Could not build the component: ${(err as Error).message}`,
			);
		} finally {
			this.busy = false;
			this.busyAction = undefined;
			this.render();
		}
	}

	private setStatus(text: string): void {
		this.pendingStatus = text;
	}

	private setError(text: string): void {
		this.pendingError = text;
	}

	private pendingStatus?: string;
	private pendingError?: string;

	// ---------- rendering ----------

	private render(): void {
		const panel = this.root.querySelector(".panel")!;
		panel.replaceChildren();
		this.nextId = 0;

		const profile = profileFor(this.prefs.kit);
		const isI18nKit = this.prefs.kit === "i18n";
		const { hasJs, duplicatesKitNav } = inspectJs(this.stitch, this.prefs.kit);

		// --- header ---
		panel.setAttribute("role", "region");
		panel.setAttribute("aria-label", "Componentize");

		const header = el("div", { class: "header" }, [brand()]);
		if (this.lastReadiness) {
			const state = this.lastReadiness.state;
			header.append(
				el("span", { class: `badge badge--${state}` }, [
					icon(state === "ready" ? "ready" : "draft"),
					state === "ready" ? "Ready" : "Draft",
				]),
			);
		}
		// Assembled from adjacent nodes so the sha can be monospaced without
		// changing one character of the rendered line.
		header.append(
			el("p", { class: "subtitle" }, [
				`Stitch #${this.stitch.id} `,
				el("span", { class: "sep" }, ["→ "]),
				profile.label,
				el("span", { class: "sep" }, [" @ "]),
				el("span", { class: "sha" }, [profile.sha.slice(0, 8)]),
			]),
		);
		panel.append(header);

		const settings = el("div", { class: "section" });

		// --- selects ---
		const controls = el("div", { class: "controls" });
		controls.append(
			this.selectField("Kit", this.prefs.kit, KIT_LABELS, (value) =>
				this.update({
					kit: value as KitId,
					// Text extraction only exists on the i18n kit.
					i18n: value === "i18n" ? this.prefs.i18n : false,
				}),
			),
			this.selectField("Styles", this.prefs.cssFlavor, FLAVORS, (value) =>
				this.update({ cssFlavor: value as CssFlavor }),
			),
			this.selectField(
				"Images",
				this.prefs.imagesMode,
				[
					{ value: "assets", label: "Download to src/assets" },
					{ value: "raw", label: "Keep CodeStitch CDN" },
				],
				(value) => this.update({ imagesMode: value as "assets" | "raw" }),
			),
			this.textField(
				"File name",
				this.componentName,
				(value) => {
					this.componentName = value.trim();
					this.invalidateResult();
				},
				"Hero-1621  →  src/components/Hero-1621/Hero-1621.astro",
			),
		);
		if (this.prefs.imagesMode === "assets") {
			controls.append(
				this.textField(
					"Images folder",
					this.assetsDir,
					(value) => {
						this.assetsDir = value.trim();
						this.invalidateResult();
					},
					"Where downloaded images are written; must be under src/assets",
					true,
				),
			);
		}
		settings.append(controls);

		// --- toggles ---
		const toggles = el("div", { class: "toggles" });
		toggles.append(
			this.toggle("Dark mode styles", this.prefs.darkMode, (v) =>
				this.update({ darkMode: v }),
			),
			this.toggle(
				"Extract text for translation",
				this.prefs.i18n && isI18nKit,
				(v) => this.update({ i18n: v }),
				!isI18nKit,
				isI18nKit ? undefined : "Only the i18n kit uses translation files",
			),
			this.jsToggle(hasJs, duplicatesKitNav, profile.label),
			this.toggle("Include Core Styles", this.prefs.includeCoreStyles, (v) =>
				this.update({ includeCoreStyles: v }),
			),
			this.toggle(
				"Guess routes from link text",
				this.prefs.guessRoutes !== false,
				(v) => this.update({ guessRoutes: v }),
				false,
				'"Privacy Policy" becomes /privacy-policy; edit any of them below',
			),
		);
		if (this.prefs.imagesMode === "assets") {
			toggles.append(
				this.toggle(
					"Prioritize first image",
					this.prioritizeFirstImage,
					(v) => {
						this.prioritizeFirstImage = v;
						this.invalidateResult();
						this.render();
					},
					false,
					"Panel-only hero suggestion; this choice is not saved and never affects raw CDN output",
				),
			);
		}
		settings.append(toggles);
		panel.append(settings);

		// --- link mapping ---
		if (this.links.length > 0) {
			const links = el("div", { class: "links" }, [
				el("h3", {}, [this.linksHeading()]),
			]);
			links.dataset["state"] = this.linksState();
			for (const link of this.links) {
				const id = this.id("route");
				const suggested =
					this.prefs.guessRoutes !== false ? link.suggestedRoute : undefined;
				const input = el("input", {
					type: "text",
					// The derived route is shown as a real value, not a placeholder:
					// it is what will be used, so it should be visible and editable.
					value: link.route ?? suggested ?? "",
					placeholder: suggested
						? "/about"
						: "/about  (leave empty to mark TODO)",
					id,
				});
				if (!link.route && suggested) input.dataset["suggested"] = "true";
				input.addEventListener("input", () => {
					link.route = input.value;
					// Once typed over, it is no longer a guess and must stop looking
					// like one.
					delete input.dataset["suggested"];
					this.invalidateResult();
					// The "n left" count is part of the same stale picture.
					this.refreshLinkCount();
				});
				links.append(
					el("div", { class: "link-row" }, [
						el(
							"label",
							{ class: "link-text", title: link.text, htmlFor: id },
							[link.text],
						),
						input,
					]),
				);
			}
			panel.append(links);
		}

		// --- actions ---
		const actions = el("div", { class: "actions" });
		actions.setAttribute("role", "group");
		actions.setAttribute("aria-label", "Output");

		const copyBtn = this.actionButton("Copy .astro", "copy", "copy");
		copyBtn.addEventListener("click", () => {
			void this.run(
				async (result) => {
					await copyToClipboard(componentSourceFor(result, "component-only"));
				},
				"Component copied to the clipboard.",
				"component-only",
				"copy",
			);
		});

		const downloadBtn = this.actionButton("Download .astro", "download", "astro");
		downloadBtn.addEventListener("click", () => {
			void this.run(
				(result) => {
					downloadAstro(result, componentSourceFor(result, "component-only"));
				},
				"Component downloaded.",
				"component-only",
				"astro",
			);
		});

		const zipBtn = this.actionButton("Download ZIP", "zip", "zip", true);
		zipBtn.addEventListener("click", () => {
			void this.run(
				async (result) => {
					await downloadZip(result);
				},
				"ZIP downloaded — extract it over your project root.",
				"zip",
				"zip",
			);
		});

		actions.append(copyBtn, downloadBtn, zipBtn);
		// A live region so the outcome is announced, not just shown. While a
		// conversion runs it says so: image downloads can take tens of seconds,
		// and silence reads as a hang.
		const status = el("span", { class: "status" }, [
			this.busy ? "Building your component…" : this.pendingStatus ?? "",
		]);
		status.setAttribute("role", "status");
		status.setAttribute("aria-live", "polite");
		actions.append(status);
		panel.append(actions);

		// --- feedback ---
		if (this.pendingError) {
			panel.append(
				callout("error", "alert", el("span", {}, [this.pendingError])),
			);
			this.pendingError = undefined;
		}

		if (this.lastResult && this.lastReadiness) {
			const { warnings, files } = this.lastResult;
			const readiness = this.lastReadiness;
			if (readiness.state === "draft") {
				const list = el("ul");
				for (const reason of readiness.reasons) list.append(el("li", {}, [reason]));
				panel.append(
					callout(
						"reasons",
						"draft",
						el("strong", {}, ["Draft — before this ships:"]),
						list,
					),
				);
			}

			const notes = warnings.filter((w) => w.severity === "info");
			if (notes.length > 0) {
				const list = el("ul");
				for (const note of notes) list.append(el("li", {}, [note.message]));
				panel.append(
					callout("notes", "note", el("strong", {}, ["Notes:"]), list),
				);
			}

			if (files.length > 1) {
				panel.append(
					el("p", { class: "files" }, [
						`${files.length} files — use the ZIP: ${files
							.map((f) => f.path)
							.slice(0, 4)
							.join(", ")}${files.length > 4 ? `, +${files.length - 4} more` : ""}`,
					]),
				);
			}
		}

		panel.append(footer());

		this.pendingStatus = undefined;
	}

	/** Unique ids so every control has a programmatically associated label. */
	private nextId = 0;
	private id(prefix: string): string {
		return `cz-${prefix}-${this.nextId++}`;
	}

	/** How many links still have no destination, typed or derived. */
	private unresolvedLinks(): number {
		return this.links.filter((link) => {
			if (link.route?.trim()) return false;
			return !(this.prefs.guessRoutes !== false && link.suggestedRoute);
		}).length;
	}

	private linksHeading(): string {
		const left = this.unresolvedLinks();
		if (left === 0) return `Links (${this.links.length}, all set)`;
		return `Links — ${left} still need a destination`;
	}

	/** Drives the heading's colour and dot; kept in step with the count. */
	private linksState(): string {
		return this.unresolvedLinks() === 0 ? "all-set" : "needs-attention";
	}

	/** Updates the links heading in place, without disturbing the caret. */
	private refreshLinkCount(): void {
		const container = this.root.querySelector(".links");
		if (!(container instanceof HTMLElement)) return;
		const heading = container.querySelector("h3");
		if (heading) heading.textContent = this.linksHeading();
		container.dataset["state"] = this.linksState();
	}

	private actionButton(
		label: string,
		glyph: IconName,
		action: BusyAction,
		primary = false,
	): HTMLButtonElement {
		const running = this.busyAction === action;
		const button = el(
			"button",
			{
				class: primary ? "action action--primary" : "action",
				type: "button",
				disabled: this.busy,
			},
			[running ? icon("spinner", "spinner") : icon(glyph), label],
		);
		if (running) button.dataset["busy"] = "true";
		return button;
	}

	private selectField(
		label: string,
		value: string,
		options: Array<{ value: string; label: string }>,
		onChange: (value: string) => void,
	): HTMLElement {
		const id = this.id("select");
		const select = el("select", { id });
		for (const option of options) {
			const opt = el("option", { value: option.value }, [option.label]);
			if (option.value === value) opt.selected = true;
			select.append(opt);
		}
		select.addEventListener("change", () => onChange(select.value));
		return el("div", { class: "field" }, [
			el("label", { htmlFor: id }, [label]),
			select,
		]);
	}

	private textField(
		label: string,
		value: string,
		onInput: (value: string) => void,
		title?: string,
		wide = false,
	): HTMLElement {
		const id = this.id("text");
		const input = el("input", { type: "text", value, id });
		if (title) input.title = title;
		input.addEventListener("input", () => onInput(input.value));
		return el("div", { class: wide ? "field field--wide" : "field" }, [
			el("label", { htmlFor: id }, [label]),
			input,
		]);
	}

	/**
	 * The JavaScript toggle may never be ticked while the output has no script.
	 *
	 * A navigation stitch whose script duplicates the kit's sitewide nav.js is
	 * left out by default, so its toggle starts unticked and says why; ticking
	 * it is a per-stitch override that keeps the script and makes the result a
	 * Draft. Every other stitch is bound to the saved preference.
	 */
	private jsToggle(
		hasJs: boolean,
		duplicatesKitNav: boolean,
		kitLabel: string,
	): HTMLElement {
		if (!hasJs) {
			return this.toggle(
				"Include JavaScript (none in this stitch)",
				false,
				(v) => this.update({ includeJs: v }),
				true,
			);
		}
		if (duplicatesKitNav) {
			return this.toggle(
				"Include JavaScript (kit already ships this nav script)",
				this.keepNavJs,
				(v) => {
					this.keepNavJs = v;
					this.invalidateResult();
					this.render();
				},
				false,
				`${kitLabel} runs an equivalent navigation script sitewide, so this one is left out. Tick to include it anyway — the result becomes a Draft until one of them is removed.`,
			);
		}
		return this.toggle("Include JavaScript", this.prefs.includeJs, (v) =>
			this.update({ includeJs: v }),
		);
	}

	/**
	 * A pill wrapping a real checkbox.
	 *
	 * The input keeps its native semantics and focus behaviour — only its paint
	 * is replaced — and nothing but the label text goes inside, because the
	 * label is asserted verbatim.
	 */
	private toggle(
		label: string,
		checked: boolean,
		onChange: (checked: boolean) => void,
		disabled = false,
		title?: string,
	): HTMLElement {
		const input = el("input", { type: "checkbox", checked, disabled });
		input.addEventListener("change", () => onChange(input.checked));
		const wrapper = el("label", { class: "toggle" }, [input, label]);
		wrapper.dataset["disabled"] = String(disabled);
		if (title) wrapper.title = title;
		return wrapper;
	}
}

/** Renders a fatal scraping problem in place of the panel. */
export function errorPanel(message: string): HTMLElement {
	const host = document.createElement("div");
	host.id = "componentize-root";
	const root = host.attachShadow({ mode: "open" });
	const style = document.createElement("style");
	style.textContent = panelCss;
	const panel = el("div", { class: "panel" }, [
		el("div", { class: "header" }, [brand()]),
		callout("error", "alert", el("span", {}, [message])),
		footer(),
	]);
	panel.setAttribute("role", "region");
	panel.setAttribute("aria-label", "Componentize");
	root.append(style, panel);
	return host;
}
