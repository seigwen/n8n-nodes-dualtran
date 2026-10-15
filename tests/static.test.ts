import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

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
});
