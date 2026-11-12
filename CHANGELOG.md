# Changelog

All notable changes to this n8n community node package are documented here.

## Unreleased — SPEC 2.1

- A fresh install has **no AI provider** (`aiProvider` default `""`), not
  `openai`. The picker shows a disabled, selected *Select a provider*
  placeholder; the model picker is empty and disabled, the endpoint keeps an
  empty value with the `https://` placeholder, and reasoning stays at the
  `lowest` sentinel but is disabled.
- Choosing a provider fills the endpoint **value** with the provider API base
  and enables the model and reasoning pickers; a user-edited endpoint is never
  overwritten. The empty state is not reachable again once configured.
- Running an AI translation without a provider now raises
  *Choose an AI provider in settings before translating.* and makes no network
  request — the `|| 'openai'` fallbacks on the request path and in the
  credential test are gone. A node saved before this release keeps its stored
  provider, so existing workflows are unaffected.
- Adds the `providerPlaceholder`, `providerRequiredForModel` and
  `providerRequiredError` strings (English literals — n8n has no node-UI i18n
  API, see `conformance.json` R5) and moves the conformance kit / payload to
  SPEC 2.1.0.

## 0.1.0

- Initial release: the DualTran node with Translate and Translate Batch
  operations (Google free engine or AI BYOK via the DualTran API credential),
  plus the DualTran API credential type.
