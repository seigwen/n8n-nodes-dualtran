import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { Dualtran } from '../nodes/Dualtran/Dualtran.node';

const ROOT = path.resolve(__dirname, '..');

describe('n8n package contract', () => {
	it('declares the community-node metadata', () => {
		const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
		expect(pkg.name).toBe('n8n-nodes-dualtran');
		expect(pkg.keywords).toContain('n8n-community-node-package');
		expect(pkg.n8n.n8nNodesApiVersion).toBe(1);
		expect(pkg.n8n.nodes).toEqual(['dist/nodes/Dualtran/Dualtran.node.js']);
		expect(pkg.n8n.credentials).toEqual(['dist/credentials/DualTranApi.credentials.js']);
		expect(pkg.files).toContain('dist');
		expect(pkg.files).toEqual(['dist', 'icons']);
		expect(pkg.dependencies ?? {}).toEqual({});
		expect(pkg.peerDependencies['n8n-workflow']).toBe('*');
	});

	it('the source tree carries the node, the credential and the icons', () => {
		for (const rel of [
			'nodes/Dualtran/Dualtran.node.ts',
			'nodes/Dualtran/translate.ts',
			'credentials/DualTranApi.credentials.ts',
			'icons/dualtran.svg',
			'icons/dualtran.dark.svg',
		]) {
			expect(fs.existsSync(path.join(ROOT, rel)), rel).toBe(true);
		}
	});

	it('the node wires the credential and both operations', () => {
		const source = fs.readFileSync(path.join(ROOT, 'nodes/Dualtran/Dualtran.node.ts'), 'utf8');
		expect(source).toContain("name: 'dualtranApi'");
		expect(source).toContain("value: 'translateBatch'");
		expect(source).toContain('continueOnFail');
	});

	it('the description exposes the catalogue-backed pickers and the AI fields', () => {
		const node = new Dualtran();
		const byName = new Map(node.description.properties.map((property) => [property.name, property]));
		const expectType = (name: string, type: string) => expect((byName.get(name) as any)?.type, name).toBe(type);

		expectType('targetLanguage', 'options');
		expectType('sourceLanguage', 'options');
		expectType('aiProvider', 'options');
		expectType('aiModel', 'options');
		expectType('endpoint', 'string');
		expectType('reasoning', 'options');

		expect((byName.get('aiProvider') as any).default).toBe('openai');
		expect((byName.get('endpoint') as any).default).toBe('');
		expect((byName.get('reasoning') as any).default).toBe('lowest');
		expect((byName.get('aiModel') as any).default).toBe('');
		expect((byName.get('targetLanguage') as any).default).toBe('en');
		// The model picker is loaded per provider, never hard-coded.
		expect((byName.get('aiModel') as any).typeOptions.loadOptionsMethod).toBe('getModels');
		expect(typeof node.methods.loadOptions.getModels).toBe('function');
	});

	it('the generated catalogue ships next to package.json', () => {
		const catalog = JSON.parse(fs.readFileSync(path.join(ROOT, 'catalog.json'), 'utf8'));
		expect(catalog.snapshot).toBe('scripts/catalog-sources/models-dev-sample.json');
		expect(catalog.providers.length).toBeGreaterThanOrEqual(20);
		expect(catalog.languages.length).toBeGreaterThanOrEqual(38);
		for (const provider of catalog.providers) {
			expect(provider).toHaveProperty('id');
			expect(provider).toHaveProperty('name');
			expect(provider).toHaveProperty('api');
			expect(provider).toHaveProperty('builtIn');
			expect(Array.isArray(provider.models)).toBe(true);
		}
		expect(fs.existsSync(path.join(ROOT, 'catalog.generated.js'))).toBe(true);
	});
});
