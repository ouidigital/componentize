import type { KitId } from "../types";
import advancedI18n from "./profiles/advanced-i18n.json" with { type: "json" };
import intermediateDecap from "./profiles/intermediate-decap.json" with { type: "json" };

/**
 * A snapshot of a pinned kit commit. Everything the converter compares against
 * lives here, so a "Ready" verdict is a claim about a specific, known codebase.
 * Regenerate with `npm run profiles`.
 */
export interface KitProfile {
	key: string;
	kitId: KitId;
	label: string;
	repo: string;
	sha: string;
	astroVersion: string | null;
	hasLess: boolean;
	hasSass: boolean;
	aliases: string[];
	/** Locales configured in the pinned kit; required — cannot be removed. */
	locales: string[];
	defaultLocale: string | null;
	/** Page routes present in the pristine kit. */
	routes: string[];
	/** Localizable route segments from routeTranslations.ts. */
	routeSegments: string[];
	/** SVG names shipped in src/icons — <Icon name> is only valid for these. */
	icons: string[];
	/**
	 * The kit's global helper classes as selector -> (property -> normalised
	 * value). Values are kept so a rule can only be dropped when it repeats the
	 * kit exactly, never merely because it touches the same properties.
	 */
	globalRules: Record<string, Record<string, string>>;
	globalRootVars: string[];
	cspicture: {
		exists: boolean;
		props: string[];
		supportsArtDirection: boolean;
	};
	/**
	 * The kit's own business data, if it ships any — social profiles and the
	 * like, which a stitch's social links should point at rather than a route
	 * invented from the link's label.
	 */
	businessData: {
		exists: boolean;
		exportName?: string | null;
		importPath?: string;
		socials: string[];
	};
	navScript: {
		exists: boolean;
		/** CodeStitch nav hooks the kit's sitewide script binds. */
		hooks: string[];
		fingerprint: string[];
	};
}

export const PROFILES: Record<KitId, KitProfile> = {
	i18n: advancedI18n as KitProfile,
	decap: intermediateDecap as KitProfile,
};

export function profileFor(kit: KitId): KitProfile {
	return PROFILES[kit];
}
