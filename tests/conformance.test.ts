/**
 * Conformance gate (SPEC 2.1.0) — kit + conformance.json + payload + checks.
 *
 * The payload is generated from the LIVE node class (description.properties and
 * methods.loadOptions.getModels), validated with the shared kit exactly like
 * `npm run conformance` does, then checked against the product rules that the
 * generic validator cannot know (catalogue ↔ snapshot agreement, alias dedupe,
 * the reasoning resolution table).
 *
 * The kit modules ship as .mjs; vitest's CJS transform refuses `require()` of an
 * ES module inside node_modules, so they are imported through a real `import()`
 * evaluated at runtime. This mirrors `.conformance-kit/run.mjs` (see
 * scripts/conformance/run-conformance.mjs for the CLI path).
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { Dualtran } from '../nodes/Dualtran/Dualtran.node';
import { resolveReasoningDepth } from '../nodes/Dualtran/translate';

const ROOT = path.resolve(__dirname, '..');
const kitImport = (specifier: string) =>
	import(/* @vite-ignore */ pathToFileURL(path.resolve(ROOT, specifier)).href) as Promise<Record<string, any>>;

let kit: Record<string, any>;
let payload: any;
let config: any;
let checks: Array<{ name: string; ok: boolean }>;
let summary: any;

beforeAll(async () => {
	kit = {
		...(await kitImport('scripts/conformance/validate.mjs')),
		...(await kitImport('scripts/conformance/scan.mjs')),
	};
	const { buildPayload } = await kitImport('scripts/conformance/payload.ts');
	const { runConformance } = await kitImport('scripts/conformance/check.ts');
	config = JSON.parse(readFileSync(path.join(ROOT, 'conformance.json'), 'utf8'));
	payload = await buildPayload();
	payload.static = { ...(payload.static ?? {}), hits: kit.scanFiles(ROOT, config.static) };
	const outcome = runConformance(kit, payload, config);
	summary = outcome.summary;
	checks = outcome.checks;
});

describe('conformance payload', () => {
	it('is host-tagged and targets the current spec', () => {
		expect(config.host).toBe('n8n-nodes-dualtran');
		expect(payload.host).toBe('n8n-nodes-dualtran');
		expect(payload.spec).toBe(config.spec);
		expect(payload.spec).toBe(kit.SPEC_VERSION);
	});

	it('carries an explicit payloadCommand the kit can run', () => {
		expect(config.payloadCommand).toBe('node scripts/conformance/payload.mjs');
		expect(config.payload).toBeUndefined();
		// The command runs from the repo root the kit computes (the host repo).
		expect(config.payloadCommand).toMatch(/^node scripts\/conformance\/payload\.mjs$/);
	});

	it('declares the two platform limits (R2 snapshot, R5 node-UI i18n)', () => {
		const limits = config.platformLimits ?? [];
		const r2 = limits.find((limit: any) => limit.rule === 'R2');
		const r5 = limits.find((limit: any) => limit.rule === 'R5');
		expect(r2?.catalogue).toBe('static-snapshot');
		expect(r2?.refreshedAt).toBe('build');
		expect(r2?.snapshot).toBe('scripts/catalog-sources/models-dev-sample.json');
		expect(r5?.i18n).toBe('none');
		expect(r2?.note).toMatch(/no runtime catalogue fetch/i);
		expect(r5?.note).toMatch(/no node-UI i18n API/i);
	});

	it('keeps the banned tokens out of the node, the logic and the catalogue', () => {
		expect(payload.static.hits).toEqual([]);
	});
});

describe('product rules through the live node description', () => {
	it('R1: target and source language are pickers over the 44-name catalogue', () => {
		const node = new Dualtran();
		const properties = new Map(node.description.properties.map((entry) => [entry.name, entry]));
		const target = properties.get('targetLanguage') as any;
		const source = properties.get('sourceLanguage') as any;
		expect(target.type).toBe('options');
		expect(source.type).toBe('options');
		expect(target.options).toHaveLength(44);
		expect(target.options.length).toBeGreaterThanOrEqual(38);
		expect(target.options[0]).toMatchObject({ name: 'Afrikaans', value: 'af' });
		expect(target.options.some((option: any) => option.value === 'auto')).toBe(false);
		// Labels are human-readable, never the raw code.
		expect(target.options.filter((option: any) => option.name !== option.value)).toHaveLength(44);
		// Auto is a source-language concept.
		expect(source.options[0]).toMatchObject({ name: 'Auto (Detect)', value: 'auto' });
		expect(source.options).toHaveLength(45);
		expect(source.default).toBe('auto');
	});

	it('R2: one alphabetical provider list, custom last, snapshot merged', () => {
		expect(summary.providers).toBeGreaterThanOrEqual(5);
		expect(checks.every((check) => check.ok)).toBe(true);
		const options = payload.provider.options;
		const last = options[options.length - 1];
		expect(last.source).toBe('custom');
		expect(last.label).toBe('Custom…');
		const sorted = [...options.filter((option: any) => option.source !== 'custom')].map(
			(option: any) => option.label,
		);
		const compare = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });
		expect(sorted).toEqual([...sorted].sort((a, b) => compare.compare(a, b)));
		expect(options.some((option: any) => option.source === 'built-in')).toBe(true);
		expect(options.some((option: any) => option.source === 'models.dev')).toBe(true);
		expect(options.some((option: any) => option.disabled)).toBe(false);
	});

	it('R2: the model picker loads per provider through methods.loadOptions', async () => {
		const node = new Dualtran();
		const loadOptions = node.methods.loadOptions.getModels as any;
		expect(typeof loadOptions).toBe('function');
		const aiModel = node.description.properties.find((entry) => entry.name === 'aiModel') as any;
		expect(aiModel.typeOptions.loadOptionsMethod).toBe('getModels');
		expect(payload.model.loadOptionsMethod).toBe('getModels');

		const context = { getNodeParameter: () => 'openai' };
		const models = await loadOptions.call(context);
		expect(models[0]).toMatchObject({ name: 'Daybreak Red', value: 'gpt-daybreak-red-latest' });
		expect(models[models.length - 1]).toMatchObject({ name: 'Custom model…' });
		expect(models).toHaveLength(13);
		expect(models.some((entry: any) => entry.name === 'GPT-4o')).toBe(true);
	});

	it('R3: endpoint is a string, empty by default, filled from the provider API', () => {
		const node = new Dualtran();
		const endpoint = node.description.properties.find((entry) => entry.name === 'endpoint') as any;
		expect(endpoint.type).toBe('string');
		expect(endpoint.default).toBe('');
		expect(payload.endpoint.autofill.after).toMatch(/^https?:\/\//);
		expect(payload.endpoint.autofill.after).toBe(payload.endpoint.autofill.providerApi);
	});

	it('R4: reasoning is a picker defaulting to lowest, resolved per model', () => {
		const node = new Dualtran();
		const reasoning = node.description.properties.find((entry) => entry.name === 'reasoning') as any;
		expect(reasoning.type).toBe('options');
		expect(reasoning.default).toBe('lowest');
		// Alphabetical (n8n lint), with the sentinel present exactly once.
		expect((reasoning.options as any[]).map((option) => option.name)).toEqual([
			'Extra High',
			'High',
			'Low',
			'Lowest',
			'Max',
			'Medium',
			'Minimal',
			'None',
		]);
		expect((reasoning.options as any[]).filter((option) => option.value === 'lowest')).toHaveLength(1);
	});

	it('R4: lowest resolves none → minimal → low and omits when nothing is declared', () => {
		expect(resolveReasoningDepth({ depth: 'lowest', reasoningOptions: ['none', 'low', 'high'] })).toBe('none');
		expect(resolveReasoningDepth({ depth: 'lowest', reasoningOptions: ['minimal', 'low'] })).toBe('minimal');
		expect(resolveReasoningDepth({ depth: 'lowest', reasoningOptions: ['low', 'medium'] })).toBe('low');
		expect(resolveReasoningDepth({ depth: 'lowest', reasoningOptions: [] })).toBe('');
		expect(resolveReasoningDepth({ depth: 'lowest', reasoningOptions: undefined })).toBe('');
		// Resolved from the snapshot, not from a hand-written table.
		for (const [kind, cases] of Object.entries(payload.reasoning.resolved) as Array<[string, any[]]>) {
			const expected = { none: 'none', minimal: 'minimal', low: 'low', 'none-declared': '' }[kind];
			expect(cases.length).toBeGreaterThan(0);
			for (const entry of cases) expect(entry.value).toBe(expected);
		}
	});

	it('R5: no node-UI i18n — every string is a description field', () => {
		expect(payload.i18n.locales).toHaveLength(44);
		expect(payload.i18n.keys.length).toBeGreaterThan(0);
		expect(payload.i18n.keys).toEqual(payload.i18n.used);
		const node = new Dualtran();
		const declared = node.description.properties
			.flatMap((entry: any) => [entry.displayName, entry.description, entry.placeholder])
			.filter((value: unknown): value is string => typeof value === 'string' && value.trim() !== '');
		expect(new Set(declared).size).toBe(declared.length);
	});
});

describe('SPEC 2.1: the empty provider state', () => {
	it('a fresh install defaults to no provider and no OpenAI fallback', () => {
		const node = new Dualtran();
		const aiProvider = node.description.properties.find((entry) => entry.name === 'aiProvider') as any;
		expect(aiProvider.default).toBe('');
		expect(payload.provider.current).toBe('');
		expect(payload.provider.fallback).toBe('');
		expect(payload['unconfigured'].provider.fallback).toBe('');
	});

	it('exposes the placeholder as provider.placeholder, never as a real option', () => {
		expect(payload.provider.placeholder).toEqual({
			value: '',
			label: 'Select a provider',
			disabled: true,
			selected: true,
		});
		expect(payload.provider.options.some((option: any) => option.value === '')).toBe(false);
		expect(payload.provider.options.some((option: any) => option.disabled)).toBe(false);
		// The placeholder is not sorted into the list: real providers stay alphabetical and
		// custom last, exactly as in the configured section.
		expect(payload.provider.options.filter((option: any) => option.source !== 'custom').map((option: any) => option.label)).toEqual(
			payload['configured'].provider.options.filter((option: any) => option.source !== 'custom').map((option: any) => option.label),
		);
		expect(payload.provider.options[payload.provider.options.length - 1].source).toBe('custom');
		const node = new Dualtran();
		const providerOptions = (node.description.properties.find((entry) => entry.name === 'aiProvider') as any).options as any[];
		// The n8n options array does carry the placeholder — at the head, disabled, value "".
		expect(providerOptions[0]).toMatchObject({ name: 'Select a provider', value: '', disabled: true });
	});

	it('disables the model and reasoning pickers but keeps the lowest sentinel', () => {
		const unconfigured = payload['unconfigured'];
		expect(unconfigured.model).toMatchObject({
			disabled: true,
			selectedProvider: '',
			selectedModel: '',
			options: [],
		});
		// The per-provider model lists are still loaded (the picker simply is not shown).
		expect(Object.keys(payload.model.byProvider).length).toBeGreaterThan(0);
		expect(Object.keys(payload.model.loadOptions).length).toBeGreaterThan(0);
		expect(unconfigured.model.label).toBe('Select a provider first');
		expect(unconfigured.reasoning.disabled).toBe(true);
		expect(unconfigured.reasoning.default).toBe('lowest');
		expect(unconfigured.reasoning.value).toBe('lowest');
	});

	it('keeps the endpoint empty with the bare https:// placeholder', () => {
		const endpoint = payload['unconfigured'].endpoint;
		expect(endpoint.current).toBe('');
		expect(endpoint.placeholder).toBe('https://');
		expect(endpoint.autofill).toMatchObject({
			before: '',
			after: 'https://api.anthropic.com/v1',
			providerApi: 'https://api.anthropic.com/v1',
			userEdited: 'https://proxy.example/v1',
			afterSwitch: 'https://proxy.example/v1',
		});
	});

	it('the empty state carries no OpenAI endpoint, model or provider', () => {
		const unconfigured = payload['unconfigured'];
		expect(unconfigured.endpoint.current).not.toContain('api.openai.com');
		expect(unconfigured.endpoint.autofill.after).not.toContain('api.openai.com');
		expect(unconfigured.model.options).toEqual([]);
		expect(unconfigured.model.selectedModel).toBe('');
		expect(unconfigured.provider.current).toBe('');
		// The provider picker still offers OpenAI as a choice — it is just not preselectable
		// through an empty default; only the *empty state* is free of it.
		expect(JSON.stringify({ provider: unconfigured.provider.current, model: unconfigured.model.selectedModel, endpoint: unconfigured.endpoint.current, fallback: unconfigured.provider.fallback })).not.toContain('openai');
	});

	it('the configured state enables the pickers and fills the endpoint', () => {
		const configured = payload['configured'];
		expect(configured.provider.current).toBe('anthropic');
		expect(configured.provider.placeholder.selected).toBe(false);
		expect(configured.provider.fallback).toBe('anthropic');
		expect(configured.model.disabled).toBe(false);
		expect(configured.model.selectedProvider).toBe('anthropic');
		expect(configured.endpoint.current).toBe('https://api.anthropic.com/v1');
		expect(configured.reasoning.disabled).toBe(false);
	});

	it('R5: the three new strings are English literals, declared as one key set', () => {
		const node = new Dualtran();
		const declared = new Set(
			node.description.properties
				.flatMap((entry: any) => [entry.displayName, entry.description, entry.placeholder])
				.filter((value: unknown): value is string => typeof value === 'string' && value.trim() !== ''),
		);
		// The three keys name the literal each one resolves to (English-only, no
		// per-locale node files): the map is declared once for the whole key set.
		expect(payload.i18n.specKeys).toEqual({
			providerPlaceholder: 'Select a provider',
			providerRequiredForModel: 'Select a provider first',
			providerRequiredError: 'Choose an AI provider in settings before translating.',
		});
		for (const [key, literal] of Object.entries(payload.i18n.specKeys as Record<string, string>)) {
			expect(key).toMatch(/^provider/);
			// Each literal is a real field the editor renders.
			expect(declared.has(literal)).toBe(true);
			expect(payload.i18n.keys).toContain(literal);
			expect(payload.i18n.used).toContain(literal);
		}
		const limit = (config.platformLimits ?? []).find((entry: any) => entry.rule === 'R5');
		expect(limit?.i18n).toBe('none');
		expect(limit?.note).toMatch(/no node-UI i18n API/i);
		expect(limit?.englishLiterals).toEqual({
			providerPlaceholder: 'Select a provider',
			providerRequiredForModel: 'Select a provider first',
			providerRequiredError: 'Choose an AI provider in settings before translating.',
		});
	});

	it('no request path falls back to openai or the custom provider', () => {
		for (const relative of ['nodes/Dualtran/Dualtran.node.ts', 'nodes/Dualtran/translate.ts']) {
			const source = readFileSync(path.join(ROOT, relative), 'utf8');
			expect(source).not.toMatch(/\|\|\s*['"]openai['"]/);
			expect(source).not.toMatch(/\|\|\s*CUSTOM_PROVIDER/);
			expect(source).not.toMatch(/\?\?\s*['"]openai['"]/);
		}
	});
});

describe('backwards compatibility', () => {
	it('keeps the credential provider/model fields as deprecated fallbacks', () => {
		const source = readFileSync(path.join(ROOT, 'credentials/DualTranApi.credentials.ts'), 'utf8');
		expect(source).toContain("name = 'dualtranApi'");
		for (const field of ['apiKey', 'baseURL', 'provider', 'model']) {
			expect(source).toContain(`name: '${field}'`);
		}
		expect(source.match(/DEPRECATED/g)).toHaveLength(2);
		// SPEC 2.1 rule 5: the deprecated provider field carries no OpenAI preset
		// and is never a fallback for an unconfigured node.
		expect(source).not.toMatch(/default:\s*'openai'/);
		expect(source).not.toMatch(/only used when the node provider is empty/);
	});
});
