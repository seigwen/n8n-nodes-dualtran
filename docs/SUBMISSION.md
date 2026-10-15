# Publishing n8n-nodes-dualtran

Status: prepared; publishing is the maintainer's action (npm account for the
community registry; n8n Creator Portal for Cloud verification).

## Pre-flight checklist

- [ ] `npm run verify` green (vitest + n8n-node build + n8n-node lint).
- [ ] `node scripts/sync-core.mjs` run after any core change (stages
      `dualtran-core/`, which ships inside the package — no file: dependency).
- [ ] Version bumped in package.json + CHANGELOG.md entry.
- [ ] `npm pack` dry-run: the tarball must contain `dist/`, `dualtran-core/`,
      `icons/` only (the `files` allowlist).
- [ ] README has installation + usage for self-hosted n8n.

## Publish (community nodes, self-hosted)

```bash
npm login                 # your account
npm publish               # public package: n8n-nodes-dualtran
```

Self-hosted users then install it from Settings → Community nodes.
Verify on https://www.npmjs.com/package/n8n-nodes-dualtran.

## n8n Cloud (verified community nodes — optional, later)

Requires: public GitHub repo, **npm provenance** (GitHub Actions publishing —
template already in `.github/workflows/release.yml`), and submission via the
n8n Creator Portal for review. Do this after the self-hosted release is
battle-tested.

## Container smoke (what CI cannot fully do here)

`docker run n8nio/n8n` (SQLite) → install the packed tarball into
`~/.n8n/nodes` → assert the node + credential load and one real workflow
executes a Google translation. Runbook in this repository's CI notes; the
step is documented for manual re-runs.
