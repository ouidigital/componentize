import type {
	AssetPayload,
	ConvertResult,
	CssFlavor,
	ImagesMode,
	KitId,
	Readiness,
	StitchData,
} from "@core/types";
import { componentSourceFor, convert, kitCapabilities } from "@core/convert";
import { profileFor } from "@core/kits/profile";
import { InvalidNameError } from "@core/naming";
import { parseStitchHtml } from "@core/html/parse";
import {
	astroBlob,
	astroFileName,
	buildZip,
	copyToClipboard,
	downloadBlob,
	zipFileName,
} from "@output/index";
import { readinessFor, type Delivery } from "@core/readiness";
import type { HostBridge, HostSettings } from "@content/host-fields";
import {
	DEFAULT_PREFS,
	loadPrefs,
	loadStitchState,
	markupFingerprint,
	savePrefs,
	saveStitchState,
	type Prefs,
} from "./prefs";
import {
	codestitchDefaultFileName,
	composeOptions,
	defaultFallbacks,
	type Composed,
	type FallbackValues,
} from "./host-options";
import panelCss from "./panel.css?inline";

/**
 * The panel is hand-rolled inside a shadow root: CodeStitch's own stylesheet
 * cannot reach in, and nothing we add leaks out onto their page.
 */

export interface PanelDeps {
	stitch: StitchData;
	fetchAsset: (url: string, maxBytes?: number) => Promise<AssetPayload | undefined>;
	/** CodeStitch's own Get code settings, read live. */
	host: HostBridge;
}

/**
 * Both Advanced versions are offered by name: they are different kits with
 * different APIs, and a component built for one does not compile in the other.
 */
const KIT_LABELS: Array<{ value: KitId; label: string }> = [
	{ value: "advanced-v4", label: "Advanced Astro v4" },
	{ value: "i18n", label: "Advanced Astro v3.0.2 (legacy)" },
	{ value: "decap", label: "Intermediate Astro + Decap" },
];

/** Only offered where Get code cannot set the flavour (Single file, Shopify). */
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

/** What an action does once the result is built; false means it held back. */
type Deliver = (result: ConvertResult, current: () => boolean) => Promise<boolean>;

/**
 * The fourth section of CodeStitch's Get code inspector.
 *
 * Everything Get code already offers (styles, dark mode, JavaScript, file name,
 * images, links) is read from CodeStitch's own controls. The panel shows only
 * what is Componentize's: the target kit, locale handling, core styles, image
 * priority, the nav-script exception, links Get code does not list, and the
 * Ready/Draft verdict. Where a Get code control is locked or missing, the
 * panel shows its own stand-in for exactly that one.
 */
export class ComponentizePanel {
	readonly host: HTMLElement;
	private readonly root: ShadowRoot;
	private readonly stitch: StitchData;
	private readonly fetchAsset: PanelDeps["fetchAsset"];
	private readonly bridge: HostBridge;
	private readonly fingerprint: string;

	private prefs: Prefs = { ...DEFAULT_PREFS };
	private hostSettings: HostSettings;
	private composed: Composed;
	private lastResult?: ConvertResult;
	/** Readiness of the last delivery, which may be stricter than the conversion's. */
	private lastReadiness?: Readiness;
	private busy = false;
	private busyAction?: BusyAction;
	private disposed = false;
	private disposeHost?: () => void;

	/**
	 * Bumped whenever the effective conversion settings change. A build that
	 * started under an older revision is never delivered or shown as current.
	 */
	private settingsRevision = 0;
	private lastOptionsKey = "";
	private lastLayoutKey = "";

	/**
	 * Per-stitch override: include a navigation script the kit already ships.
	 * Deliberately not a preference — it is a decision about this stitch, and
	 * carrying it to the next one would silently double-bind another menu.
	 */
	private keepNavJs = false;
	/** Per-stitch choice; unlike Prefs, it must not carry to another stitch. */
	private prioritizeFirstImage: boolean;
	/** Destinations typed into the panel's own link rows. */
	private readonly ownRoutes = new Map<string, string>();
	/** Opt-ins to fill an empty social link from the kit's business data. */
	private readonly socialChoices = new Map<string, boolean>();
	/** Values for the stand-in controls, used only where Get code's are unusable. */
	private fallback: FallbackValues;

	constructor(deps: PanelDeps) {
		this.stitch = deps.stitch;
		this.fetchAsset = deps.fetchAsset;
		this.bridge = deps.host;
		this.fingerprint = markupFingerprint(deps.stitch);
		this.fallback = defaultFallbacks(deps.stitch);
		const { rootIds } = parseStitchHtml(deps.stitch.html);
		this.prioritizeFirstImage = rootIds.some((id) => id.startsWith("hero-"));
		this.hostSettings = this.bridge.read();
		this.composed = this.compose();

		this.host = document.createElement("div");
		this.host.id = "componentize-root";
		this.root = this.host.attachShadow({ mode: "open" });

		const style = document.createElement("style");
		style.textContent = panelCss;
		this.root.append(style);
		this.root.append(el("div", { class: "panel" }));
	}

	async init(): Promise<void> {
		const [prefs, state] = await Promise.all([
			loadPrefs(),
			loadStitchState(this.stitch.id, this.fingerprint),
		]);
		if (this.disposed) return;
		this.prefs = prefs;
		for (const [id, checked] of Object.entries(state.socialChoices)) {
			this.socialChoices.set(id, checked);
		}
		this.disposeHost = this.bridge.observe(() => this.onHostChange());
		this.hostSettings = this.bridge.read();
		// A saved opt-in is void if Get code's field already holds a URL, or
		// clearing that URL first would bring the substitution back.
		this.composed = this.composeVoidingOverriddenSocials();
		this.lastOptionsKey = this.composed.optionsKey;
		this.lastLayoutKey = this.composed.layoutKey;
		this.render();
	}

	/** Stops listening to the page; any build in flight is then discarded. */
	destroy(): void {
		this.disposed = true;
		this.disposeHost?.();
		this.disposeHost = undefined;
	}

	private compose(): Composed {
		return composeOptions(this.stitch, this.prefs, this.hostSettings, {
			keepNavJs: this.keepNavJs,
			prioritizeFirstImage: this.prioritizeFirstImage,
			ownRoutes: this.ownRoutes,
			socialChoices: this.socialChoices,
			fallback: this.fallback,
		});
	}

	/**
	 * Composes, after voiding the opt-in of every social link whose Get code
	 * field holds a destination: clearing that field later must give a TODO,
	 * not a silently restored link.
	 */
	private composeVoidingOverriddenSocials(): Composed {
		const composed = this.compose();
		const voided = composed.overriddenSocials.filter((id) => this.socialChoices.get(id));
		if (voided.length === 0) return composed;
		for (const id of voided) this.socialChoices.set(id, false);
		this.saveStitchState();
		return this.compose();
	}

	private onHostChange(): void {
		if (this.disposed) return;
		this.hostSettings = this.bridge.read();
		this.changed();
	}

	/**
	 * Recomposes after any change, here or in Get code.
	 *
	 * The verdict is dropped and the revision moves only when the conversion
	 * itself would change, so focusing a field or re-clicking the current
	 * flavour cancels nothing. The panel re-renders only when the set of
	 * controls changes, and otherwise refreshes in place, keeping the caret.
	 */
	private changed(): void {
		const composed = this.composeVoidingOverriddenSocials();
		this.composed = composed;

		if (composed.optionsKey !== this.lastOptionsKey) {
			this.lastOptionsKey = composed.optionsKey;
			this.settingsRevision++;
			this.invalidateResult();
		}
		if (composed.layoutKey !== this.lastLayoutKey) {
			this.lastLayoutKey = composed.layoutKey;
			this.render();
		} else {
			this.refreshInPlace();
		}
	}

	private update(patch: Partial<Prefs>): void {
		this.prefs = { ...this.prefs, ...patch };
		savePrefs(this.prefs);
		this.changed();
		// Kit and language toggles change labels and hints, not just layout.
		this.render();
	}

	private readonly onSocialToggle = (mappingId: string, checked: boolean): void => {
		this.socialChoices.set(mappingId, checked);
		this.saveStitchState();
		this.changed();
	};

	private saveStitchState(): void {
		saveStitchState(this.stitch.id, this.fingerprint, {
			socialChoices: Object.fromEntries(this.socialChoices),
		});
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
		if (status && !this.busy) status.textContent = "";
		this.pendingStatus = undefined;
	}

	/** Updates text that follows the settings without rebuilding any control. */
	private refreshInPlace(): void {
		const summary = this.root.querySelector(".host-summary");
		if (summary) summary.replaceChildren(...this.summaryNodes());

		for (const input of this.root.querySelectorAll<HTMLInputElement>(".link-row input")) {
			const id = input.dataset["mapping"];
			const row = this.composed.ownRows.find((r) => r.id === id);
			if (!id || !row || this.ownRoutes.has(id)) continue;
			input.value = row.suggestedRoute ?? "";
			if (row.suggestedRoute) input.dataset["suggested"] = "true";
			else delete input.dataset["suggested"];
		}
		this.refreshLinkCount();
		this.bridge.annotateLinkRows(this.composed.hostNotes, this.onSocialToggle);
	}

	private async generate(): Promise<ConvertResult> {
		const { options, preflight } = this.compose();
		return convert(this.stitch, { ...options, preflightWarnings: preflight }, this.fetchAsset);
	}

	/**
	 * Builds and delivers, checking three times that the result still matches
	 * the settings: after converting, immediately before handing anything over,
	 * and again before showing a verdict, because a copy can complete after the
	 * settings moved on.
	 */
	private async run(
		deliver: Deliver,
		done: { status: string; verb: string },
		delivery: Delivery,
		busyAction: BusyAction,
	): Promise<void> {
		if (this.busy) return;
		const revision = this.settingsRevision;
		const current = () => !this.disposed && revision === this.settingsRevision;
		const stale = "Settings changed while building, click again.";

		this.busy = true;
		this.busyAction = busyAction;
		this.render();
		try {
			const result = await this.generate();
			if (!current()) {
				this.setStatus(stale);
				return;
			}
			const delivered = await deliver(result, current);
			if (!delivered) {
				this.setStatus(stale);
				return;
			}
			if (!current()) {
				this.setStatus(
					`${done.verb}, but the settings changed meanwhile: build again for a current verdict.`,
				);
				return;
			}
			this.lastResult = result;
			// The verdict must describe what the user actually walks away with.
			this.lastReadiness = readinessFor(result, delivery);
			this.setStatus(done.status);
		} catch (err) {
			if (this.disposed) return;
			this.setError(
				err instanceof InvalidNameError
					? err.message
					: `Could not build the component: ${(err as Error).message}`,
			);
		} finally {
			this.busy = false;
			this.busyAction = undefined;
			if (!this.disposed) this.render();
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

	private summaryNodes(): Array<Node | string> {
		const s = this.composed.summary;
		if (!s.rendered) {
			return ["Get code settings not detected, so Componentize's own defaults apply below."];
		}
		return [
			"From Get code: ",
			el("span", { class: "mono" }, [`${s.componentName}.astro`]),
			` · ${s.flavourLabel}${s.dark ? " · dark" : ""} · ${s.imagesLabel} · ${s.linksLabel}`,
		];
	}

	private render(): void {
		if (this.disposed) return;
		const panel = this.root.querySelector(".panel")!;
		panel.replaceChildren();
		this.nextId = 0;

		const c = this.composed;
		const profile = profileFor(this.prefs.kit);
		const capabilities = kitCapabilities(this.prefs.kit);

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

		const summary = el("p", { class: "host-summary" }, this.summaryNodes());
		summary.setAttribute("aria-live", "polite");
		panel.append(summary);

		const settings = el("div", { class: "section" });

		// --- kit and stand-ins for Get code controls ---
		const controls = el("div", { class: "controls" });
		controls.append(
			this.selectField("Kit", this.prefs.kit, KIT_LABELS, (value) => {
				this.update({ kit: value as KitId });
			}),
		);
		if (c.fallbacks.has("flavour")) {
			controls.append(
				this.selectField(
					"Styles",
					this.fallback.flavour,
					FLAVORS,
					(value) => this.setFallback({ flavour: value as CssFlavor }),
					this.hostSettings.rendered
						? "Get code forces CSS for this format; Componentize uses this instead"
						: undefined,
				),
			);
		}
		if (c.fallbacks.has("imagesMode")) {
			controls.append(
				this.selectField(
					"Images",
					this.fallback.imagesMode,
					[
						{ value: "assets", label: "Download to src/assets" },
						{ value: "raw", label: "Keep CodeStitch CDN" },
					],
					(value) => this.setFallback({ imagesMode: value as ImagesMode }),
				),
			);
		}
		if (c.fallbacks.has("fileName")) {
			controls.append(
				this.textField(
					"File name",
					this.fallback.fileName,
					(value) => this.setFallback({ fileName: value.trim() }, false),
					this.hostSettings.rendered
						? "Get code names Shopify sections by their id; this names the .astro file"
						: "Hero-1621  →  src/components/Hero-1621/Hero-1621.astro",
					false,
					codestitchDefaultFileName(this.stitch.html),
				),
			);
		}
		if (c.fallbacks.has("assetsDir")) {
			controls.append(
				this.textField(
					"Images folder",
					this.fallback.assetsDir,
					(value) => this.setFallback({ assetsDir: value.trim() }, false),
					"Where downloaded images are written; must be under src/assets",
					true,
				),
			);
		}
		settings.append(controls);

		// --- toggles ---
		const toggles = el("div", { class: "toggles" });
		if (c.fallbacks.has("darkMode")) {
			toggles.append(
				this.toggle(
					"Dark mode styles",
					this.fallback.darkMode,
					(v) => this.setFallback({ darkMode: v }),
					false,
					this.hostSettings.rendered
						? "Get code's dark mode box is unavailable for this stitch in this flavour, but the stitch has dark styles"
						: undefined,
				),
			);
		}
		if (c.fallbacks.has("includeJs")) {
			toggles.append(
				this.toggle("Include JavaScript", this.fallback.includeJs, (v) =>
					this.setFallback({ includeJs: v }),
				),
			);
		}
		toggles.append(
			this.toggle(
				"Extract text for translation",
				this.prefs.i18n && capabilities.textExtraction,
				(v) => this.update({ i18n: v }),
				!capabilities.textExtraction,
				capabilities.textExtraction
					? "Copy moves into locale files; untick to leave it in the markup"
					: `${profile.label} keeps copy in the markup, not in locale files`,
			),
			this.toggle(
				"Multiple languages",
				this.prefs.multilingual !== false && capabilities.optionalI18n,
				(v) => this.update({ multilingual: v }),
				!capabilities.optionalI18n,
				capabilities.optionalI18n
					? `Match the project: untick if it was set up without i18n, and only ${profile.defaultLocale ?? "the default locale"} is written`
					: `${profile.label} has no single-language setup`,
			),
			this.toggle("Include Core Styles", this.prefs.includeCoreStyles, (v) =>
				this.update({ includeCoreStyles: v }),
			),
		);
		if (c.duplicatesKitNav && c.options.includeJs) {
			toggles.append(
				this.toggle(
					"Include JavaScript (kit already ships this nav script)",
					this.keepNavJs,
					(v) => {
						this.keepNavJs = v;
						this.changed();
					},
					false,
					`${profile.label} runs an equivalent navigation script sitewide, so this one is left out. Tick to include it anyway — the result becomes a Draft until one of them is removed.`,
				),
			);
		}
		if (c.fallbacks.has("guessRoutes")) {
			toggles.append(
				this.toggle(
					"Guess routes from link text",
					this.fallback.guessRoutes,
					(v) => this.setFallback({ guessRoutes: v }),
					false,
					'"Privacy Policy" becomes /privacy-policy; edit any of them below',
				),
			);
		}
		if (c.options.imagesMode === "assets") {
			toggles.append(
				this.toggle(
					"Prioritize first image",
					this.prioritizeFirstImage,
					(v) => {
						this.prioritizeFirstImage = v;
						this.changed();
					},
					false,
					"Panel-only hero suggestion; this choice is not saved and never affects raw CDN output",
				),
			);
		}
		settings.append(toggles);
		panel.append(settings);

		// --- links Get code does not list ---
		if (this.hostSettings.usable.links && !this.hostSettings.replaceLinks) {
			panel.append(
				el("p", { class: "hint" }, [
					"Replace links is off in Get code, so every link is marked TODO.",
				]),
			);
		}
		if (c.ownRows.length > 0) {
			const links = el("div", { class: "links" }, [el("h3", {}, [this.linksHeading()])]);
			links.dataset["state"] = this.linksState();
			for (const link of c.ownRows) {
				const id = this.id("route");
				const typed = this.ownRoutes.get(link.id);
				const suggested = link.suggestedRoute;
				const input = el("input", {
					type: "text",
					// The derived route is shown as a real value, not a placeholder:
					// it is what will be used, so it should be visible and editable.
					value: typed ?? suggested ?? "",
					placeholder: suggested ? "/about" : "/about  (leave empty to mark TODO)",
					id,
				});
				input.dataset["mapping"] = link.id;
				if (typed === undefined && suggested) input.dataset["suggested"] = "true";
				input.addEventListener("input", () => {
					this.ownRoutes.set(link.id, input.value.trim());
					// Once typed over, it is no longer a guess and must stop looking
					// like one.
					delete input.dataset["suggested"];
					this.changed();
				});
				links.append(
					el("div", { class: "link-row" }, [
						el("label", { class: "link-text", title: link.text, htmlFor: id }, [link.text]),
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
				async (result, current) => {
					const source = componentSourceFor(result, "component-only");
					if (!current()) return false;
					await copyToClipboard(source);
					return true;
				},
				{ status: "Component copied to the clipboard.", verb: "Copied" },
				"component-only",
				"copy",
			);
		});

		const downloadBtn = this.actionButton("Download .astro", "download", "astro");
		downloadBtn.addEventListener("click", () => {
			void this.run(
				async (result, current) => {
					const blob = astroBlob(componentSourceFor(result, "component-only"));
					if (!current()) return false;
					downloadBlob(blob, astroFileName(result));
					return true;
				},
				{ status: "Component downloaded.", verb: "Downloaded" },
				"component-only",
				"astro",
			);
		});

		const zipBtn = this.actionButton("Download ZIP", "zip", "zip", true);
		zipBtn.addEventListener("click", () => {
			void this.run(
				async (result, current) => {
					const blob = await buildZip(result);
					if (!current()) return false;
					downloadBlob(blob, zipFileName(result));
					return true;
				},
				{ status: "ZIP downloaded — extract it over your project root.", verb: "Downloaded" },
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
			panel.append(callout("error", "alert", el("span", {}, [this.pendingError])));
			this.pendingError = undefined;
		}

		if (this.lastResult && this.lastReadiness) {
			const { warnings, files } = this.lastResult;
			const readiness = this.lastReadiness;
			if (readiness.state === "draft") {
				const list = el("ul");
				for (const reason of readiness.reasons) list.append(el("li", {}, [reason]));
				panel.append(
					callout("reasons", "draft", el("strong", {}, ["Draft — before this ships:"]), list),
				);
			}

			const notes = warnings.filter((w) => w.severity === "info");
			if (notes.length > 0) {
				const list = el("ul");
				for (const note of notes) list.append(el("li", {}, [note.message]));
				panel.append(callout("notes", "note", el("strong", {}, ["Notes:"]), list));
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
		this.bridge.annotateLinkRows(c.hostNotes, this.onSocialToggle);
	}

	/** Sets a stand-in value; text fields skip the re-render to keep the caret. */
	private setFallback(patch: Partial<FallbackValues>, rerender = true): void {
		this.fallback = { ...this.fallback, ...patch };
		this.changed();
		if (rerender) this.render();
	}

	/** Unique ids so every control has a programmatically associated label. */
	private nextId = 0;
	private id(prefix: string): string {
		return `cz-${prefix}-${this.nextId++}`;
	}

	/** How many of the panel's own links still have no destination. */
	private unresolvedLinks(): number {
		return this.composed.ownRows.filter((link) => {
			const value = this.ownRoutes.get(link.id) ?? link.suggestedRoute ?? "";
			return !value.trim();
		}).length;
	}

	private linksHeading(): string {
		const total = this.composed.ownRows.length;
		const left = this.unresolvedLinks();
		const what =
			this.composed.pairing === "paired" ? "Links Get code does not list" : "Links";
		if (left === 0) return `${what} (${total}, all set)`;
		return `${what} — ${left} still need a destination`;
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
		title?: string,
	): HTMLElement {
		const id = this.id("select");
		const select = el("select", { id });
		for (const option of options) {
			const opt = el("option", { value: option.value }, [option.label]);
			if (option.value === value) opt.selected = true;
			select.append(opt);
		}
		if (title) select.title = title;
		select.addEventListener("change", () => onChange(select.value));
		return el("div", { class: "field" }, [el("label", { htmlFor: id }, [label]), select]);
	}

	private textField(
		label: string,
		value: string,
		onInput: (value: string) => void,
		title?: string,
		wide = false,
		placeholder?: string,
	): HTMLElement {
		const id = this.id("text");
		const input = el("input", { type: "text", value, id });
		if (title) input.title = title;
		if (placeholder) input.placeholder = placeholder;
		input.addEventListener("input", () => onInput(input.value));
		return el("div", { class: wide ? "field field--wide" : "field" }, [
			el("label", { htmlFor: id }, [label]),
			input,
		]);
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
