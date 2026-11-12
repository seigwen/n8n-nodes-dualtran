/**
 * SPEC 2.1 rule 5 — the empty-provider guard, proven against the REAL vendored
 * core (`dualtran`) instead of the stub: an AI entry point with
 * `provider.current === ""` must raise PROVIDER_REQUIRED_ERROR and issue no
 * network request at all. `globalThis.fetch` is replaced by a tripwire.
 *
 * The payload side (provider.placeholder, model.disabled, endpoint "https://",
 * reasoning sentinel) is asserted here too so the contract is covered by the
 * unit suite and not only by the conformance validator.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as core from 'dualtran';
import { DualTranApi } from '../credentials/DualTranApi.credentials';
import { Dualtran } from '../nodes/Dualtran/Dualtran.node';
import {
	PROVIDER_REQUIRED_ERROR,
	PROVIDER_REQUIRED_FOR_MODEL,
	runTranslate,
} from '../nodes/Dualtran/translate';

const aiParams = {
	targetLanguage: 'fr',
	sourceLanguage: 'auto',
	engine: 'ai' as const,
};

let fetchSpy: ReturnType<typeof vi.fn>;

beforeEach(() => {
	fetchSpy = vi.fn(async () => {
		throw new Error('network access is forbidden while no provider is selected');
	});
	vi.stubGlobal('fetch', fetchSpy);
});

afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

describe('SPEC 2.1 rule 5 — no provider means no request (real core)', () => {
	// Positive control: the SAME runTranslate AI path with a provider and no
	// endpoint override reaches globalThis.fetch (the SDK's own fetch), so the
	// "zero requests" assertions below observe a real send attempt, not a code
	// path that never sends anything.
	it('control: a provider with no endpoint override does reach the network', async () => {
		const attempted = await runTranslate({
			core: core as never,
			params: {
				...aiParams,
				texts: ['Hello'],
				ai: { provider: 'anthropic', apiKey: 'sk-test', model: 'claude-sonnet-4-5', baseURL: '' },
			},
		})
			.then(() => [] as string[])
			.catch(() => fetchSpy.mock.calls.map((call) => String(call[0])));
		expect(attempted.length).toBeGreaterThan(0);
		expect(attempted[0]).toContain('api.anthropic.com');
	});

	it('runTranslate raises providerRequiredError and never calls fetch', async () => {
		const onError = vi.fn((error: unknown): never => {
			throw error;
		});
		await expect(
			runTranslate({
				core: core as never,
				params: {
					...aiParams,
					texts: ['Hello world'],
					ai: { provider: '', apiKey: 'sk-test', model: 'gpt-4o', baseURL: '' },
					reasoning: 'lowest',
					onError,
				},
			}),
		).rejects.toThrow(PROVIDER_REQUIRED_ERROR);
		expect(onError).toHaveBeenCalledTimes(1);
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	it('the guard fires before the model/endpoint defaults (no OpenAI request shape)', async () => {
		const attempted: string[] = [];
		vi.stubGlobal(
			'fetch',
			vi.fn(async (input: unknown) => {
				attempted.push(String(input));
				throw new Error('blocked');
			}),
		);
		await runTranslate({
			core: core as never,
			params: {
				...aiParams,
				texts: ['Bonjour'],
				ai: { provider: '', apiKey: 'sk-test', model: '', baseURL: '' },
			},
		}).catch(() => undefined);
		expect(attempted).toEqual([]);
	});

	it('the node execute path throws the localized error before any credential call', async () => {
		const node = new Dualtran();
		const getCredentials = vi.fn(async () => ({
			apiKey: 'sk-test',
			provider: 'openai',
			model: 'gpt-4o',
		}));
		const params: Record<string, unknown> = {
			operation: 'translate',
			text: 'Hello',
			targetLanguage: 'fr',
			sourceLanguage: 'auto',
			engine: 'ai',
			aiProvider: '',
			aiModel: '',
			endpoint: '',
			reasoning: 'lowest',
		};
		const context = {
			getInputData: () => [{ json: {} }],
			getNodeParameter: (name: string, _index: number, fallback?: unknown) =>
				name in params ? params[name] : fallback,
			getNode: () => ({ name: 'DualTran', type: 'dualtran' }),
			getCredentials,
			continueOnFail: () => false,
		};
		await expect(node.execute.call(context as never)).rejects.toThrow(PROVIDER_REQUIRED_ERROR);
		expect(getCredentials).not.toHaveBeenCalled();
		expect(fetchSpy).not.toHaveBeenCalled();
	});
});

describe('SPEC 2.1 — the deprecated credential field is not an OpenAI fallback', () => {
	it('a fresh credential has no provider preset (no openai, no custom)', () => {
		const credential = new DualTranApi();
		const provider = credential.properties.find((entry) => entry.name === 'provider') as any;
		expect(provider.default).toBe('');
		expect((credential.properties.find((entry) => entry.name === 'model') as any).default).toBe('');
		for (const entry of credential.properties) {
			expect(String((entry as any).default ?? '')).not.toBe('openai');
		}
	});

	it('the credential test with an empty provider reports the localized error and never fetches', async () => {
		const node = new Dualtran();
		const test = (node as any).methods.credentialTest.dualtranAiCredential as any;
		const result = await test.call(
			{},
			{ data: { apiKey: 'sk-test', provider: '', model: '' } },
		);
		expect(result.status).toBe('Error');
		expect(result.message).toContain(PROVIDER_REQUIRED_ERROR);
		expect(fetchSpy).not.toHaveBeenCalled();
	});
});

describe('SPEC 2.1 — stored values are never rewritten', () => {
	it('a node saved with a provider keeps it (no migration, no reset)', async () => {
		const node = new Dualtran();
		const params: Record<string, unknown> = {
			operation: 'translate',
			text: 'Hello',
			targetLanguage: 'fr',
			sourceLanguage: 'auto',
			engine: 'ai',
			aiProvider: 'anthropic',
			aiModel: 'claude-sonnet-4-5',
			endpoint: 'https://proxy.example/v1',
			reasoning: 'low',
		};
		const context = {
			getInputData: () => [{ json: {} }],
			getNodeParameter: (name: string, _index: number, fallback?: unknown) =>
				name in params ? params[name] : fallback,
			getNode: () => ({ name: 'DualTran', type: 'dualtran' }),
			getCredentials: vi.fn(async () => ({ apiKey: 'sk-test', provider: 'openai', model: 'gpt-4o', baseURL: '' })),
			continueOnFail: () => false,
		};
		await node.execute.call(context as never).catch(() => undefined);
		// The request (if any) must carry the stored provider/endpoint — the
		// credential's deprecated provider is never substituted in.
		const urls = fetchSpy.mock.calls.map((call) => String(call[0]));
		expect(urls.join(' ')).not.toContain('api.openai.com');
		expect(params.aiProvider).toBe('anthropic');
	});

	it('cannot return to empty: "" is not a choice and the placeholder stays out of options', async () => {
		const { defaultAiSettings, applyProviderChoice } = await import('../nodes/Dualtran/translate');
		const chosen = applyProviderChoice(defaultAiSettings(), 'groq');
		expect(chosen.aiProvider).toBe('groq');
		expect(applyProviderChoice(chosen, '')).toBe(chosen);
		expect(applyProviderChoice(chosen, '').aiProvider).toBe('groq');
	});

	it('offers no "None" item in the picker', () => {
		const node = new Dualtran();
		const options = (node.description.properties.find((entry) => entry.name === 'aiProvider') as any)
			.options as any[];
		expect(options.filter((option) => /^none$/i.test(String(option.name)))).toHaveLength(0);
	});
});

describe('SPEC 2.1 — the payload carries both states', () => {
	it('publishes the disabled placeholder, not a provider option', async () => {
		// payload.mjs is a CLI entry (it prints and exits); import the builder itself.
		const { buildPayload } = await import('../scripts/conformance/payload.ts');
		const payload = await buildPayload();
		expect(payload.provider.current).toBe('');
		expect(payload.provider.placeholder).toEqual({
			value: '',
			label: 'Select a provider',
			disabled: true,
			selected: true,
		});
		expect(
			payload.provider.options.some((option: any) => option.value === '' || option.disabled),
		).toBe(false);
		// The empty state tells the user what to do instead of preselecting OpenAI.
		expect(payload.model.disabled).toBe(true);
		expect(payload.model.label).toBe(PROVIDER_REQUIRED_FOR_MODEL);
		expect(payload.endpoint.current).toBe('');
		expect(payload.endpoint.placeholder).toBe('https://');
		expect(payload.reasoning.disabled).toBe(true);
		expect(payload.reasoning.default).toBe('lowest');
		// Configured state flips every one of those.
		expect(payload.configured.provider.current).toBe('anthropic');
		expect(payload.configured.provider.placeholder.selected).toBe(false);
		expect(payload.configured.model.disabled).toBe(false);
		expect(payload.configured.endpoint.current).toBe('https://api.anthropic.com/v1');
		expect(payload.configured.reasoning.disabled).toBe(false);
	});
});
