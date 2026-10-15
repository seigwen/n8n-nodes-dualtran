import { configWithoutCloudSupport } from '@n8n/node-cli/eslint';

// Cloud compatibility checks are intentionally OFF for now: n8n Cloud
// verification is deferred (plan 64 — self-hosted first; see docs/SUBMISSION.md).
// The cloud ruleset additionally forbids runtime dependencies and Node globals,
// which the bundled-core design relies on until the Cloud refactor.
export default [
	...configWithoutCloudSupport,
	{
		// Tests and tooling are not part of the shipped package.
		ignores: ['tests/**', 'dist/**', 'scripts/**'],
	},
];
