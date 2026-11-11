/**
 * Conformance RED snapshot — SPEC 2.0.0.
 *
 * Historical evidence tool: it was written BEFORE the node implementation and its
 * per-rule probes stub the other sections, so it reports "RED" even now. It is
 * kept only to reproduce evidence/red.txt; the authoritative gate is
 * `npm run conformance:local` (scripts/conformance/run-conformance.mjs) and the
 * canonical kit (`npm run conformance`).
 *
 *   node scripts/conformance/red.mjs   # historical, always RED
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readFileSync } from 'node:fs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');
const RUNTIME_ENV = 'CONFORMANCE_RED_RUNTIME';

// Type stripping + the n8n ESM quirk fixes live in ts-loader.cjs: run there.
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

const { SPEC_VERSION, selfTest, validatePayload } = await import(
	pathToFileURL(path.join(ROOT, '.conformance-kit/validate.mjs')).href
);
const { loadNode } = await import(pathToFileURL(path.join(HERE, 'payload.ts')).href);

const config = JSON.parse(readFileSync(path.join(ROOT, 'conformance.json'), 'utf8'));
const log = (line = '') => console.log(line);

const node = await loadNode();
const description = node.description;
const byName = new Map((description.properties ?? []).map((property) => [property.name, property]));

const current = {
	targetLanguage: byName.get('targetLanguage'),
	sourceLanguage: byName.get('sourceLanguage'),
	aiProvider: byName.get('aiProvider'),
	aiModel: byName.get('aiModel'),
	endpoint: byName.get('endpoint'),
	reasoning: byName.get('reasoning'),
};
const picker = (property) => (property?.type === 'options' ? 'select' : (property?.type ?? 'MISSING'));
const optionsOf = (property) =>
	(property?.options ?? []).map((option) => ({ value: option.value, label: option.name }));

/** A payload with one section taken from the node and the others stubbed valid. */
function payloadFor(rule) {
	const valid = {
		language: {
			control: 'select',
			current: 'l0',
			options: Array.from({ length: 38 }, (_, i) => ({ value: `l${i}`, label: `Language ${i}` })),
			source: { control: 'select', options: [{ value: 'auto', label: 'Auto (detect)' }] },
		},
		provider: {
			control: 'select',
			current: 'openai',
			options: [
				{ value: 'anthropic', label: 'Anthropic', source: 'built-in' },
				{ value: 'cerebras', label: 'Cerebras', source: 'built-in' },
				{ value: 'cohere', label: 'Cohere', source: 'built-in' },
				{ value: 'deepseek', label: 'DeepSeek', source: 'built-in' },
				{ value: 'groq', label: 'Groq', source: 'built-in' },
				{ value: 'snapshot', label: 'Snapshot', source: 'models.dev' },
			],
		},
		model: {
			control: 'select',
			loadOptionsMethod: 'getModels',
			byProvider: {
				anthropic: [{ value: 'claude', label: 'Claude' }],
				cerebras: [{ value: 'llama', label: 'Llama' }],
				cohere: [{ value: 'command', label: 'Command' }],
				deepseek: [{ value: 'deepseek-chat', label: 'DeepSeek Chat' }],
				groq: [{ value: 'mixtral', label: 'Mixtral' }],
				snapshot: [{ value: 'm', label: 'M' }],
			},
			selectedProvider: 'anthropic',
			selectedModel: 'claude',
		},
		endpoint: {
			control: 'text',
			default: '',
			autofill: {
				provider: 'anthropic',
				providerApi: 'https://api.anthropic.com/v1',
				before: '',
				after: 'https://api.anthropic.com/v1',
				userEdited: 'https://proxy.example/v1',
				afterSwitch: 'https://proxy.example/v1',
			},
		},
		reasoning: {
			control: 'select',
			default: 'lowest',
			options: [{ value: 'lowest', label: 'Lowest' }],
			resolved: {
				none: [{ value: 'none' }],
				minimal: [{ value: 'minimal' }],
				low: [{ value: 'low' }],
				'none-declared': [{ value: '' }],
			},
		},
		i18n: { locales: ['en'], keys: ['k'], used: ['k'] },
	};

	const payload = {
		spec: SPEC_VERSION,
		host: config.host,
		language: structuredClone(valid.language),
		provider: structuredClone(valid.provider),
		model: structuredClone(valid.model),
		endpoint: structuredClone(valid.endpoint),
		reasoning: structuredClone(valid.reasoning),
		i18n: structuredClone(valid.i18n),
		static: { hits: [] },
	};

	// Live surface for the section under test (empty options when undeclared).
	if (rule === 'R1') {
		payload.language = {
			control: picker(current.targetLanguage),
			current: current.targetLanguage?.default ?? '',
			options: optionsOf(current.targetLanguage),
			source: {
				control: picker(current.sourceLanguage),
				options: optionsOf(current.sourceLanguage),
			},
		};
	}
	if (rule === 'R2') {
		payload.provider = {
			control: picker(current.aiProvider),
			current: current.aiProvider?.default ?? '',
			options: optionsOf(current.aiProvider),
		};
		payload.model = {
			control: picker(current.aiModel),
			loadOptionsMethod: current.aiModel?.typeOptions?.loadOptionsMethod ?? '',
			byProvider: {},
		};
	}
	if (rule === 'R3') {
		const endpoint = current.endpoint;
		payload.endpoint = {
			control: endpoint?.type === 'string' ? 'text' : picker(endpoint),
			default: endpoint?.default ?? '',
			autofill: { provider: 'anthropic', providerApi: '', before: '', after: '', userEdited: '', afterSwitch: '' },
		};
	}
	if (rule === 'R4') {
		payload.reasoning = {
			control: picker(current.reasoning),
			default: current.reasoning?.default ?? '',
			options: optionsOf(current.reasoning),
			resolved: { none: [{ value: '' }], minimal: [{ value: '' }], low: [{ value: '' }], 'none-declared': [{ value: '' }] },
		};
	}
	if (rule === 'R5') {
		payload.i18n = { locales: [], keys: [], used: [] };
	}
	return payload;
}

log(`conformance RED snapshot — spec ${SPEC_VERSION}, host ${config.host}`);
log('(historical: written against the pre-implementation node; see evidence/red.txt)');
log(`node: ${description.name} v${description.version} (${description.properties?.length ?? 0} properties)`);
log();

try {
	log(`self-test: ${selfTest()} negative controls caught`);
} catch (error) {
	log(`self-test FAILED: ${error.message}`);
	process.exitCode = 1;
}

log();
log('contract surface as currently declared:');
for (const [name, property] of Object.entries(current)) {
	const detail = property ? `${JSON.stringify(property.type)} default=${JSON.stringify(property.default)}${property.options ? ` options=${property.options.length}` : ''}` : 'MISSING';
	log(`  ${name.padEnd(15)} ${detail}`);
}

log();
log(`rule-by-rule (shared kit validator, SPEC ${SPEC_VERSION}):`);
const failures = [];
for (const rule of ['R1', 'R2', 'R3', 'R4', 'R5']) {
	try {
		validatePayload(payloadFor(rule), config);
		log(`  ${rule}: PASS`);
	} catch (error) {
		failures.push(rule);
		log(`  ${rule}: FAIL — ${error.message}`);
	}
}

log();
log(
	failures.length
		? `result: RED — ${failures.length}/5 rules unmet (${failures.join(', ')}) on the live node description`
		: 'result: GREEN — the live node description satisfies the contract',
);
if (failures.length) process.exitCode = 1;
