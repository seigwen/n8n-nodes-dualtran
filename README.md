# n8n-nodes-dualtran

The **DualTran** node for n8n: translate text inside your workflows with
**Google** (free, no account) or **your own AI model** (BYOK, 20+ providers) —
powered by `@dualtran/core`, the engine extracted from the
[DualTran browser extension](https://github.com/seigwen/DualTran-extension).

## Operations

- **Translate Text** — translate one text (expressions welcome); output:
  `{ translation, targetLanguage }`.
- **Translate Batch** — translate a list of texts in one batched request;
  output: `{ translations: [...], targetLanguage }`.

Both support **Source Language** (`auto` detects) and **Target Language**.
The Google engine needs no credentials. The **AI (BYOK)** engine uses the
**DualTran API** credential (provider, API key, model, optional base URL) —
your key, sent only to your provider.

## Install

### Self-hosted n8n

Settings → Community nodes → Install → `n8n-nodes-dualtran`
(or `npm install n8n-nodes-dualtran` into `~/.n8n/nodes` on your instance).

### Development

```bash
node scripts/sync-core.mjs   # stages dualtran-core/ (CJS + ESM core builds)
npm install
npm test                     # vitest: translate logic + static contract + real core integration
npm run build                # n8n-node build → dist/
npm run lint                 # n8n-node lint
npm run verify               # test + build + lint
```

## Node reference

| Field | Notes |
|---|---|
| Operation | Translate Text / Translate Batch |
| Text(s) | Supports n8n expressions — chain from previous nodes |
| Target / Source Language | Language codes; `auto` for detection |
| Engine | Google (default) / AI (BYOK) |
| DualTran API credential | Optional; required for the AI engine |

On failure the node honours **Continue On Fail** (emits `{ error }` and keeps
the workflow running) or throws a node error with the item index.

## License

MIT — the bundled `@dualtran/core` portion is MPL-2.0.

## Languages

The engine itself has no interface: strings this package exposes are MCP tool
names/descriptions and parameter docs, which LLM clients and protocol tooling
consume in English. Localising them would hurt discoverability, so they stay
English by policy. Any future user-facing surface must follow the DualTran i18n
standard (38 catalogues, `locales/<code>/messages.json`).
