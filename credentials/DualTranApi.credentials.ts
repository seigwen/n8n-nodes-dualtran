import type { ICredentialType, Icon, INodeProperties } from 'n8n-workflow';

export class DualTranApi implements ICredentialType {
	name = 'dualtranApi';

	displayName = 'DualTran API';

	icon: Icon = { light: 'file:../icons/dualtran.svg', dark: 'file:../icons/dualtran.dark.svg' };

	documentationUrl = 'https://github.com/seigwen/n8n-nodes-dualtran#readme';

	properties: INodeProperties[] = [
		{
			displayName: 'Provider',
			name: 'provider',
			type: 'string',
			default: 'openai',
			description:
				'Provider id understood by DualTran (openai, anthropic, google, deepseek, mistral, groq, xai, …)',
		},
		{
			displayName: 'API Key',
			name: 'apiKey',
			type: 'string',
			typeOptions: { password: true },
			default: '',
			description: 'Your own API key for the selected provider (BYOK)',
		},
		{
			displayName: 'Model',
			name: 'model',
			type: 'string',
			default: '',
			description: 'Model id passed to the provider (e.g. gpt-4o-mini, claude-3-5-haiku-latest)',
		},
		{
			displayName: 'Base URL',
			name: 'baseURL',
			type: 'string',
			default: '',
			description: 'Optional endpoint override (proxies, OpenAI-compatible servers)',
		},
	];
}
