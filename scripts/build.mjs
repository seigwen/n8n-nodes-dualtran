#!/usr/bin/env node
/**
 * build.mjs — bundle the node + credential into dist/ (esbuild).
 *
 * The community-node ruleset (and n8n Cloud's shared runtime) require an EMPTY
 * runtime dependency set: everything — including the bundled @dualtran/core
 * and its AI SDK externals — is inlined here, so the installed package pulls
 * nothing at runtime. n8n-workflow stays external (n8n provides it).
 */
import esbuild from 'esbuild';
import fs from 'node:fs';

const watch = process.argv.includes('--watch');

// Start clean: a leftover tsc dist would otherwise ride along into the tarball.
if (!watch) {
	fs.rmSync('dist', { recursive: true, force: true });
}

/** @type {import('esbuild').BuildOptions} */
const options = {
	entryPoints: ['nodes/Dualtran/Dualtran.node.ts', 'credentials/DualTranApi.credentials.ts'],
	outbase: '.',
	outdir: 'dist',
	bundle: true,
	format: 'cjs',
	platform: 'node',
	target: 'node18',
	external: ['n8n-workflow'],
	minify: true,
	sourcemap: false,
	logLevel: 'info',
};

if (watch) {
	const ctx = await esbuild.context(options);
	await ctx.watch();
	console.log('[build] watching…');
} else {
	await esbuild.build(options);
	console.log('[build] dist/ ready');
}
