/**
 * Reads CodeStitch's own Get code settings, so the panel does not repeat them.
 *
 * The DOM is the live truth. CodeStitch saves preferences to the account when
 * signed in and to localStorage when not, and keeps per-stitch edits in
 * localStorage; reading the controls covers every case with one code path.
 *
 * Their script renders the controls synchronously at load, before this
 * extension's content script runs, and re-renders them on every settings
 * change. If it never ran (a blocked CDN script, a client-side swap), the
 * server's skeleton is still there with every box unchecked, which must not
 * read as "off": `rendered` is false and CodeStitch's defaults apply instead.
 */
import { SEL } from "./selectors";

export type HostFormat = "html" | "single" | "astro" | "shopify";
export type HostFlavour = "css" | "less" | "scss";

/** One of CodeStitch's link fields, numbered by its own link list. */
export interface HostLinkRow {
	/** input[data-link]: the index into CodeStitch's empty-href list. */
	index: number;
	text: string;
	href: string;
	/** The value is CodeStitch's guess, not something the user typed. */
	guessed: boolean;
}

export interface HostSettings {
	/** CodeStitch's script has rendered the controls. */
	rendered: boolean;
	format: HostFormat;
	flavour: HostFlavour;
	darkStyles: boolean;
	includeJs: boolean;
	/** The typed name, else CodeStitch's default (the field's placeholder). */
	fileName: string;
	imagesMode: "cdn" | "local";
	imagesFolder: string;
	replaceLinks: boolean;
	guessRoutes: boolean;
	links: HostLinkRow[];
	/**
	 * Whether each value is one the user can currently set on the page. Where it
	 * is not, the panel shows its own control instead.
	 */
	usable: {
		/** Single file and Shopify force CSS and disable the other flavours. */
		flavour: boolean;
		/** Disabled when CodeStitch believes the stitch has no dark styles. */
		darkStyles: boolean;
		includeJs: boolean;
		/** Hidden under Shopify, which names its file from a section id. */
		fileName: boolean;
		images: boolean;
		links: boolean;
	};
}

/** What CodeStitch's "Reset to CodeStitch defaults" restores (get-code-export.js). */
export const CODESTITCH_DEFAULTS = {
	format: "html",
	flavour: "css",
	darkStyles: true,
	includeJs: true,
	imagesMode: "cdn",
	imagesFolder: "/assets/images",
	replaceLinks: true,
	guessRoutes: true,
} as const;

const FORMATS: readonly HostFormat[] = ["html", "single", "astro", "shopify"];
const FLAVOURS: readonly HostFlavour[] = ["css", "less", "scss"];

function pressed(root: ParentNode, group: string): string | undefined {
	return (
		root.querySelector<HTMLElement>(`${group} ${SEL.segPressed}`)?.dataset["id"] ??
		undefined
	);
}

function oneOf<T extends string>(value: string | undefined, allowed: readonly T[], fallback: T): T {
	return value && (allowed as readonly string[]).includes(value) ? (value as T) : fallback;
}

/** Hidden by the attribute on the element or on any ancestor up to the inspector. */
function isHidden(el: Element | null): boolean {
	for (let node: Element | null = el; node; node = node.parentElement) {
		if (node.hasAttribute("hidden")) return true;
		if (node.matches?.(SEL.inspector)) break;
	}
	return false;
}

export function readHostSettings(root: ParentNode): HostSettings {
	const rendered = pressed(root, SEL.formats) !== undefined;
	const input = (selector: string) => root.querySelector<HTMLInputElement>(selector);

	if (!rendered) {
		return {
			rendered: false,
			...CODESTITCH_DEFAULTS,
			fileName: "",
			links: [],
			usable: {
				flavour: false,
				darkStyles: false,
				includeJs: false,
				fileName: false,
				images: false,
				links: false,
			},
		};
	}

	const format = oneOf(pressed(root, SEL.formats), FORMATS, CODESTITCH_DEFAULTS.format);
	const dark = input(SEL.darkStyles);
	const js = input(SEL.includeJs);
	const name = input(SEL.fileName);
	const folder = input(SEL.imagesFolder);
	const replace = input(SEL.replaceLinks);
	const guess = input(SEL.guessRoutes);

	const links: HostLinkRow[] = [];
	for (const row of root.querySelectorAll<HTMLElement>(`${SEL.linkRows} ${SEL.linkRow}`)) {
		const field = row.querySelector<HTMLInputElement>(SEL.linkRowInput);
		const index = Number(field?.dataset["link"]);
		if (!field || !Number.isInteger(index)) continue;
		const meta = row.querySelector(`${SEL.linkRowMeta}:not([data-componentize])`);
		links.push({
			index,
			text: (row.querySelector(SEL.linkRowLabel)?.textContent ?? "").trim(),
			href: field.value.trim(),
			guessed: /guessed from the link text/i.test(meta?.textContent ?? ""),
		});
	}

	return {
		rendered: true,
		format,
		flavour: oneOf(pressed(root, SEL.flavours), FLAVOURS, CODESTITCH_DEFAULTS.flavour),
		darkStyles: dark ? dark.checked : CODESTITCH_DEFAULTS.darkStyles,
		includeJs: js ? js.checked : CODESTITCH_DEFAULTS.includeJs,
		fileName: (name?.value.trim() || name?.placeholder.trim()) ?? "",
		imagesMode: pressed(root, SEL.imageModes) === "local" ? "local" : "cdn",
		imagesFolder: folder?.value.trim() || CODESTITCH_DEFAULTS.imagesFolder,
		replaceLinks: replace ? replace.checked : CODESTITCH_DEFAULTS.replaceLinks,
		guessRoutes: guess ? guess.checked : CODESTITCH_DEFAULTS.guessRoutes,
		links,
		usable: {
			// Under these formats the pressed CSS button stays enabled while the
			// others are disabled, so the restriction shows in the format only.
			flavour: format !== "single" && format !== "shopify",
			darkStyles: Boolean(dark && !dark.disabled),
			includeJs: Boolean(js),
			fileName: Boolean(name) && !isHidden(root.querySelector(SEL.fileRow)),
			images: true,
			links: true,
		},
	};
}

/** A note the panel wants under one of CodeStitch's link rows. Plain data. */
export type HostNote =
	| { kind: "note"; text: string }
	| { kind: "choice"; mappingId: string; text: string; checked: boolean };

export interface HostBridge {
	read(): HostSettings;
	/** Calls back after any change to CodeStitch's settings. Returns a disposer. */
	observe(onChange: () => void): () => void;
	/** Places notes under CodeStitch's link rows, keyed by input[data-link]. */
	annotateLinkRows(
		notes: ReadonlyMap<number, HostNote>,
		onToggle: (mappingId: string, checked: boolean) => void,
	): void;
}

const MARK = "data-componentize";

export function createHostBridge(doc: Document, ownHost?: () => Element | null): HostBridge {
	/*
	 * Where an event came from is decided in the capture phase, before any
	 * handler runs. CodeStitch's click handlers replace the segment buttons with
	 * innerHTML, so by the bubble phase the clicked button can be detached, and
	 * neither closest() nor (in some engines) composedPath() still reaches the
	 * inspector.
	 */
	const origin = (event: Event): "ours" | "inspector" | "elsewhere" => {
		const path = event.composedPath().filter((n): n is Element => n instanceof Element);
		const host = ownHost?.();
		if ((host && path.includes(host)) || path.some((el) => el.hasAttribute(MARK))) {
			return "ours";
		}
		return path.some((el) => el.matches(SEL.inspector)) ? "inspector" : "elsewhere";
	};

	return {
		read: () => readHostSettings(doc),

		observe(onChange) {
			const view = doc.defaultView;
			const relevant = new WeakSet<Event>();
			const capture = (event: Event) => {
				if (origin(event) === "inspector") relevant.add(event);
			};
			// Bubbling phase: CodeStitch's listeners sit on the controls
			// themselves, so their re-render has happened by the time this runs.
			const listener = (event: Event) => {
				if (relevant.has(event)) onChange();
			};
			for (const type of ["click", "change", "input"]) {
				doc.addEventListener(type, capture, true);
				doc.addEventListener(type, listener);
			}

			const observers: MutationObserver[] = [];
			const Observer = view?.MutationObserver;
			const rows = doc.querySelector(SEL.linkRows);
			if (Observer && rows) {
				const rowsObserver = new Observer((records) => {
					const foreign = records.some((r) =>
						[...r.addedNodes, ...r.removedNodes].some(
							(n) => !(n instanceof Element && n.hasAttribute(MARK)),
						),
					);
					if (foreign) onChange();
				});
				rowsObserver.observe(rows, { childList: true, subtree: true });
				observers.push(rowsObserver);
			}
			// Their script can run after ours (slow network); notice when it does.
			const formats = doc.querySelector(SEL.formats);
			if (Observer && formats && !readHostSettings(doc).rendered) {
				const late = new Observer(() => {
					if (!readHostSettings(doc).rendered) return;
					late.disconnect();
					onChange();
				});
				late.observe(formats, { childList: true, subtree: true, attributes: true });
				observers.push(late);
			}

			return () => {
				for (const type of ["click", "change", "input"]) {
					doc.removeEventListener(type, capture, true);
					doc.removeEventListener(type, listener);
				}
				for (const observer of observers) observer.disconnect();
			};
		},

		annotateLinkRows(notes, onToggle) {
			for (const old of doc.querySelectorAll(`${SEL.linkRows} [${MARK}]`)) old.remove();
			for (const row of doc.querySelectorAll<HTMLElement>(`${SEL.linkRows} ${SEL.linkRow}`)) {
				const index = Number(row.querySelector<HTMLElement>(SEL.linkRowInput)?.dataset["link"]);
				const note = notes.get(index);
				if (!note) continue;

				const p = doc.createElement("p");
				p.className = "gc-link-row__meta";
				p.setAttribute(MARK, "");
				if (note.kind === "note") {
					p.textContent = `Componentize: ${note.text}`;
				} else {
					const label = doc.createElement("label");
					const box = doc.createElement("input");
					box.type = "checkbox";
					box.checked = note.checked;
					box.addEventListener("change", () => onToggle(note.mappingId, box.checked));
					label.append(box, ` Componentize: ${note.text}`);
					p.append(label);
				}
				row.append(p);
			}
		},
	};
}
