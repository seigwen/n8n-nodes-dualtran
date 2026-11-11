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
	catalogProviders,
	languageOptions,
	modelsForProvider,
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

/** Every user-facing label lives here (n8n has no node-UI i18n API — R5). */
const TEXT = {
	providerCustom: 'Custom…',
	modelCustom: 'Custom model…',
};

/**
 * Provider options: curated built-ins + the models.dev snapshot in ONE
 * alphabetical list (catalog.json, alias twins deduped), `Custom…` last.
 */
function providerOptions(): INodePropertyOptions[] {
	const curated = catalogProviders()
		.slice()
		.sort((a, b) => a.name.localeCompare(b.name, 'en', { numeric: true, sensitivity: 'base' }))
		.map((provider) => ({
			name: provider.name,
			value: provider.id,
			description: provider.api ? `API base: ${provider.api}` : 'API base from the core provider registry',
		}));
	return [
		...curated,
		{
			name: TEXT.providerCustom,
			value: 'custom',
			description: 'OpenAI-compatible server: set the endpoint yourself',
		},
	];
}

/** Model options for one provider: snapshot models, `Custom model…` last. */
function modelOptions(providerId: string): INodePropertyOptions[] {
	return [
		...modelsForProvider(providerId).map((model) => ({
			name: model.label,
			value: model.id,
			...(model.reasoning?.length ? { description: `Reasoning: ${model.reasoning.join(', ')}` } : {}),
		})),
		{
			name: TEXT.modelCustom,
			value: 'custom',
			description: 'Use a model ID that is not in the snapshot',
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
				// Curated built-ins + the models.dev snapshot: one alphabetical list.
				options: providerOptions(),
				default: 'openai',
				displayOptions: { show: { engine: ['ai'] } },
				description: 'Provider that answers the translation',
			},
			{
				displayName: 'AI Model Name or ID',
				name: 'aiModel',
				type: 'options',
				typeOptions: {
					loadOptionsMethod: 'getModels',
					loadOptionsDependsOn: ['aiProvider'],
				},
				default: '',
				displayOptions: { show: { engine: ['ai'] } },
				description:
					'Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>',
			},
			{
				displayName: 'Endpoint',
				name: 'endpoint',
				type: 'string',
				default: '',
				displayOptions: { show: { engine: ['ai'] } },
				description:
					'Provider API base; leave empty to use the credential base URL or the provider default',
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
			const selectedProvider = String(this.getNodeParameter('aiProvider', 0, '') ?? '');
			const selectedModel = String(this.getNodeParameter('aiModel', 0, '') ?? '');
			const endpoint = String(this.getNodeParameter('endpoint', 0, '') ?? '');
			reasoning = String(this.getNodeParameter('reasoning', 0, 'lowest') ?? 'lowest');
			try {
				const creds = (await this.getCredentials('dualtranApi')) as unknown as AiCredential;
				// Node params win; the credential's provider/model stay as fallbacks
				// so existing workflows keep working.
				const provider = selectedProvider || String(creds.provider ?? 'openai');
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
				const providerId = String(this.getNodeParameter('aiProvider') ?? 'openai');
				return modelOptions(providerId);
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
				if (!data.model || data.model.trim() === '') {
					return { status: 'Error' as const, message: 'Model is empty.' };
				}
				try {
					let received = '';
					const { totalChunks, streamError } = await core.streamChat({
						provider: data.provider || 'openai',
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
