/**
 * Conformance self-check (SPEC 2.1.0) — the `conformance.json` contract and the
 * live node description, checked in the same process the tests run in.
 *
 * The shared kit (`.conformance-kit/run.mjs`) validates the payload it gets from
 * `payloadCommand`; this module does the same work in-process so a test can
 * fail fast on the same contract, and adds the checks the generic validator
 * cannot know about (catalogue ↔ snapshot agreement, loadOptions coverage).
 * The kit modules are passed in (see run-conformance.mjs) so this file does not
 * hard-code how they are loaded.
 */

interface Check {
	name: string;
	ok: boolean;
	detail?: string;
}

export interface Kit {
	selfTest(): number;
	validatePayload(payload: unknown, config: unknown): { host: string; languages: number; providers: number; spec: string };
	scanFiles?(root: string, config: unknown): unknown[];
}

const labels = (options: Array<{ label?: string; value?: string; name?: string }>) =>
	options.map((option) => String(option.label ?? option.name ?? option.value ?? ''));

/** Intl collation, exactly like the kit's `assertSortedByLabel`. */
const compare = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });

export function checkCatalogue(payload: any, config: any): Check[] {
	const checks: Check[] = [];

	const providerOptions = payload.provider?.options ?? [];
	const catalogue = providerOptions.filter((option: any) => option.source !== 'custom');
	const custom = providerOptions.filter((option: any) => option.source === 'custom');
	const nonCustomLabels = labels(catalogue);
	const sorted = nonCustomLabels.every(
		(label: string, index: number) => index === 0 || compare.compare(nonCustomLabels[index - 1], label) <= 0,
	);
	checks.push({
		name: 'provider list is one alphabetical list',
		ok: sorted,
		detail: sorted ? undefined : nonCustomLabels.join(' > '),
	});
	checks.push({
		name: 'Custom… is the last provider entry',
		ok: custom.length > 0 && providerOptions[providerOptions.length - 1].source === 'custom',
	});
	checks.push({
		name: 'provider list mixes curated built-ins with the models.dev snapshot',
		ok: catalogue.some((option: any) => option.source === 'built-in') &&
			catalogue.some((option: any) => option.source === 'models.dev'),
	});

	// Alias twins are deduped: an alias id and its canonical id never coexist.
	const ids = new Set(providerOptions.map((option: any) => option.value));
	checks.push({
		name: 'alias twins are deduped (id and canonical id never coexist)',
		ok: !([...ids].some((id) => id === 'google-gemini' && ids.has('google'))),
	});

	// Every provider's models come from the same snapshot, alphabetical, Custom… last.
	const isCustomModel = (option: { label?: string; value?: string }) =>
		/^custom/i.test(String(option.value ?? '')) || /^custom/i.test(String(option.label ?? ''));
	const modelProblems: string[] = [];
	for (const [providerId, options] of Object.entries(payload.model?.loadOptions ?? {})) {
		const list = options as Array<{ label: string; value: string }>;
		const catalogueOptions = list.filter((option) => !isCustomModel(option));
		const customEntries = list.filter(isCustomModel);
		if (customEntries.length !== 1 || !isCustomModel(list[list.length - 1])) {
			modelProblems.push(`${providerId}: custom model entry is not last`);
		}
		const names = labels(catalogueOptions);
		const ids = catalogueOptions.map((option) => option.value);
		const ordered = names.every(
			(label, index) => index === 0 || compare.compare(names[index - 1], label) <= 0,
		);
		if (!ordered) modelProblems.push(`${providerId}: models not alphabetical`);
		for (const option of catalogueOptions) {
			if (!option.value) modelProblems.push(`${providerId}: model without an id`);
		}
		if (new Set(ids).size !== ids.length) modelProblems.push(`${providerId}: duplicate model ids`);
		const snapshot = payload.model.byProvider[providerId] ?? [];
		if (ids.length !== snapshot.length || JSON.stringify(ids) !== JSON.stringify(snapshot.map((m: any) => m.value))) {
			modelProblems.push(`${providerId}: loadOptions differs from the snapshot`);
		}
	}
	checks.push({
		name: 'loadOptions returns the snapshot models per provider (Custom… last)',
		ok: Object.keys(payload.model?.loadOptions ?? {}).length > 0 && modelProblems.length === 0,
		detail: modelProblems.join('; ') || undefined,
	});
	checks.push({
		name: 'model options load through methods.loadOptions',
		ok: payload.model?.loadOptionsMethod === 'getModels',
	});

	// R3: the endpoint is a text field the execution fills when empty.
	checks.push({
		name: 'endpoint is a text field with an empty default',
		ok: payload.endpoint?.control === 'text' && payload.endpoint?.default === '',
	});

	// R4: the picker offers the sentinel first and `lowest` is the default.
	const reasoningOptions = labels(payload.reasoning?.options ?? []);
	checks.push({
		name: 'reasoning picker offers the lowest sentinel and defaults to it',
		ok: reasoningOptions.includes('Lowest') && payload.reasoning?.default === 'lowest',
	});

	// R5: the platform has no node-UI i18n; strings live in description fields.
	const declaredR5 = (config.platformLimits ?? []).some((limit: any) => limit.rule === 'R5');
	checks.push({
		name: 'node-UI i18n declared as a platform limit, strings in description fields',
		ok: declaredR5 && (payload.i18n?.keys ?? []).length > 0 && (payload.i18n?.fields ?? 0) === payload.i18n.keys.length,
	});

	return checks;
}

/** Validate the payload with the shared kit, then fail on the extra checks. */
export function runConformance(
	kit: Kit,
	payload: any,
	config: any,
): { summary: any; checks: Check[] } {
	const summary = kit.validatePayload(payload, config);
	const checks = checkCatalogue(payload, config);
	const failed = checks.filter((check) => !check.ok);
	if (failed.length) {
		throw new Error(
			`conformance: ${failed.length} check(s) failed\n` +
				failed.map((check) => ` - ${check.name}${check.detail ? `: ${check.detail}` : ''}`).join('\n'),
		);
	}
	return { summary, checks };
}
