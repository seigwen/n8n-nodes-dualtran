import { describe, expect, it } from 'vitest';
import * as core from 'dualtran';
import { runTranslate } from '../nodes/Dualtran/translate';

describe('the vendored core through runTranslate (no network)', () => {
	it('translates with an injected fetch', async () => {
		const calls: string[] = [];
		const fetchImpl = async (url: string) => {
			calls.push(url);
			return {
				ok: true,
				status: 200,
				statusText: 'OK',
				text: async () => JSON.stringify([[['Bonjour le monde', 'Hello world', null, null, 10]], null, 'en']),
			};
		};
		const out = await runTranslate({
			core: core as never,
			fetchImpl,
			params: { texts: ['Hello world'], targetLanguage: 'fr', sourceLanguage: 'auto', engine: 'google', ai: null },
		});
		expect(out.translations).toEqual(['Bonjour le monde']);
		expect(calls).toHaveLength(1);
		expect(calls[0]).toContain('translate.googleapis.com');
	});
});
