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
	if (filtered.length === 0) {
		return { translations: [], engine: params.engine, targetLanguage: params.targetLanguage };
	}

	if (params.engine === 'ai') {
		if (!params.ai || !params.ai.apiKey) {
			throw new Error(
				'The AI engine needs the DualTran API credential (provider + API key). Select the credential on the node, or use the Google engine.',
			);
		}
		const ai = params.ai;
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
