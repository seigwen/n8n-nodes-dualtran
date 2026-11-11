/**
 * payload.mjs — entry point for the conformance gate (conformance.json → payload).
 *
 * `.conformance-kit/run.mjs` runs this file as `payloadCommand` from the repo
 * root and parses stdout as the payload JSON; the test suite imports the same
 * `buildPayload()` and validates it in-process. Both paths land here so the gate
 * always sees the live node, never a copy.
 *
 * This file only arranges a runtime able to import ./payload.ts (the node
 * source, the catalogue and the reasoning resolver):
 *
 *   1. Node < 23.6 needs `--experimental-strip-types`.
 *   2. n8n-workflow's ESM build is bundler-style (extensionless + directory
 *      imports), so preload ts-loader.cjs: its in-process resolve hook fills
 *      exactly those gaps. `node -r` keeps the hook on the main thread.
 *   3. The runtime re-runs this same file as a child (CONFORMANCE_TS_RUNTIME=1)
 *      and, as a script, prints the payload on stdout.
 *
 * The repo root is found from the module path (this file lives at
 * <root>/scripts/conformance/payload.mjs), never from the shell's cwd.
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HOST_ROOT = path.resolve(HERE, '../..');
const LOADER = path.join(HERE, 'ts-loader.cjs');
const CHILD_ENV = 'CONFORMANCE_TS_RUNTIME';
const inRuntime = process.env[CHILD_ENV] === '1';

/** The payload module, loaded lazily so the parent process never imports .ts. */
async function payloadModule() {
	return import(pathToFileURL(path.join(HERE, 'payload.ts')).href);
}

if (!inRuntime) {
	const strip = process.features?.typescript
		? []
		: ['--experimental-strip-types', '--disable-warning=ExperimentalWarning'];
	const child = spawnSync(
		process.execPath,
		[...strip, '-r', LOADER, fileURLToPath(import.meta.url), ...process.argv.slice(2)],
		{ encoding: 'utf8', cwd: HOST_ROOT, env: { ...process.env, [CHILD_ENV]: '1' } },
	);
	process.stdout.write(child.stdout ?? '');
	process.stderr.write(child.stderr ?? '');
	if (child.error) process.stderr.write(`${child.error.message}\n`);
	process.exit(child.status ?? 1);
}

// Executed by the gate: stdout carries exactly one JSON document.
const payload = await payloadModule();
console.log(JSON.stringify(await payload.buildPayload()));

export const buildPayload = async () => (await payloadModule()).buildPayload();
export const readCatalog = async () => (await payloadModule()).readCatalog;
export const loadNode = async () => (await payloadModule()).loadNode;
export const SPEC_VERSION = '2.0.0';
export const HOST = 'n8n-nodes-dualtran';
export default buildPayload;
