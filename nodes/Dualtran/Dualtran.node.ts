import {
	NodeConnectionTypes,
	NodeOperationError,
	type ICredentialDataDecryptedObject,
	type ICredentialTestFunctions,
	type ICredentialsDecrypted,
	type IDataObject,
	type IExecuteFunctions,
	type INodeExecutionData,
	type INodeType,
	type INodeTypeDescription,
} from 'n8n-workflow';
import * as coreNamespace from 'dualtran';
import { runTranslate, type AiCredential, type CoreLike } from './translate';

// The core is inlined into dist at build time (scripts/build.mjs), so the
// installed package has no runtime dependencies.
const core = coreNamespace as unknown as CoreLike;

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
				type: 'string',
				default: 'en',
				description: 'Language code to translate into (en, zh-CN, ja, …)',
			},
			{
				displayName: 'Source Language',
				name: 'sourceLanguage',
				type: 'string',
				default: 'auto',
				description: 'Language the text is written in — "auto" detects it',
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
		],
	};

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		const items = this.getInputData();
		const operation = this.getNodeParameter('operation', 0) as string;
		const engine = this.getNodeParameter('engine', 0) as 'google' | 'ai';
		const targetLanguage = this.getNodeParameter('targetLanguage', 0) as string;
		const sourceLanguage = this.getNodeParameter('sourceLanguage', 0) as string;

		let ai: AiCredential | null = null;
		if (engine === 'ai') {
			try {
				const creds = (await this.getCredentials('dualtranApi')) as unknown as AiCredential;
				ai = { provider: creds.provider, apiKey: creds.apiKey, model: creds.model, baseURL: creds.baseURL ?? '' };
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
						params: { texts: [text], targetLanguage, sourceLanguage, engine, ai },
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
