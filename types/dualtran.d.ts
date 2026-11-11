/**
 * @dualtran/core ships no type declarations yet (follow-up in the core repo).
 * The node imports the namespace and documents the shapes it uses in
 * nodes/Dualtran/translate.ts.
 */
declare module 'dualtran';

/**
 * catalog.json is generated at build time by scripts/gen-catalog.mjs, which
 * also writes this CommonJS shim so tsc has a stable `require` shape
 * (resolveJsonModule would otherwise widen every option array).
 */
declare module '*/catalog.generated' {
	const catalog: Record<string, unknown>;
	export = catalog;
}
