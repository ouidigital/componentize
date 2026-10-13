export interface Code { typeName: string; type: string; isDark?: boolean | null; content: string }
export function extractGetCode(html: string): { stitch: { codes: Code[]; [key: string]: unknown } } | undefined;
export const VARIANTS: readonly string[];
export function variantFor(typeName: string): string | undefined;
export function lf(text: string): string;
export function codeFiles(codes: Code[]): Record<string, string>;
