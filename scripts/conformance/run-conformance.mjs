/**
 * run-conformance.mjs — the conformance gate, run in one process.
 *
 * The shared kit (`.conformance-kit`) is the authority: negative controls, the
 * host payload, the banned-token scan and the SPEC validator. `npm run
 * conformance` runs its `run.mjs`, which shells out to `payloadCommand`; this
 * script is the same pipeline over the in-process payload (payload.ts reads the
 * live node description), so it can run before/after evidence and from tests
 * without depending on how the shell resolves the kit path.
 *
 *   node scripts/conformance/run-conformance.mjs
 *   npm run conformance:local
 *
 * Exit code 0 = PASS.
 */
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readFileSync } from 'node:fs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');
const RUNTIME_ENV = 'CONFORMANCE_LOCAL_RUNTIME';

if (process.env[RUNTIME_ENV] !== '1') {
	const strip = process.features?.typescript
		? []
		: ['--experimental-strip-types', '--disable-warning=ExperimentalWarning'];
	const child = spawnSync(
		process.execPath,
		[...strip, '-r', path.join(HERE, 'ts-loader.cjs'), fileURLToPath(import.meta.url)],
		{ encoding: 'utf8', cwd: ROOT, env: { ...process.env, [RUNTIME_ENV]: '1' } },
	);
	process.stdout.write(child.stdout ?? '');
	process.stderr.write(child.stderr ?? '');
	if (child.error) process.stderr.write(`${child.error.message}\n`);
	process.exit(child.status ?? 1);
}

const kit = {
	...(await import(pathToFileURL(path.join(ROOT, '.conformance-kit/validate.mjs')).href)),
	...(await import(pathToFileURL(path.join(ROOT, '.conformance-kit/scan.mjs')).href)),
};
const { buildPayload } = await import(pathToFileURL(path.join(HERE, 'payload.ts')).href);
const { runConformance } = await import(pathToFileURL(path.join(HERE, 'check.ts')).href);

const config = JSON.parse(readFileSync(path.join(ROOT, 'conformance.json'), 'utf8'));

// Parity guard: the canonical kit spawns this file as its payloadCommand and
// parses stdout as JSON (`.conformance-kit/run.mjs`); keep that contract exact.
if (process.env.CONFORMANCE_PAYLOAD_ONLY === '1') {
	process.stdout.write(JSON.stringify(await buildPayload()));
	process.exit(0);
}

try {
	console.log(`self-test: ${kit.selfTest()} negative controls caught`);
	const payload = await buildPayload();
	payload.static = { ...(payload.static ?? {}), hits: kit.scanFiles(ROOT, config.static) };
	payload.conformance = config;
	const { summary, checks } = runConformance(kit, payload, config);
	for (const check of checks) console.log(`  ok   ${check.name}`);
	console.log(
		`PASS ${summary.host}: ${summary.languages} languages, ${summary.providers} providers, ` +
			`${Object.keys(payload.model?.loadOptions ?? {}).length} model lists, ` +
			`${checks.length + 1} checks (spec ${summary.spec})`,
	);
} catch (error) {
	console.error(error.message);
	if (error.detail) console.error(JSON.stringify(error.detail));
	process.exit(1);
}
