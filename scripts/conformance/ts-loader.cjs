/**
 * ts-loader.cjs — CommonJS preload for the conformance gate (`node -r`).
 *
 * Two things the plain Node ESM resolver cannot do, and this hook fills in:
 *
 *  1. Our own TypeScript sources use extensionless imports (`./translate`), so
 *     `.ts` siblings are resolved and handed to Node's built-in type stripping.
 *  2. n8n-workflow's ESM build is bundler-style: extensionless deep imports
 *     (`./logger-proxy`, `lodash/isEqual`) and directory imports (`./errors`).
 *     They are retried as `.js` / `index.js`, as the bundler resolved them.
 *
 * Also redirected: @n8n/tournament's `import` condition points at unpublished
 * TS sources (`src/index.ts`); Node refuses to strip TS inside node_modules, so
 * the compiled CommonJS entry is used instead.
 *
 * Why not `module.register()`? A synchronous `node -r` preload keeps the hook in
 * the main thread, so only the exact gaps n8n leaves are patched. Nothing is
 * transpiled or written: the hook only rewrites specifiers.
 */
'use strict';

const { registerHooks } = require('node:module');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL, fileURLToPath } = require('node:url');

const TS = /\.(?:ts|mts)$/;
const HAS_EXTENSION = /\.(?:[cm]?jsx?|json|ts|mts|cts|node)$/;
const NODE_MODULES = /[\\/]node_modules[\\/]/;
/** Vendored ESM builds that leave extensionless imports behind. */
const VENDORED_ESM = /[\\/]node_modules[\\/].*[\\/](?:dist|esm)[\\/][^/]*\.js$/;

/** Packages whose `import` condition points at unpublished TS sources. */
const CJS_FALLBACK = { '@n8n/tournament': 'dist/index.js' };

function compiledEntry(specifier) {
	const entry = CJS_FALLBACK[specifier];
	if (!entry) return null;
	return path.resolve(__dirname, '../../node_modules', specifier, entry);
}

/** Filesystem path behind a resolved URL (null when it is not a file URL). */
function localPath(url) {
	if (!url || !url.startsWith('file:')) return null;
	try {
		return fileURLToPath(url);
	} catch {
		return null;
	}
}

registerHooks({
	resolve(specifier, context, nextResolve) {
		const fallback = compiledEntry(specifier);
		if (fallback && fs.existsSync(fallback)) {
			return nextResolve(pathToFileURL(fallback).href, context);
		}

		const relative = specifier.startsWith('.') || specifier.startsWith('/');
		if (HAS_EXTENSION.test(specifier)) {
			return nextResolve(specifier, context);
		}

		try {
			return nextResolve(specifier, context);
		} catch (error) {
			const vendoredParent = VENDORED_ESM.test(context.parentURL || '');
			// Vendored ESM: retry deep package ids as compiled files first.
			if (!relative && vendoredParent && error.code === 'ERR_MODULE_NOT_FOUND') {
				return nextResolve(`${specifier}.js`, context);
			}
			// Vendored JS: the compiled file. Our sources: the TypeScript sibling.
			const target = localPath(String(error?.url ?? ''));
			if (!target) throw error;
			const suffix = NODE_MODULES.test(target) ? '.js' : '.ts';
			if (error.code === 'ERR_UNSUPPORTED_DIR_IMPORT') {
				// `./errors` -> `./errors/index.js`.
				return nextResolve(`${target.replace(/\/$/, '')}/index.js`, context);
			}
			if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error;
			// Extensionless relative import of a non-TS file: `../../catalog.generated`.
			return nextResolve(fs.existsSync(`${target}.js`) ? `${target}.js` : `${target}${suffix}`, context);
		}
	},

	load(url, context, nextLoad) {
		const target = localPath(url);
		if (!target) return nextLoad(url, context);
		if (TS.test(target) && !NODE_MODULES.test(target)) {
			return nextLoad(url, { ...context, format: 'module-typescript' });
		}
		if (target.endsWith(path.join('@n8n', 'tournament', 'dist', 'index.js'))) {
			// Compiled CommonJS: hand Node the source with its real format.
			return { format: 'commonjs', source: fs.readFileSync(target, 'utf8'), shortCircuit: true };
		}
		return nextLoad(url, context);
	},
});
