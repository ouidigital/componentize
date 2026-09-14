import type { Readiness, Warning, WarningSeverity } from "./types";

/**
 * Collects warnings during a conversion and folds them into the Ready/Draft verdict.
 *
 * The rule is deliberately blunt: any single "draft"-severity warning makes the
 * whole output Draft. Ready is a promise that the component builds when imported
 * into the pinned kit, so it may never be granted on a maybe.
 */
export class WarningCollector {
	private readonly items: Warning[] = [];

	add(severity: WarningSeverity, code: string, message: string): void {
		this.items.push({ severity, code, message });
	}

	/** Records a note that does not affect readiness. */
	info(code: string, message: string): void {
		this.add("info", code, message);
	}

	/** Records a reason the output is not drop-in Ready. */
	draft(code: string, message: string): void {
		this.add("draft", code, message);
	}

	get warnings(): Warning[] {
		return [...this.items];
	}

	has(code: string): boolean {
		return this.items.some((w) => w.code === code);
	}
}

export function evaluateReadiness(warnings: Warning[]): Readiness {
	const reasons = warnings
		.filter((w) => w.severity === "draft")
		.map((w) => w.message);

	return reasons.length > 0
		? { state: "draft", reasons }
		: { state: "ready", reasons: [] };
}

/** How the user is taking the result away. */
export type Delivery = "zip" | "component-only";

/**
 * Readiness for one particular delivery.
 *
 * A conversion's verdict describes the complete file set. Copying or downloading
 * just the .astro hands over less than that, so when companion files exist —
 * downloaded images, locale JSON, core styles — the single-file delivery is a
 * Draft no matter how clean the conversion was: the component imports files the
 * user does not have.
 */
export function readinessFor(
	result: { files: { path: string }[]; readiness: Readiness },
	delivery: Delivery,
): Readiness {
	if (delivery === "zip" || result.files.length <= 1) return result.readiness;

	const companions = result.files.slice(1).map((f) => f.path);
	const reason =
		`This component needs ${companions.length} more ${companions.length === 1 ? "file" : "files"} ` +
		`(${companions.slice(0, 3).join(", ")}${companions.length > 3 ? ", …" : ""}) — ` +
		"use Download ZIP, or the imports will not resolve.";

	return { state: "draft", reasons: [reason, ...result.readiness.reasons] };
}
