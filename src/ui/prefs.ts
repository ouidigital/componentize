import type { ConvertOptions } from "@core/types";

/**
 * Options that persist between stitches. The name, link mappings and the
 * keep-nav-script override never do: each is a decision about one stitch.
 */
export type Prefs = Omit<
	ConvertOptions,
	| "componentName"
	| "linkMappings"
	| "extraLocales"
	| "keepKitNavScript"
	| "prioritizeFirstImage"
>;

/**
 * A new installation targets the current Advanced kit. A saved selection is
 * merged over these, so anyone already generating for v3.0.2 or the
 * Intermediate kit keeps the target they chose.
 */
export const DEFAULT_PREFS: Prefs = {
	kit: "advanced-v4",
	cssFlavor: "less",
	darkMode: true,
	includeCoreStyles: false,
	includeJs: true,
	i18n: true,
	multilingual: true,
	imagesMode: "assets",
	guessRoutes: true,
};

const KEY = "componentize:prefs";

export async function loadPrefs(): Promise<Prefs> {
	try {
		const stored = await chrome.storage.sync.get(KEY);
		return { ...DEFAULT_PREFS, ...(stored[KEY] as Partial<Prefs> | undefined) };
	} catch {
		return { ...DEFAULT_PREFS };
	}
}

let saveTimer: ReturnType<typeof setTimeout> | undefined;

export function savePrefs(prefs: Prefs): void {
	clearTimeout(saveTimer);
	saveTimer = setTimeout(() => {
		void chrome.storage.sync.set({ [KEY]: prefs }).catch(() => {
			/* storage is best-effort; the panel still works without it */
		});
	}, 300);
}
