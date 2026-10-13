import type { KitId, StitchData } from "@core/types";

/**
 * Settings that persist between stitches and that only this extension has.
 *
 * Everything CodeStitch's own Get code screen offers (styles flavour, dark
 * mode, JavaScript, file name, images, links) is read from that screen instead
 * and saved by CodeStitch, so it is not stored here.
 */
export interface Prefs {
	kit: KitId;
	includeCoreStyles: boolean;
	/** Move copy into locale files (Advanced kits). */
	i18n: boolean;
	/** Advanced v4 project keeps more than one locale. */
	multilingual: boolean;
}

/**
 * A new installation targets the current Advanced kit. A saved selection is
 * kept, so anyone already generating for v3.0.2 or the Intermediate kit keeps
 * the target they chose.
 */
export const DEFAULT_PREFS: Prefs = {
	kit: "advanced-v4",
	includeCoreStyles: false,
	i18n: true,
	multilingual: true,
};

const KITS: readonly KitId[] = ["advanced-v4", "i18n", "decap"];
const KEY = "componentize:prefs";

/**
 * The stored preferences, keeping only what this version owns. 0.1.x also
 * stored the flavour, dark mode, JavaScript, images and route guessing; those
 * now come from CodeStitch and are dropped on the next save.
 */
export function sanitizePrefs(stored: unknown): Prefs {
	const s = (typeof stored === "object" && stored !== null ? stored : {}) as Record<string, unknown>;
	const bool = (key: keyof Prefs) =>
		typeof s[key] === "boolean" ? (s[key] as boolean) : (DEFAULT_PREFS[key] as boolean);
	return {
		kit: KITS.includes(s["kit"] as KitId) ? (s["kit"] as KitId) : DEFAULT_PREFS.kit,
		includeCoreStyles: bool("includeCoreStyles"),
		i18n: bool("i18n"),
		multilingual: bool("multilingual"),
	};
}

export async function loadPrefs(): Promise<Prefs> {
	try {
		const stored = await chrome.storage.sync.get(KEY);
		return sanitizePrefs(stored[KEY]);
	} catch {
		return { ...DEFAULT_PREFS };
	}
}

let saveTimer: ReturnType<typeof setTimeout> | undefined;

export function savePrefs(prefs: Prefs): void {
	clearTimeout(saveTimer);
	saveTimer = setTimeout(() => {
		void chrome.storage.sync.set({ [KEY]: sanitizePrefs(prefs) }).catch(() => {
			/* storage is best-effort; the panel still works without it */
		});
	}, 300);
}

/** Choices about one stitch that should survive a reload. */
export interface StitchState {
	/** Opt-ins to fill an empty social link from the kit's business data, by mapping id. */
	socialChoices: Record<string, boolean>;
}

const stitchKey = (id: string) => `componentize:stitch:${id}`;

/**
 * FNV-1a over the stitch's markup.
 *
 * Mapping ids are positional and count every anchor, placeholder or not, so
 * any edit upstream (even inserting an ordinary link earlier on) can make
 * `link-1` mean a different anchor. Saved choices are only trusted for the
 * exact markup they were made on.
 */
export function markupFingerprint(stitch: Pick<StitchData, "html">): string {
	const text = stitch.html.replace(/\r\n?/g, "\n").trim();
	let hash = 0x811c9dc5;
	for (let i = 0; i < text.length; i++) {
		hash ^= text.charCodeAt(i);
		hash = Math.imul(hash, 0x01000193) >>> 0;
	}
	return `${text.length.toString(36)}-${hash.toString(36)}`;
}

/** Parses stored state, discarding it when it was saved for different markup. */
export function stitchStateFrom(stored: unknown, fingerprint: string): StitchState {
	const empty: StitchState = { socialChoices: {} };
	if (typeof stored !== "object" || stored === null) return empty;
	const s = stored as Record<string, unknown>;
	if (s["fingerprint"] !== fingerprint) return empty;
	const choices: Record<string, boolean> = {};
	if (typeof s["socialChoices"] === "object" && s["socialChoices"] !== null) {
		for (const [id, value] of Object.entries(s["socialChoices"] as Record<string, unknown>)) {
			if (typeof value === "boolean") choices[id] = value;
		}
	}
	return { socialChoices: choices };
}

export async function loadStitchState(id: string, fingerprint: string): Promise<StitchState> {
	try {
		const stored = await chrome.storage.local.get(stitchKey(id));
		return stitchStateFrom(stored[stitchKey(id)], fingerprint);
	} catch {
		return { socialChoices: {} };
	}
}

const stitchTimers = new Map<string, ReturnType<typeof setTimeout>>();

export function saveStitchState(id: string, fingerprint: string, state: StitchState): void {
	clearTimeout(stitchTimers.get(id));
	stitchTimers.set(
		id,
		setTimeout(() => {
			void chrome.storage.local
				.set({ [stitchKey(id)]: { fingerprint, ...state } })
				.catch(() => {
					/* best-effort, like the preferences */
				});
		}, 300),
	);
}
