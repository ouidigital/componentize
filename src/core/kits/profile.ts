import type { KitId } from "../types";

/** The kit shapes the generator knows how to target. */
export type KitGeneration = "legacy-i18n" | "advanced-v4" | "decap";

/** A built-in feature a project can remove, taking its pages with it. */
export type OptionalFeature = "demo" | "CMS";

export interface LocaleRoute {
	/** The path as the default locale writes it, e.g. "/projects/project-1". */
	defaultPath: string;
	/** The same page in this locale, e.g. "/projets/projet-1". */
	localizedPath: string;
}
import advancedI18n from "./profiles/advanced-i18n.json" with { type: "json" };
import advancedV4 from "./profiles/advanced-v4.json" with { type: "json" };
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
	kitVersion: string | null;
	astroVersion: string | null;
	configPath: string;
	/** Which shape of kit this is; the generators differ, the ids do not. */
	generation: KitGeneration;
	/**
	 * The kit's effective whitespace handling. Astro 7 defaults to "jsx", which
	 * drops whitespace containing a newline; `true` collapses it to one space.
	 */
	compressHTML: boolean | "jsx";
	prefixDefaultLocale: boolean;
	hasLess: boolean;
	hasSass: boolean;
	aliases: string[];
	/** Locales configured in the pinned kit; required — cannot be removed. */
	locales: string[];
	defaultLocale: string | null;
	/** Locale JSON basenames already owned by the kit's content loader. */
	namespaceFiles: string[];
	/**
	 * Per-locale route paths, indexed by the default locale's path — the key a
	 * generated component looks a destination up by in the project's navData.
	 */
	localeRoutes: Record<string, LocaleRoute[]>;
	/** Destinations that exist only while a removable feature is still installed. */
	optionalRoutes: Record<string, OptionalFeature>;
	/** Astro's configured default image layout, or null when the config omits it. */
	imageLayout: "constrained" | "full-width" | "fixed" | "none" | null;
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
	"advanced-v4": advancedV4 as KitProfile,
	decap: intermediateDecap as KitProfile,
};

export function profileFor(kit: KitId): KitProfile {
	return PROFILES[kit];
}
