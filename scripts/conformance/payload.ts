/**
 * Conformance payload for n8n-nodes-dualtran (SPEC 2.1.0).
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

export const SPEC_VERSION = '2.1.0';
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
	// SPEC 2.1: the options array really rendered by n8n starts with the empty,
	// disabled `Select a provider` row. It is the placeholder, not a provider:
	// it is lifted out of `options` so real providers stay one sorted list.
	const providerProperty = must(properties, 'aiProvider');
	const renderedOptions = (providerProperty.options ?? []) as any[];
	const placeholderOption = renderedOptions.find((option) => valueOf(option) === '');
	if (!placeholderOption) {
		throw new Error('the aiProvider options carry no empty placeholder row (SPEC 2.1)');
	}
	const asProviderOption = (option: any) => {
		const entry = providers.find((provider) => provider.id === valueOf(option));
		return {
			...asOption(option),
			source: String(valueOf(option)) === 'custom' ? 'custom' : entry?.builtIn ? 'built-in' : 'models.dev',
		};
	};
	const providerOptions = renderedOptions
		.filter((option) => valueOf(option) !== '')
		.map(asProviderOption);

	// The two states of the AI section, both taken from the real state helpers
	// (nodes/Dualtran/translate.ts) — never from a hand-written fixture.
	const { defaultAiSettings, applyProviderChoice, providerApiBase } = (await import(
		pathToFileURL(path.join(ROOT, 'nodes/Dualtran/translate.ts')).href
	)) as typeof import('../../nodes/Dualtran/translate');

	const loadModels = async (providerId: string) => {
		const method = node.methods?.loadOptions?.[must(properties, 'aiModel').typeOptions?.loadOptionsMethod ?? ''];
		if (typeof method !== 'function') return [];
		const options = await method.call({
			getNodeParameter: (name: string) => (name === 'aiProvider' ? providerId : ''),
		});
		return (options ?? []).map(asOption);
	};

	/** The AI settings state plus the pickers' rendered surface, for one state. */
	const describeState = async (state: ReturnType<typeof defaultAiSettings>) => {
		const unconfigured = state.aiProvider === '';
		return {
			aiProvider: state.aiProvider,
			aiModel: state.aiModel,
			provider: {
				current: state.aiProvider,
				placeholder: {
					value: valueOf(placeholderOption),
					label: labelOf(placeholderOption),
					disabled: placeholderOption.disabled === true,
					selected: unconfigured,
				},
				// No fallback provider while unconfigured (SPEC 2.1 rule 5).
				fallback: unconfigured ? '' : state.aiProvider,
				options: providerOptions,
			},
			model: {
				disabled: state.model.disabled,
				label: state.model.label,
				selectedProvider: state.aiProvider,
				selectedModel: state.aiModel,
				options: await loadModels(state.aiProvider),
			},
			endpoint: {
				control: controlOf(must(properties, 'endpoint'), 'select', 'text'),
				current: state.endpoint.value,
				placeholder: state.endpoint.placeholder,
			},
			reasoning: {
				disabled: state.reasoning.disabled,
				// Stored sentinel, unchanged by the empty state (SPEC 2.1 rule 3).
				default: state.reasoning.value,
				value: state.reasoning.value,
			},
		};
	};

	const emptyState = defaultAiSettings();
	const configuredState = applyProviderChoice(emptyState, 'anthropic');
	const unconfiguredState = await describeState(emptyState);
	const configured = await describeState(configuredState);

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
		// Configured surface; `unconfigured` / `configured` below carry both states.
		disabled: configured.model.disabled,
		label: configured.model.label,
		selectedProvider: configured.model.selectedProvider,
		selectedModel: configured.model.selectedModel,
		options: configured.model.options,
		byProvider,
		loadOptions,
		catalogProviders: providers.map((provider) => provider.id),
	};

	// ── R3: endpoint stays a text field, autofilled at execution ────────────
	const endpointProperty = must(properties, 'endpoint');
	const endpointDefault = String(endpointProperty.default ?? '');
	const autofillProvider = configuredState.aiProvider;
	const proxyEndpoint = 'https://proxy.example/v1';
	// Rule 4 through the real helper: choosing a provider puts the API base into
	// the endpoint VALUE; a user-edited endpoint survives the next switch.
	const afterChoice = applyProviderChoice(defaultAiSettings(), autofillProvider);
	const userEditedState = {
		...afterChoice,
		endpoint: { ...afterChoice.endpoint, value: proxyEndpoint },
	};
	const afterSwitch = applyProviderChoice(userEditedState, 'openai', autofillProvider);
	const endpoint = {
		control: controlOf(endpointProperty, 'select', 'text'),
		default: endpointDefault,
		current: configured.endpoint.current,
		placeholder: String(endpointProperty.placeholder ?? ''),
		autofill: {
			provider: autofillProvider,
			providerApi: providerApiBase(autofillProvider),
			before: defaultAiSettings().endpoint.value,
			after: afterChoice.endpoint.value,
			userEdited: proxyEndpoint,
			afterSwitch: afterSwitch.endpoint.value,
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
		disabled: configured.reasoning.disabled,
		value: configured.reasoning.value,
		unconfiguredDisabled: unconfiguredState.reasoning.disabled,
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
	// SPEC 2.1 keys: each symbolic key (`providerPlaceholder`…) maps to the English
	// literal declared once in translate.ts. Those literals are rendered by the
	// description, so the key set and the rendered field set still line up 1:1.
	// `buildPayload` runs standalone (see the CLI tail below) and under the kit,
	// which attaches conformance.json to the payload afterwards; read the
	// declarations straight from the file so both paths see the same keys.
	const configPath = path.join(ROOT, 'conformance.json');
	const declared = require('node:fs').existsSync(configPath)
		? (JSON.parse(require('node:fs').readFileSync(configPath, 'utf8')) as { platformLimits?: unknown[] })
		: {};
	const specLiterals = ((declared.platformLimits ?? []) as Array<{
		rule: string;
		englishLiterals?: Record<string, string>;
	}>).find((limit) => limit.rule === 'R5')?.englishLiterals ?? {};
	// The three SPEC 2.1 strings are rendered as real description fields, so the key
	// set IS the rendered set (keys ↔ fields 1:1, every key used). Their symbolic
	// names (`providerPlaceholder`…) are declared in conformance.json's R5
	// englishLiterals, which is where the product names them.
	const rendered = new Set(descriptionStrings);
	const missing = Object.values(specLiterals).filter((literal) => !rendered.has(literal));
	if (missing.length) {
		throw new Error(`SPEC 2.1 literal(s) never rendered by the node description: ${missing.join(', ')}`);
	}
	const i18n = {
		locales: (catalog.languages ?? []).map((entry) => entry.id),
		keys: descriptionStrings,
		used: descriptionStrings,
		fields: descriptionStrings.length,
		specKeys: specLiterals,
	};

	return {
		spec: SPEC_VERSION,
		host: HOST,
		language,
		// Top level = the state a fresh install renders (SPEC 2.1 default: "").
		provider: {
			control: controlOf(providerProperty, 'select', 'text'),
			current: unconfiguredState.provider.current,
			placeholder: unconfiguredState.provider.placeholder,
			fallback: unconfiguredState.provider.fallback,
			options: providerOptions,
		},
		model: {
			...model,
			disabled: unconfiguredState.model.disabled,
			label: unconfiguredState.model.label,
			selectedProvider: unconfiguredState.model.selectedProvider,
			selectedModel: unconfiguredState.model.selectedModel,
			options: unconfiguredState.model.options,
		},
		endpoint: {
			...endpoint,
			current: unconfiguredState.endpoint.current,
			// Both states are rendered from the same controls; the autofill proof
			// is identical and travels with each state.
			autofill: endpoint.autofill,
		},
		reasoning: { ...reasoning, disabled: unconfiguredState.reasoning.disabled },
		unconfigured: {
			...unconfiguredState,
			endpoint: { ...unconfiguredState.endpoint, autofill: endpoint.autofill },
		},
		configured,
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
