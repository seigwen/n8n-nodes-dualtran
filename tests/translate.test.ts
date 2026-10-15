import { describe, expect, it, vi } from 'vitest';
import { runTranslate } from '../nodes/Dualtran/translate';

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
});
