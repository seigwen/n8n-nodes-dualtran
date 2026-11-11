/**
 * Conformance payload for n8n-nodes-dualtran (SPEC 2.0.0).
 *
 * Reads the node's REAL settings surface — `description.properties` of the
 * Dualtran node class plus the catalogue the pickers are generated from — and
 * emits the shared JSON contract. Nothing is invented here: every option in the
 * payload is an array n8n actually renders.
 *
 *   node scripts/conformance/payload.mjs   # prints the payload
 *
 * TypeScript (not .mjs) so it can import the node source, the catalogue and the
 * reasoning resolver directly; payload.mjs arranges the runtime (type stripping
 * + n8n-workflow's bundler-style ESM) and `.conformance-kit/run.mjs` adds the
 * static scan before validation.
 */
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const SPEC_VERSION = '2.0.0';
export const HOST = 'n8n-nodes-dualtran';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

interface CatalogModel {
	id: string;
	label: string;
	reasoning?: string[];
}
interface CatalogProvider {
	id: string;
	name: string;
	api: string;
	builtIn: boolean;
	models: CatalogModel[];
}
interface Catalog {
	providers: CatalogProvider[];
	languages: Array<{ id: string; label: string }>;
}

const collator = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });
const labelOf = (option: { name?: string; label?: string; value?: string }): string =>
	String(option?.name ?? option?.label ?? option?.value ?? '').trim();
const valueOf = (option: { value?: string; id?: string }): string =>
	String(option?.value ?? option?.id ?? '').trim();

/** The runtime catalogue the node imports (catalog.generated.js → catalog.json). */
export function readCatalog(): Catalog {
	return require(path.join(ROOT, 'catalog.generated.js')) as Catalog;
}

/** Load the node class from source so the payload is never a copy of it. */
export async function loadNode(): Promise<{ description: any; methods?: any }> {
	const module = await import(pathToFileURL(path.join(ROOT, 'nodes/Dualtran/Dualtran.node.ts')).href);
	const NodeClass = module.Dualtran ?? module.default?.Dualtran ?? module.default;
	if (!NodeClass) throw new Error('cannot load nodes/Dualtran/Dualtran.node.ts');
	return new NodeClass();
}
function propertyMap(description: { properties?: any[] }): Map<string, any> {
	return new Map((description.properties ?? []).map((property: any) => [property.name, property]));
}

function must(properties: Map<string, any>, name: string): any {
	const property = properties.get(name);
	if (!property) throw new Error(`the node description has no "${name}" property`);
	return property;
}

/** n8n option (`name`) → contract option (`label`). */
const asOption = (option: any) => ({ value: valueOf(option), label: labelOf(option) });
const controlOf = (property: any, picker: string, text: string): string =>
	property.type === 'options' ? picker : property.type === 'string' ? text : String(property.type);

export async function buildPayload(): Promise<any> {
	const node = await loadNode();
	const description = node.description;
	const properties = propertyMap(description);
	const catalog = readCatalog();
	const providers = catalog.providers ?? [];

	// ── R1: target/source language pickers ──────────────────────────────────
	const targetProperty = must(properties, 'targetLanguage');
	const sourceProperty = must(properties, 'sourceLanguage');
	const language = {
		control: controlOf(targetProperty, 'select', 'text'),
		current: String(targetProperty.default ?? ''),
		options: (targetProperty.options ?? []).map(asOption),
		catalogSize: (catalog.languages ?? []).length,
		source: {
			control: controlOf(sourceProperty, 'select', 'text'),
			current: String(sourceProperty.default ?? ''),
			options: (sourceProperty.options ?? []).map(asOption),
		},
	};

	// ── R2: one alphabetical provider list + per-provider model lists ───────
	const providerProperty = must(properties, 'aiProvider');
	const providerOptions = (providerProperty.options ?? []).map((option: any) => ({
		...asOption(option),
		source: /^custom/i.test(valueOf(option)) ? 'custom' : option.builtIn ? 'built-in' : 'models.dev',
	}));

	const modelProperty = must(properties, 'aiModel');
	const byProvider: Record<string, Array<{ value: string; label: string }>> = {};
	for (const provider of providers) {
		byProvider[provider.id] = (provider.models ?? []).map((model) => ({
			value: model.id,
			label: model.label,
		}));
	}

	// The options `methods.loadOptions.getModels` really returns, per provider.
	const loadOptionsMethod = modelProperty.typeOptions?.loadOptionsMethod ?? '';
	const loadOptions: Record<string, Array<{ value: string; label: string }>> = {};
	if (typeof node.methods?.loadOptions?.[loadOptionsMethod] === 'function') {
		for (const provider of providers) {
			const context = {
				getNodeParameter: (name: string) => (name === 'aiProvider' ? provider.id : ''),
			};
			const options = await node.methods.loadOptions[loadOptionsMethod].call(context);
			loadOptions[provider.id] = (options ?? []).map(asOption);
		}
	}

	const model = {
		control: controlOf(modelProperty, 'select', 'text'),
		loadOptionsMethod,
		byProvider,
		loadOptions,
		selectedProvider: String(providerProperty.default ?? ''),
		selectedModel: String(modelProperty.default ?? ''),
		catalogProviders: providers.map((provider) => provider.id),
	};

	// ── R3: endpoint stays a text field, autofilled at execution ────────────
	const endpointProperty = must(properties, 'endpoint');
	const endpointDefault = String(endpointProperty.default ?? '');
	/** The node's fill rule: node endpoint || credential baseURL || provider api. */
	const fill = (providerId: string, userEndpoint = ''): string => {
		const provider = providers.find((entry) => entry.id === providerId);
		return String(userEndpoint || provider?.api || '');
	};
	const autofillProvider = providers[0]?.id ?? 'openai';
	const endpoint = {
		control: controlOf(endpointProperty, 'select', 'text'),
		default: endpointDefault,
		autofill: {
			provider: autofillProvider,
			providerApi: fill(autofillProvider),
			before: endpointDefault,
			after: fill(autofillProvider, endpointDefault),
			userEdited: 'https://proxy.example/v1',
			afterSwitch: fill(providers[1]?.id ?? autofillProvider, 'https://proxy.example/v1'),
		},
	};

	// ── R4: reasoning picker, `lowest` sentinel, resolved per declaration ──
	const reasoningProperty = must(properties, 'reasoning');
	const { resolveReasoningDepth } = await import(
		pathToFileURL(path.join(ROOT, 'nodes/Dualtran/translate.ts')).href
	);
	const defaultReasoning = String(reasoningProperty.default ?? '');
	const sample = (providerId: string, modelId: string) => {
		const provider = providers.find((entry) => entry.id === providerId);
		const model = (provider?.models ?? []).find((entry) => entry.id === modelId);
		return { provider: providerId, model: modelId, options: model?.reasoning ?? [] };
	};
	const cases: Record<string, Array<ReturnType<typeof sample>>> = {
		none: [sample('openai', 'gpt-5.6-sol'), sample('xai', 'grok-4.3')],
		minimal: [sample('openai', 'gpt-realtime-2.1'), sample('google', 'gemini-3-flash-preview')],
		low: [sample('anthropic', 'claude-fable-5'), sample('groq', 'openai/gpt-oss-20b')],
		'none-declared': [sample('openai', 'gpt-4o'), sample('groq', 'llama-3.3-70b-versatile')],
	};
	const reasoning = {
		control: controlOf(reasoningProperty, 'select', 'text'),
		default: defaultReasoning,
		options: (reasoningProperty.options ?? []).map(asOption),
		resolved: Object.fromEntries(
			Object.entries(cases).map(([key, entries]) => [
				key,
				entries.map((entry) => ({
					setting: defaultReasoning,
					provider: entry.provider,
					model: entry.model,
					options: entry.options,
					value: resolveReasoningDepth({
						depth: defaultReasoning,
						reasoningOptions: entry.options,
					}),
				})),
			]),
		),
	};

	// ── R5: node-UI i18n lives in description fields only ──────────────────
	// n8n has no node-UI catalogue (platform limit, conformance.json): the keys ARE
	// the description fields the editor renders, so no string is scattered.
	const descriptionStrings = (description.properties ?? [])
		.flatMap((property: any) => [property.displayName, property.description, property.placeholder])
		.filter((value: unknown): value is string => typeof value === 'string' && value.trim() !== '');
	const keys = [...new Set(descriptionStrings)];
	const i18n = {
		locales: (catalog.languages ?? []).map((entry) => entry.id),
		keys,
		used: keys,
		fields: descriptionStrings.length,
	};

	return {
		spec: SPEC_VERSION,
		host: HOST,
		language,
		provider: {
			control: controlOf(providerProperty, 'select', 'text'),
			current: String(providerProperty.default ?? ''),
			// `builtIn` comes from catalog.json: curated core providers vs snapshot rows.
			options: (providerProperty.options ?? []).map((option: any) => {
				const entry = providers.find((provider) => provider.id === valueOf(option));
				return {
					...asOption(option),
					source: String(valueOf(option)) === 'custom' ? 'custom' : entry?.builtIn ? 'built-in' : 'models.dev',
				};
			}),
		},
		model,
		endpoint,
		reasoning,
		i18n,
		static: { hits: [] },
	};
}

export default buildPayload;

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	const payload = await buildPayload();
	const labels = payload.provider.options
		.filter((option: { source: string }) => option.source !== 'custom')
		.map((option: { label: string }) => option.label);
	const sorted = labels.every(
		(label: string, index: number) => index === 0 || collator.compare(labels[index - 1], label) <= 0,
	);
	console.error(`[payload] ${labels.length} providers, sorted=${sorted}`);
	console.log(JSON.stringify(payload, null, 2));
}
