/**
 * The translation logic behind the DualTran node — dependency-injected so the
 * unit suite runs against a stub core with no network, and the node itself
 * passes the bundled CJS core (see scripts/sync-core.mjs).
 *
 * It also owns the catalogue-facing helpers shared by the node and the
 * conformance payload: language/provider/model options read from catalog.json,
 * the endpoint fill rule (provider API base) and the reasoning resolver.
 */
import catalog from '../../catalog.generated';

export interface CoreLike {
	translateGoogle(args: {
		sourceArray: string[];
		sourceLanguage: string;
		targetLanguage: string;
		cache: unknown;
		fetchImpl: unknown;
	}): Promise<string[]>;
	streamChat(args: {
		provider: string;
		apiKey: string,
		model: string;
		messages: Array<{ role: string; content: string }>;
		extra?: Record<string, unknown>;
		reasoningDepth?: string;
		store?: unknown;
		onChunk?: (text: string) => void;
	}): Promise<{ totalChunks: number; streamError: unknown }>;
	buildTranslationMessages(args: { content: string; targetLanguageName: string }): {
		system: string;
		assistant: string;
	};
	codeToLanguageNameInEnglish?(code: string): string;
	formatAiError(error: unknown): { message: string };
}

export interface AiCredential {
	provider: string;
	apiKey: string,
	model: string;
	baseURL?: string;
	/** Provider API base used to fill an empty endpoint. */
	api?: string;
}

export interface TranslateParams {
	texts: string[];
	targetLanguage: string;
	sourceLanguage: string;
	engine: 'google' | 'ai';
	ai: AiCredential | null;
	/** `lowest` (sentinel), `none`, `minimal`, `low`, … — resolved per model. */
	reasoning?: string;
	/** The node's error factory (`NodeApiError`/`NodeOperationError`): never throw raw. */
	onError?: (error: unknown) => never;
}

export interface TranslateOutcome {
	translations: string[];
	engine: 'google' | 'ai';
	targetLanguage: string;
}

// ── Localized strings (SPEC 2.1) ─────────────────────────────────────────────
//
// n8n has no node-UI i18n API (platform limit R5, conformance.json), so the
// three AI-provider strings live here as English literals — one declaration,
// referenced from the description fields, the endpoint/button guards and the
// empty-state helpers. The `providerRequired*` messages are what the user reads
// when the node runs unconfigured; `PROVIDER_PLACEHOLDER` labels the disabled
// picker row of a fresh install.
export const PROVIDER_PLACEHOLDER = 'Select a provider';
export const PROVIDER_REQUIRED_FOR_MODEL = 'Select a provider first';
export const PROVIDER_REQUIRED_ERROR = 'Choose an AI provider in settings before translating.';

/** The provider id a fresh install carries: none until the user picks one. */
export const EMPTY_PROVIDER = '';

/** Placeholder of the endpoint field while no provider is selected. */
export const ENDPOINT_PLACEHOLDER = 'https://';

// ── AI settings state (the surface the node description renders) ─────────────

export interface AiSettingsState {
	/** Selected provider id ('' on a fresh install). */
	aiProvider: string;
	/** Selected model id ('' on a fresh install). */
	aiModel: string;
	/** Endpoint field: its value and the placeholder shown while it is empty. */
	endpoint: { value: string; placeholder: string };
	/** Model picker: empty and disabled until a provider is chosen. */
	model: { disabled: boolean; label: string; value: string; options: CatalogModel[] };
	/** Reasoning picker: disabled until a provider is chosen; sentinel unchanged. */
	reasoning: { disabled: boolean; value: string };
}

/** A fresh/empty AI configuration: no provider, no model, no endpoint. */
export function defaultAiSettings(): AiSettingsState {
	return {
		aiProvider: EMPTY_PROVIDER,
		aiModel: '',
		endpoint: { value: '', placeholder: ENDPOINT_PLACEHOLDER },
		model: { disabled: true, label: PROVIDER_REQUIRED_FOR_MODEL, value: '', options: [] },
		reasoning: { disabled: true, value: REASONING_LOWEST },
	};
}

/**
 * Choosing a provider: the endpoint VALUE becomes the provider API base, the
 * model list loads, reasoning enables — and a user-edited endpoint is kept on
 * every later switch. '' is not a choice (the placeholder is disabled), so the
 * state cannot return to empty.
 */
export function applyProviderChoice(
	state: AiSettingsState,
	providerId: string,
	previousProvider = state.aiProvider,
): AiSettingsState {
	const chosen = String(providerId ?? '').trim();
	if (chosen === '') return state;
	const userEdited = state.endpoint.value.trim() !== '' && state.endpoint.value !== providerApiBase(previousProvider);
	return {
		...state,
		aiProvider: chosen,
		endpoint: { value: userEdited ? state.endpoint.value : providerApiBase(chosen), placeholder: ENDPOINT_PLACEHOLDER },
		model: {
			disabled: false,
			label: '',
			value: state.model.value,
			options: modelsForProvider(chosen),
		},
		reasoning: { ...state.reasoning, disabled: false },
	};
}

/** True when the AI engine was left without a provider — the guarded state. */
export function isProviderMissing(ai: { provider?: string } | null | undefined): boolean {
	return String(ai?.provider ?? '').trim() === '';
}

// ── Catalogue (catalog.json, generated at build time) ────────────────────────

export interface CatalogModel {
	id: string;
	label: string;
	reasoning?: string[];
}
export interface CatalogProvider {
	id: string;
	name: string;
	api: string;
	builtIn: boolean;
	models: CatalogModel[];
}
export interface Catalog {
	providers: CatalogProvider[];
	languages: Array<{ id: string; label: string }>;
}

const CATALOG = catalog as unknown as Catalog;
export interface LanguageOption {
	name: string;
	value: string;
	description: string;
}

/** Target-language options for the `options` picker (human-readable labels). */
export function languageOptions(): LanguageOption[] {
	return CATALOG.languages.map((language) => ({
		name: language.label,
		value: language.id,
		description: `${language.label} (${language.id})`,
	}));
}

/** Source-language options: auto-detection first, then the same catalogue. */
export function sourceLanguageOptions(): LanguageOption[] {
	return [
		{ name: 'Auto (Detect)', value: 'auto', description: 'Detect the language of the text' },
		...languageOptions(),
	];
}

export function catalogProviders(): CatalogProvider[] {
	return CATALOG.providers;
}

export function findProvider(providerId: string): CatalogProvider | undefined {
	return CATALOG.providers.find((provider) => provider.id === providerId);
}

/** Catalogue models for a provider ([] when the provider is unknown). */
export function modelsForProvider(providerId: string): CatalogModel[] {
	return findProvider(providerId)?.models ?? [];
}

/**
 * Model picker options: the snapshot models of a chosen provider, sorted by
 * label with the free-text `Custom model…` row last. No provider → no options
 * (the picker is disabled and the user is told to pick a provider first).
 */
export function modelOptions(providerId: string): LanguageOption[] {
	if (String(providerId ?? '').trim() === '') return [];
	const models = modelsForProvider(providerId)
		.slice()
		.sort((a, b) => a.label.localeCompare(b.label, 'en', { numeric: true, sensitivity: 'base' }))
		.map((model) => ({
			name: model.label,
			value: model.id,
			description: model.reasoning?.length ? `Reasoning: ${model.reasoning.join(', ')}` : '',
		}));
	models.push({
		name: 'Custom model…',
		value: 'custom',
		description: 'Use a model ID that is not in the snapshot',
	});
	return models;
}
/**
 * The endpoint a provider implies: its own catalogue `api`, falling back to the
 * core's known bases (for providers the catalogue carries without a URL).
 */
export function providerApiBase(providerId: string, core?: CoreLike): string {
	const provider = findProvider(providerId);
	if (provider?.api) return provider.api;
	const lookup = (core as unknown as { lookupKnownApiBase?: (id: string) => string } | undefined)
		?.lookupKnownApiBase;
	const known = typeof lookup === 'function' ? lookup(providerId) : '';
	return String(known || '').replace(/\/(chat\/completions|messages|completions)\/?$/i, '');
}

/** Endpoint precedence: node value, then credential base URL, then provider API base. */
export function resolveEndpoint({
	endpoint = '',
	credentialBaseURL = '',
	provider,
	core,
}: {
	endpoint?: string;
	credentialBaseURL?: string;
	provider: string;
	core?: CoreLike;
}): string {
	const given = String(endpoint || '').trim();
	if (given) return given;
	const fromCredential = String(credentialBaseURL || '').trim();
	if (fromCredential) return fromCredential;
	return providerApiBase(provider, core);
}

// ── Reasoning ────────────────────────────────────────────────────────────────

/** The picker's sentinel: "let the model use its lowest supported depth". */
export const REASONING_LOWEST = 'lowest';

/** Effort order; `none → minimal → low` is the order the product rule asks for. */
const ASCENDING = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];

function rank(value: string): number {
	const index = ASCENDING.indexOf(value);
	return index === -1 ? ASCENDING.length : index;
}

/**
 * Resolve the reasoning setting against what a model declares.
 *
 *   `lowest` / empty   → lowest declared value (`none`, else `minimal`, else `low`…)
 *   `none`             → `none` (it is the lowest when declared)
 *   explicit setting   → kept when declared, else the lowest declared
 *   nothing declared   → `''` — callers then omit the reasoning argument entirely
 */
export function resolveReasoningDepth({
	depth,
	reasoningOptions,
}: {
	depth: string | undefined;
	reasoningOptions: string[] | undefined;
}): string {
	const declared = (reasoningOptions ?? []).filter((value) => typeof value === 'string' && value);
	if (declared.length === 0) return '';
	const setting = String(depth ?? '').trim();
	if (setting && setting !== REASONING_LOWEST && declared.includes(setting)) return setting;
	return [...declared].sort((a, b) => rank(a) - rank(b))[0];
}

/** `resolveReasoningDepth` for the provider/model pair set on the node. */
export function resolveReasoningForModel({
	depth,
	providerId,
	modelId,
}: {
	depth: string | undefined;
	providerId: string;
	modelId: string;
}): string {
	const model = modelsForProvider(providerId).find((entry) => entry.id === modelId);
	// Unknown model: declare nothing — the request goes out without a reasoning
	// argument (and the 400 retry covers providers that reject it anyway).
	return resolveReasoningDepth({ depth, reasoningOptions: model?.reasoning });
}

// ── AI streaming ─────────────────────────────────────────────────────────────

/**
 * A 400 means the provider rejected the request — usually the reasoning argument,
 * and some providers report it only in the error body text.
 */
function isBadRequest(error: unknown): boolean {
	const failure = error as
		| { statusCode?: number; status?: number; message?: string; data?: unknown; responseBody?: unknown }
		| null;
	const code = Number(failure?.statusCode ?? failure?.status ?? 0);
	if (code === 400) return true;
	const body = `${String(failure?.message ?? '')} ${JSON.stringify(failure?.data ?? '')} ${JSON.stringify(
		failure?.responseBody ?? '',
	)}`;
	return /\b400\b/.test(body);
}

async function streamOnce({
	core,
	ai,
	messages,
	reasoning,
}: {
	core: CoreLike;
	ai: AiCredential;
	messages: Array<{ role: string; content: string }>;
	reasoning: string;
}): Promise<{ text: string; totalChunks: number }> {
	let text = '';
	const { totalChunks, streamError } = await core.streamChat({
		provider: ai.provider,
		apiKey: ai.apiKey,
		model: ai.model,
		messages,
		extra: ai.baseURL ? { baseURL: ai.baseURL } : {},
		...(reasoning ? { reasoningDepth: reasoning } : {}),
		store: null,
		onChunk: (chunk) => {
			text += chunk;
		},
	});
	if (streamError) {
		const error = new Error(core.formatAiError(streamError).message);
		(error as Error & { cause?: unknown }).cause = streamError;
		throw error;
	}
	return { text, totalChunks };
}

/**
 * One AI translation with the 400 safety net: when the provider rejects the
 * request, retry once without the reasoning argument (a provider that does not
 * accept it answers 400). Any other failure goes through `onError`, which
 * re-throws as the node's own error type (n8n rule: no raw errors escape).
 */
function translateWithAi({
	core,
	ai,
	messages,
	reasoning,
	onError,
}: {
	core: CoreLike;
	ai: AiCredential;
	messages: Array<{ role: string; content: string }>;
	reasoning: string;
	onError: (error: unknown) => never;
}): Promise<{ text: string; totalChunks: number }> {
	return streamOnce({ core, ai, messages, reasoning }).catch(async (error: unknown) => {
		const cause = (error as Error & { cause?: unknown }).cause ?? error;
		if (!reasoning || !isBadRequest(cause)) return onError(error);
		return streamOnce({ core, ai, messages, reasoning: '' }).catch((retryError: unknown) =>
			onError(retryError),
		);
	});
}

/** Default error path for standalone callers (tests, scripts): reject as-is. */
const rethrow = (error: unknown): never => {
	throw error instanceof Error ? error : new Error(String(error));
};

export async function runTranslate({
	core,
	fetchImpl = null,
	params,
}: {
	core: CoreLike;
	fetchImpl?: unknown;
	params: TranslateParams;
}): Promise<TranslateOutcome> {
	const filtered = params.texts.map((text) => text.trim()).filter((text) => text.length > 0);
	const onError = params.onError ?? rethrow;
	// SPEC 2.1 rule 5, first thing on the AI path: an entry with no provider
	// selected is an explicit error, never a silent OpenAI request. Checked
	// before the credential, the model and the endpoint so the message names the
	// real problem and no default can fill the gap — the node passes
	// `ai: { provider: '' }` for its own empty state, and a caller that passes
	// no `ai` at all still gets the provider-required error.
	if (params.engine === 'ai' && (!params.ai || isProviderMissing(params.ai))) {
		return onError(new Error(PROVIDER_REQUIRED_ERROR));
	}
	if (filtered.length === 0) {
		return { translations: [], engine: params.engine, targetLanguage: params.targetLanguage };
	}

	if (params.engine === 'ai') {
		// Narrowed by the guard above; `ai.provider` is the only provider source
		// on this path — no implicit default provider of any kind.
		const ai = params.ai as AiCredential;
		if (!ai.apiKey) {
			return onError(
				new Error(
					'The AI engine needs the DualTran API credential (provider + API key). Select the credential on the node, or use the Google engine.',
				),
			);
		}
		const reasoning = resolveReasoningForModel({
			depth: params.reasoning,
			providerId: ai.provider,
			modelId: ai.model,
		});
		const translations: string[] = [];
		for (const content of filtered) {
			const targetLanguageName =
				(core.codeToLanguageNameInEnglish && core.codeToLanguageNameInEnglish(params.targetLanguage)) ||
				params.targetLanguage;
			const prompt = core.buildTranslationMessages({ content, targetLanguageName });
			const messages = [
				{ role: 'system', content: prompt.system },
				{ role: 'user', content: 'I understand. Please give me the text.' },
				{ role: 'user', content },
			];
			const { text, totalChunks } = await translateWithAi({ core, ai, messages, reasoning, onError });
			if (totalChunks === 0) {
				return onError(new Error('No response from AI provider'));
			}
			translations.push(text);
		}
		return { translations, engine: 'ai', targetLanguage: params.targetLanguage };
	}

	const translations = await core.translateGoogle({
		sourceArray: filtered,
		sourceLanguage: params.sourceLanguage,
		targetLanguage: params.targetLanguage,
		cache: null,
		fetchImpl,
	});
	return { translations, engine: 'google', targetLanguage: params.targetLanguage };
}
