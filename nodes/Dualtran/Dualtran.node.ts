import {
	NodeConnectionTypes,
	NodeOperationError,
	type ICredentialDataDecryptedObject,
	type ICredentialTestFunctions,
	type ICredentialsDecrypted,
	type IDataObject,
	type IExecuteFunctions,
	type ILoadOptionsFunctions,
	type INodeExecutionData,
	type INodePropertyOptions,
	type INodeType,
	type INodeTypeDescription,
} from 'n8n-workflow';
import * as coreNamespace from 'dualtran';
import {
	EMPTY_PROVIDER,
	ENDPOINT_PLACEHOLDER,
	PROVIDER_PLACEHOLDER,
	PROVIDER_REQUIRED_ERROR,
	PROVIDER_REQUIRED_FOR_MODEL,
	catalogProviders,
	languageOptions,
	modelOptions,
	providerApiBase,
	resolveEndpoint,
	runTranslate,
	sourceLanguageOptions,
	type AiCredential,
	type CoreLike,
} from './translate';

// The core is inlined into dist at build time (scripts/build.mjs), so the
// installed package has no runtime dependencies.
const core = coreNamespace as unknown as CoreLike;

/**
 * Every user-facing label lives here (n8n has no node-UI i18n API — R5). The
 * three AI-provider strings of SPEC 2.1 are English literals declared once in
 * translate.ts and re-exported through the description fields below.
 */
const TEXT = {
	providerCustom: 'Custom…',
};

type ProviderOption = INodePropertyOptions & { disabled?: boolean };

/**
 * Provider options: a disabled, selected placeholder row for the empty state,
 * then curated built-ins + the models.dev snapshot in ONE alphabetical list
 * (catalog.json, alias twins deduped), `Custom…` last.
 *
 * The `value: ''` row is the placeholder the picker shows while `aiProvider`
 * is empty — it is not a real provider, it is excluded from the sort and it
 * stays disabled, so the user cannot return to the empty state once they have
 * chosen (SPEC 2.1). The conformance payload exposes it as `provider.placeholder`.
 *
 * `disabled` is honoured by the editor but is not part of this n8n version's
 * `INodePropertyOptions` type, so the empty row is typed through `ProviderOption`.
 */
function providerOptions(): ProviderOption[] {
	const curated = catalogProviders()
		.slice()
		.sort((a, b) => a.name.localeCompare(b.name, 'en', { numeric: true, sensitivity: 'base' }))
		.map((provider) => ({
			name: provider.name,
			value: provider.id,
			description: provider.api ? `API base: ${provider.api}` : 'API base from the core provider registry',
		}));
	return [
		{
			name: PROVIDER_PLACEHOLDER,
			value: EMPTY_PROVIDER,
			disabled: true,
			description: 'No AI provider is selected yet',
		},
		...curated,
		{
			name: TEXT.providerCustom,
			value: 'custom',
			description: 'OpenAI-compatible server: set the endpoint yourself',
		},
	];
}

export class Dualtran implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'DualTran',
		name: 'dualtran',
		icon: { light: 'file:../../icons/dualtran.svg', dark: 'file:../../icons/dualtran.dark.svg' },
		group: ['transform'],
		version: 1,
		subtitle: '={{$parameter["operation"]}}',
		description: 'Translate text with Google or your own AI model (BYOK)',
		defaults: { name: 'DualTran' },
		usableAsTool: true,
		inputs: [NodeConnectionTypes.Main],
		outputs: [NodeConnectionTypes.Main],
		credentials: [{ name: 'dualtranApi', required: false, testedBy: 'dualtranAiCredential' }],
		properties: [
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				options: [
					{
						name: 'Translate Text',
						value: 'translate',
						action: 'Translate one text',
						description: 'Translate the given text',
					},
					{
						name: 'Translate Batch',
						value: 'translateBatch',
						action: 'Translate several texts',
						description: 'Translate a list of texts in one batched request',
					},
				],
				default: 'translate',
			},
			{
				displayName: 'Text',
				name: 'text',
				type: 'string',
				typeOptions: { rows: 3 },
				default: '',
				required: true,
				displayOptions: { show: { operation: ['translate'] } },
				description: 'Text to translate (expressions welcome)',
			},
			{
				displayName: 'Texts',
				name: 'texts',
				type: 'fixedCollection',
				typeOptions: { multipleValues: true },
				placeholder: 'Add Text',
				default: {},
				displayOptions: { show: { operation: ['translateBatch'] } },
				options: [
					{
						displayName: 'Text',
						name: 'values',
						values: [
							{
								displayName: 'Text',
								name: 'text',
								type: 'string',
								default: '',
							},
						],
					},
				],
			},
			{
				displayName: 'Target Language',
				name: 'targetLanguage',
				type: 'options',
				// 44 catalogues from facts/language-names.json, alphabetical by name.
				options: languageOptions(),
				default: 'en',
				description: 'Language to translate into',
			},
			{
				displayName: 'Source Language',
				name: 'sourceLanguage',
				type: 'options',
				options: sourceLanguageOptions(),
				default: 'auto',
				description: 'Language the text is written in; auto detects it',
			},
			{
				displayName: 'Engine',
				name: 'engine',
				type: 'options',
				options: [
					{
						name: 'Google',
						value: 'google',
						description: 'Free, no account required',
					},
					{
						name: 'AI (BYOK)',
						value: 'ai',
						description: 'Your own provider key via the DualTran API credential',
					},
				],
				default: 'google',
			},
			{
				displayName: 'AI Provider',
				name: 'aiProvider',
				type: 'options',
				// Curated built-ins + the models.dev snapshot: one alphabetical list,
				// behind the disabled `Select a provider` placeholder row.
				options: providerOptions(),
				// SPEC 2.1: a fresh install has NO provider until the user chooses one.
				// `required` + the placeholder make the empty state explicit rather than
				// a silent OpenAI default (SPEC 2.1 rule 1).
				default: '',
				required: true,
				// The placeholder the editor shows on the empty picker (SPEC 2.1 rule 2).
				placeholder: PROVIDER_PLACEHOLDER,
				// Rule 5: the picker (the node's primary AI setting) shows the very
				// message a run raises while no provider is selected.
				description: PROVIDER_REQUIRED_ERROR,
				displayOptions: { show: { engine: ['ai'] } },
			},
			{
				// Empty and disabled until a provider is chosen: loadOptions.getModels
				// returns [] for provider "" and n8n shows PROVIDER_REQUIRED_FOR_MODEL.
				displayName: 'AI Model Name or ID',
				name: 'aiModel',
				type: 'options',
				typeOptions: {
					loadOptionsMethod: 'getModels',
					loadOptionsDependsOn: ['aiProvider'],
				},
				default: '',
				// SPEC 2.1 rule 3: the label n8n shows while the picker is empty —
				// the provider-required message, not a stale model list.
				placeholder: PROVIDER_REQUIRED_FOR_MODEL,
				displayOptions: { show: { engine: ['ai'] } },
				description:
					'Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>',
			},
			{
				displayName: 'Endpoint',
				name: 'endpoint',
				type: 'string',
				default: '',
				// Value stays empty until a provider is chosen; the bare scheme is
				// the placeholder, never a value (SPEC 2.1 rule 3).
				placeholder: ENDPOINT_PLACEHOLDER,
				displayOptions: { show: { engine: ['ai'] } },
				// The empty state points at the fix; the provider API base lands in the
				// VALUE once a provider is chosen (never in the placeholder).
				description:
					'Provider API base, filled in once you pick a provider; leave empty to use the credential base URL or the provider default',
			},
			{
				displayName: 'Reasoning',
				name: 'reasoning',
				type: 'options',
				// Alphabetical, as n8n's option list lint requires; `lowest` is the default.
				options: [
					{ name: 'Extra High', value: 'xhigh', description: 'Very thorough reasoning' },
					{ name: 'High', value: 'high', description: 'Thorough reasoning; slower' },
					{ name: 'Low', value: 'low', description: 'Light reasoning' },
					{
						name: 'Lowest',
						value: 'lowest',
						description: 'Cheapest reasoning depth the model supports',
					},
					{ name: 'Max', value: 'max', description: 'The model maximum' },
					{ name: 'Medium', value: 'medium', description: 'Balanced reasoning' },
					{ name: 'Minimal', value: 'minimal', description: 'Very little reasoning' },
					{ name: 'None', value: 'none', description: 'No reasoning tokens; fastest' },
				],
				// Disabled while no provider is selected; the stored sentinel stays `lowest`.
				default: 'lowest',
				displayOptions: { show: { engine: ['ai'] } },
				description:
					'How much the model may reason before answering. Lowest resolves to the cheapest depth the model declares; models without reasoning get none.',
			},
		],
	};

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		const items = this.getInputData();
		const operation = this.getNodeParameter('operation', 0) as string;
		const engine = this.getNodeParameter('engine', 0) as 'google' | 'ai';
		const targetLanguage = this.getNodeParameter('targetLanguage', 0) as string;
		const sourceLanguage = this.getNodeParameter('sourceLanguage', 0) as string;

		let ai: AiCredential | null = null;
		let reasoning = '';
		if (engine === 'ai') {
			const selectedProvider = String(this.getNodeParameter('aiProvider', 0, '') ?? '').trim();
			// SPEC 2.1: the node provider is the only provider source on the request
			// path — no implicit OpenAI default. A node saved before 2.1 has its
			// provider stored, so existing workflows keep working; an empty one is
			// handed to runTranslate as the guarded empty state below (inside the
			// item loop, so `Continue On Fail` reports it per item).
			const selectedModel = String(this.getNodeParameter('aiModel', 0, '') ?? '');
			const endpoint = String(this.getNodeParameter('endpoint', 0, '') ?? '');
			reasoning = String(this.getNodeParameter('reasoning', 0, 'lowest') ?? 'lowest');
			if (selectedProvider !== EMPTY_PROVIDER) {
				try {
					const creds = (await this.getCredentials('dualtranApi')) as unknown as AiCredential;
					const provider = selectedProvider;
					const model = selectedModel || String(creds.model ?? '');
					const resolvedEndpoint = resolveEndpoint({
						endpoint,
						credentialBaseURL: String(creds.baseURL ?? ''),
						provider,
						core,
					});
					ai = {
						provider,
						apiKey: creds.apiKey,
						model,
						baseURL: resolvedEndpoint,
						api: providerApiBase(provider, core),
					};
				} catch {
					ai = null; // runTranslate raises the actionable error
				}
			} else {
				// Unconfigured: keep what was stored, add nothing. runTranslate
				// rejects it with PROVIDER_REQUIRED_ERROR before any request.
				ai = { provider: EMPTY_PROVIDER, apiKey: '', model: selectedModel, baseURL: endpoint };
			}
		}

		const returnData: INodeExecutionData[] = [];

		for (let i = 0; i < items.length; i++) {
			try {
				if (operation === 'translate') {
					const text = this.getNodeParameter('text', i) as string;
					const result = await runTranslate({
						core,
						params: {
							texts: [text],
							targetLanguage,
							sourceLanguage,
							engine,
							ai,
							reasoning,
							onError: (error) => {
								throw new NodeOperationError(this.getNode(), error as Error, { itemIndex: i });
							},
						},
					});
					returnData.push({
						json: { translation: result.translations[0] ?? '', targetLanguage: result.targetLanguage },
						pairedItem: i,
					});
				} else {
					const raw = this.getNodeParameter('texts.values', i, []) as Array<{ text: string }>;
					const result = await runTranslate({
						core,
						params: {
							texts: raw.map((entry) => entry.text),
							targetLanguage,
							sourceLanguage,
							engine,
							ai,
							reasoning,
							onError: (error) => {
								throw new NodeOperationError(this.getNode(), error as Error, { itemIndex: i });
							},
						},
					});
					returnData.push({
						json: { translations: result.translations, targetLanguage: result.targetLanguage } as unknown as IDataObject,
						pairedItem: i,
					});
				}
			} catch (error) {
				if (this.continueOnFail()) {
					returnData.push({
						json: { error: (error as Error).message } as unknown as IDataObject,
						pairedItem: i,
					});
					continue;
				}
				throw new NodeOperationError(this.getNode(), error as Error, { itemIndex: i });
			}
		}

		return [returnData];
	}

	methods = {
		loadOptions: {
			/**
			 * Model picker: the snapshot models of the provider selected on the node,
			 * with `Custom model…` last so an unlisted id stays reachable.
			 */
			async getModels(this: ILoadOptionsFunctions): Promise<INodePropertyOptions[]> {
				// No provider yet (fresh install): no model list — the picker is
				// disabled and labelled PROVIDER_REQUIRED_FOR_MODEL.
				const providerId = String(this.getNodeParameter('aiProvider') ?? EMPTY_PROVIDER);
				return modelOptions(providerId) as INodePropertyOptions[];
			},
		},
		credentialTest: {
			/**
			 * The credential's Test button: make one tiny real request through the
			 * bundled core so a bad key/model/provider is caught before a workflow runs.
			 */
			async dualtranAiCredential(
				this: ICredentialTestFunctions,
				credential: ICredentialsDecrypted<ICredentialDataDecryptedObject>,
			) {
				const data = (credential.data ?? {}) as Record<string, string>;
				if (!data.apiKey || data.apiKey.trim() === '') {
					return { status: 'Error' as const, message: 'API key is empty.' };
				}
				if (!data.provider || data.provider.trim() === '') {
					// SPEC 2.1: the deprecated credential provider field is only read
					// when it is set — testing it must not silently probe OpenAI.
					return {
						status: 'Error' as const,
						message: `${PROVIDER_REQUIRED_ERROR} The deprecated provider field on this credential is empty.`,
					};
				}
				if (!data.model || data.model.trim() === '') {
					return { status: 'Error' as const, message: 'Model is empty.' };
				}
				try {
					let received = '';
					const { totalChunks, streamError } = await core.streamChat({
						provider: data.provider,
						apiKey: data.apiKey,
						model: data.model,
						messages: [{ role: 'user', content: 'Reply with the single word: ok' }],
						extra: data.baseURL ? { baseURL: data.baseURL } : {},
						store: null,
						onChunk: (chunk: string) => {
							received += chunk;
						},
					});
					if (streamError) {
						return { status: 'Error' as const, message: core.formatAiError(streamError).message };
					}
					if (totalChunks === 0 && received === '') {
						return { status: 'Error' as const, message: 'The provider returned an empty response.' };
					}
					return { status: 'OK' as const, message: 'Connection established.' };
				} catch (error) {
					return { status: 'Error' as const, message: (error as Error).message };
				}
			},
		},
	};
}
