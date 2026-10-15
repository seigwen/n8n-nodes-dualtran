/**
 * The translation logic behind the DualTran node — dependency-injected so the
 * unit suite runs against a stub core with no network, and the node itself
 * passes the bundled CJS core (see scripts/sync-core.mjs).
 */
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
		apiKey: string;
		model: string;
		messages: Array<{ role: string; content: string }>;
		extra?: Record<string, unknown>;
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
	apiKey: string;
	model: string;
	baseURL?: string;
}

export interface TranslateParams {
	texts: string[];
	targetLanguage: string;
	sourceLanguage: string;
	engine: 'google' | 'ai';
	ai: AiCredential | null;
}

export interface TranslateOutcome {
	translations: string[];
	engine: 'google' | 'ai';
	targetLanguage: string;
}

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
	if (filtered.length === 0) {
		return { translations: [], engine: params.engine, targetLanguage: params.targetLanguage };
	}

	if (params.engine === 'ai') {
		if (!params.ai || !params.ai.apiKey) {
			throw new Error(
				'The AI engine needs the DualTran API credential (provider + API key). Select the credential on the node, or use the Google engine.',
			);
		}
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
			let text = '';
			const { totalChunks, streamError } = await core.streamChat({
				provider: params.ai.provider,
				apiKey: params.ai.apiKey,
				model: params.ai.model,
				messages,
				extra: params.ai.baseURL ? { baseURL: params.ai.baseURL } : {},
				store: null,
				onChunk: (chunk) => {
					text += chunk;
				},
			});
			if (streamError) {
				throw new Error(core.formatAiError(streamError).message);
			}
			if (totalChunks === 0) {
				throw new Error('No response from AI provider');
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
