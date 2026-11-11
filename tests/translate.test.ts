import { describe, expect, it, vi } from 'vitest';
import {
	catalogProviders,
	languageOptions,
	modelsForProvider,
	resolveEndpoint,
	resolveReasoningDepth,
	resolveReasoningForModel,
	runTranslate,
	sourceLanguageOptions,
} from '../nodes/Dualtran/translate';

function makeCore(overrides: Record<string, unknown> = {}) {
	return {
		translateGoogle: vi.fn(async ({ sourceArray }: { sourceArray: string[] }) => sourceArray.map((t) => `T:${t}`)),
		streamChat: vi.fn(async () => ({ totalChunks: 0, streamError: null })),
		buildTranslationMessages: vi.fn(() => ({ system: 'SYS', assistant: 'ACK' })),
		codeToLanguageNameInEnglish: vi.fn((c: string) => (c === 'en' ? 'English' : c)),
		formatAiError: vi.fn((e: { message?: string } | undefined) => ({ message: String((e && e.message) || e) })),
		...overrides,
	};
}

const baseParams = { targetLanguage: 'en', sourceLanguage: 'auto', engine: 'google' as const, ai: null };

describe('runTranslate — google', () => {
	it('delegates a normalized batch to translateGoogle', async () => {
		const core = makeCore();
		const out = await runTranslate({
			core: core as never,
			params: { ...baseParams, texts: [' Hello ', '', 'World'], targetLanguage: 'fr', sourceLanguage: 'en' },
		});
		expect(out).toEqual({ translations: ['T:Hello', 'T:World'], engine: 'google', targetLanguage: 'fr' });
		const arg = core.translateGoogle.mock.calls[0][0] as Record<string, unknown>;
		expect(arg.sourceArray).toEqual(['Hello', 'World']);
		expect(arg.sourceLanguage).toBe('en');
		expect(arg.targetLanguage).toBe('fr');
	});

	it('short-circuits blank input', async () => {
		const core = makeCore();
		const out = await runTranslate({ core: core as never, params: { ...baseParams, texts: ['', '  '] } });
		expect(out.translations).toEqual([]);
		expect(core.translateGoogle).not.toHaveBeenCalled();
	});

	it('propagates engine failures', async () => {
		const core = makeCore({
			translateGoogle: vi.fn(async () => {
				throw new Error('Google translation failed: HTTP 429');
			}),
		});
		await expect(runTranslate({ core: core as never, params: { ...baseParams, texts: ['x'] } })).rejects.toThrow(
			'Google translation failed: HTTP 429',
		);
	});
});

describe('runTranslate — ai', () => {
	const ai = { provider: 'openai', apiKey: 'k', model: 'm', baseURL: '' };

	it('streams per text with the extension-shaped messages', async () => {
		const core = makeCore({
			streamChat: vi.fn(async ({ onChunk }: { onChunk: (t: string) => void }) => {
				onChunk('Hola');
				return { totalChunks: 1, streamError: null };
			}),
		});
		const out = await runTranslate({
			core: core as never,
			params: { ...baseParams, engine: 'ai', ai, texts: ['Hello'] },
		});
		expect(out.translations).toEqual(['Hola']);
		const arg = core.streamChat.mock.calls[0][0] as Record<string, never>;
		expect(arg.provider).toBe('openai');
		expect((arg.messages as { role: string }[]).map((m) => m.role)).toEqual(['system', 'user', 'user']);
	});

	it('throws an actionable error without credentials', async () => {
		await expect(
			runTranslate({ core: makeCore() as never, params: { ...baseParams, engine: 'ai', ai: null, texts: ['x'] } }),
		).rejects.toThrow(/DualTran API credential/);
	});

	it('throws when the provider stream reports an error', async () => {
		const core = makeCore({
			streamChat: vi.fn(async () => ({ totalChunks: 0, streamError: { statusCode: 401 } })),
			formatAiError: vi.fn(() => ({ message: 'Invalid or missing API key' })),
		});
		await expect(
			runTranslate({ core: core as never, params: { ...baseParams, engine: 'ai', ai, texts: ['x'] } }),
		).rejects.toThrow('Invalid or missing API key');
	});

	it('omits the reasoning argument when the model declares none', async () => {
		const core = makeCore({
			streamChat: vi.fn(async ({ onChunk }: { onChunk: (t: string) => void }) => {
				onChunk('Hola');
				return { totalChunks: 1, streamError: null };
			}),
		});
		await runTranslate({
			core: core as never,
			params: { ...baseParams, engine: 'ai', ai: { ...ai, model: 'gpt-4o' }, reasoning: 'lowest', texts: ['Hi'] },
		});
		const arg = core.streamChat.mock.calls[0][0] as Record<string, unknown>;
		expect('reasoningDepth' in arg).toBe(false);
	});

	it('passes the resolved reasoning depth (lowest → none → low …)', async () => {
		const streamChat = vi.fn(async ({ onChunk }: { onChunk: (t: string) => void }) => {
			onChunk('Hola');
			return { totalChunks: 1, streamError: null };
		});
		const core = makeCore({ streamChat });
		await runTranslate({
			core: core as never,
			params: {
				...baseParams,
				engine: 'ai',
				ai: { ...ai, model: 'gpt-5.6-sol' },
				reasoning: 'lowest',
				texts: ['Hi'],
			},
		});
		expect((streamChat.mock.calls[0][0] as Record<string, unknown>).reasoningDepth).toBe('none');
	});

	it('retries without reasoning when the provider answers 400', async () => {
		let call = 0;
		const streamChat = vi.fn(async ({ onChunk }: { onChunk: (t: string) => void }) => {
			call += 1;
			if (call === 1) return { totalChunks: 0, streamError: { statusCode: 400, message: 'unsupported parameter' } };
			onChunk('Hola');
			return { totalChunks: 1, streamError: null };
		});
		// Realistic formatAiError: the status hint survives into the message.
		const formatAiError = vi.fn((error: { statusCode?: number; message?: string }) => ({
			message: `${error?.statusCode ?? ''} ${error?.message ?? ''}`.trim(),
		}));
		const core = makeCore({ streamChat, formatAiError });
		const out = await runTranslate({
			core: core as never,
			// A model that declares reasoning, so the first attempt carries the depth.
			params: { ...baseParams, engine: 'ai', ai: { ...ai, model: 'gpt-5.6-sol' }, reasoning: 'high', texts: ['Hi'] },
		});
		expect(out.translations).toEqual(['Hola']);
		expect(streamChat).toHaveBeenCalledTimes(2);
		expect((streamChat.mock.calls[0][0] as Record<string, unknown>).reasoningDepth).toBe('high');
		expect((streamChat.mock.calls[1][0] as Record<string, unknown>).reasoningDepth).toBeUndefined();
	});

	it('does not retry a non-400 failure', async () => {
		const streamChat = vi.fn(async () => ({ totalChunks: 0, streamError: { statusCode: 429 } }));
		const core = makeCore({ streamChat, formatAiError: vi.fn(() => ({ message: 'Rate limit exceeded' })) });
		await expect(
			runTranslate({
				core: core as never,
				params: { ...baseParams, engine: 'ai', ai: { ...ai, model: 'gpt-5.6-sol' }, reasoning: 'high', texts: ['x'] },
			}),
		).rejects.toThrow('Rate limit exceeded');
		expect(streamChat).toHaveBeenCalledTimes(1);
	});
});

describe('catalogue helpers', () => {
	it('exposes 44 target languages and an auto source entry', () => {
		expect(languageOptions()).toHaveLength(44);
		expect(languageOptions().some((option) => option.value === 'auto')).toBe(false);
		expect(sourceLanguageOptions()[0]).toMatchObject({ value: 'auto' });
		expect(sourceLanguageOptions()).toHaveLength(45);
	});

	it('lists providers and their snapshot models', () => {
		expect(catalogProviders().length).toBeGreaterThanOrEqual(20);
		expect(modelsForProvider('openai').some((model) => model.id === 'gpt-4o')).toBe(true);
		expect(modelsForProvider('nope')).toEqual([]);
	});

	it('fills the endpoint from node value → credential → provider API base', () => {
		expect(
			resolveEndpoint({ endpoint: 'https://proxy/v1', credentialBaseURL: 'https://cred/v1', provider: 'openai' }),
		).toBe('https://proxy/v1');
		expect(resolveEndpoint({ endpoint: '', credentialBaseURL: 'https://cred/v1', provider: 'openai' })).toBe(
			'https://cred/v1',
		);
		expect(resolveEndpoint({ endpoint: '', provider: 'deepseek' })).toBe('https://api.deepseek.com');
		expect(resolveEndpoint({ endpoint: '  ', provider: 'openai' })).toBe('https://api.openai.com/v1');
	});

	it('resolves reasoning per model from the snapshot', () => {
		expect(resolveReasoningDepth({ depth: 'lowest', reasoningOptions: ['minimal', 'low'] })).toBe('minimal');
		expect(resolveReasoningDepth({ depth: 'high', reasoningOptions: ['low', 'high'] })).toBe('high');
		expect(resolveReasoningDepth({ depth: 'max', reasoningOptions: ['low', 'high'] })).toBe('low');
		expect(resolveReasoningDepth({ depth: 'lowest', reasoningOptions: [] })).toBe('');
		expect(resolveReasoningForModel({ depth: 'lowest', providerId: 'openai', modelId: 'gpt-5.6-sol' })).toBe('none');
		expect(resolveReasoningForModel({ depth: 'lowest', providerId: 'openai', modelId: 'missing-model' })).toBe('');
	});
});
