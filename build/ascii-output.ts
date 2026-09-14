import type { Plugin } from "vite";

/**
 * Escapes every non-ASCII character in emitted JS as `\uXXXX`.
 *
 * Chrome validates extension scripts with `base::IsStringUTF8()`, which rejects
 * Unicode *non-characters* such as U+FFFE — and acorn's identifier tables
 * contain one. A bundle carrying it fails to load with the rather misleading
 * "It isn't UTF-8 encoded", and the whole extension is silently dropped.
 *
 * `\uXXXX` escapes are valid inside strings, template literals, regex literals
 * and identifiers alike, so the escaped output is equivalent.
 */
export function asciiOutput(): Plugin {
	return {
		name: "componentize:ascii-output",
		apply: "build",
		enforce: "post",
		generateBundle(_options, bundle) {
			for (const file of Object.values(bundle)) {
				if (file.type !== "chunk") continue;
				file.code = escapeNonAscii(file.code);
			}
		},
	};
}

export function escapeNonAscii(code: string): string {
	let out = "";
	for (const char of code) {
		const cp = char.codePointAt(0)!;
		if (cp <= 0x7f) {
			out += char;
		} else if (cp <= 0xffff) {
			out += `\\u${cp.toString(16).padStart(4, "0")}`;
		} else {
			// Astral plane: emit the surrogate pair, which is what the source held.
			for (let i = 0; i < char.length; i++) {
				out += `\\u${char.charCodeAt(i).toString(16).padStart(4, "0")}`;
			}
		}
	}
	return out;
}
