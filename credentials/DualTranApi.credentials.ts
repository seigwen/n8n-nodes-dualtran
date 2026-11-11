import type { ICredentialType, Icon, INodeProperties } from 'n8n-workflow';

export class DualTranApi implements ICredentialType {
	name = 'dualtranApi';

	displayName = 'DualTran API';

	icon: Icon = { light: 'file:../icons/dualtran.svg', dark: 'file:../icons/dualtran.dark.svg' };

	documentationUrl = 'https://github.com/seigwen/n8n-nodes-dualtran#readme';

	properties: INodeProperties[] = [
		{
			displayName: 'API Key',
			name: 'apiKey',
			type: 'string',
			typeOptions: { password: true },
			default: '',
			description: 'Your own API key for the selected provider (BYOK)',
		},
		{
			displayName: 'Base URL',
			name: 'baseURL',
			type: 'string',
			default: '',
			description:
				'Optional endpoint override (proxies, OpenAI-compatible servers). The node Endpoint field, when set, wins',
		},
		{
			displayName: 'Provider (Deprecated)',
			name: 'provider',
			type: 'string',
			default: 'openai',
			description:
				'DEPRECATED — kept so existing workflows keep working. Set the provider on the node instead; this value is only used when the node provider is empty',
		},
		{
			displayName: 'Model (Deprecated)',
			name: 'model',
			type: 'string',
			default: '',
			description:
				'DEPRECATED — kept so existing workflows keep working. Set the model on the node instead; this value is only used when the node model is empty',
		},
	];
}
