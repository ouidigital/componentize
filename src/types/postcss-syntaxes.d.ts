/** postcss-less ships no type declarations. */
declare module "postcss-less" {
	import type { Parser, Stringifier } from "postcss";
	const syntax: { parse: Parser; stringify: Stringifier };
	export default syntax;
}
