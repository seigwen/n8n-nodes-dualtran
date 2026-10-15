#!/usr/bin/env bash
# Container smoke (plan 64 B3 / D4): real n8n (Docker) + the packed community
# node + one real workflow execution translating with the Google engine.
#
# Recipe notes (validated):
# - The container runs idle (entrypoint overridden) — n8n CLI commands are run
#   as one-shot execs, each owning the SQLite DB. A running n8n server would
#   hold the DB lock AND occupy the task-runner broker port, breaking the CLI.
# - The workflow carries a fixed id, so no id parsing is needed.
# - --legacy-peer-deps keeps npm from auto-installing the n8n-workflow peer
#   tree (n8n provides it at runtime).
#
# Usage: bash scripts/container-smoke.sh   (needs Docker + network)
set -euo pipefail
cd "$(dirname "$0")/.."

IMAGE="${N8N_IMAGE:-n8nio/n8n:2.43.4}"
NAME="dt-n8n-smoke"
WORKFLOW_ID="DTSMOKE1"
TMP="$(mktemp -d)"
trap 'docker rm -f "$NAME" >/dev/null 2>&1 || true; rm -rf "$TMP"' EXIT

echo "[smoke] building + packing the node package…"
node scripts/build.mjs >/dev/null
npm pack --pack-destination "$TMP" >/dev/null
PKG="$(ls "$TMP"/n8n-nodes-dualtran-*.tgz)"
echo "[smoke] package: $PKG"

cat > "$TMP/workflow.json" <<JSON
{
  "id": "$WORKFLOW_ID",
  "name": "dualtran smoke",
  "nodes": [
    {"parameters": {}, "id": "t1", "name": "Trigger", "type": "n8n-nodes-base.manualTrigger", "typeVersion": 1, "position": [0, 0]},
    {"parameters": {"operation": "translate", "text": "hello world", "targetLanguage": "fr", "sourceLanguage": "auto", "engine": "google"}, "id": "d1", "name": "DualTran", "type": "n8n-nodes-dualtran.dualtran", "typeVersion": 1, "position": [220, 0]}
  ],
  "connections": {"Trigger": {"main": [[{"node": "DualTran", "type": "main", "index": 0}]]}},
  "settings": {}
}
JSON

echo "[smoke] starting $IMAGE (idle container) …"
docker rm -f "$NAME" >/dev/null 2>&1 || true
docker run -d --name "$NAME" --entrypoint sh "$IMAGE" -c 'sleep infinity' >/dev/null

docker cp "$PKG" "$NAME:/tmp/pkg.tgz"
docker cp "$TMP/workflow.json" "$NAME:/tmp/workflow.json"

echo "[smoke] installing the package into ~/.n8n/nodes …"
docker exec "$NAME" sh -lc 'mkdir -p /home/node/.n8n/nodes && cd /home/node/.n8n/nodes && npm install --no-audit --no-fund --legacy-peer-deps /tmp/pkg.tgz' >/dev/null
docker exec "$NAME" sh -lc 'test -f /home/node/.n8n/nodes/node_modules/n8n-nodes-dualtran/dist/nodes/Dualtran/Dualtran.node.js' \
  || { echo "[smoke] FAIL: node file missing after install"; exit 1; }

echo "[smoke] importing + running the workflow (Google engine, hello world → fr) …"
IMPORT_OUT="$(docker exec "$NAME" n8n import:workflow --input=/tmp/workflow.json 2>&1)"
echo "$IMPORT_OUT" | grep -qi "successfully imported" || { echo "[smoke] FAIL: import"; echo "$IMPORT_OUT" | tail -10; exit 1; }

RUN_OUT="$(docker exec "$NAME" n8n execute --id "$WORKFLOW_ID" 2>&1)"
echo "$RUN_OUT" | tail -5

if echo "$RUN_OUT" | grep -q '"translation": "Bonjour le monde"'; then
  echo "[smoke] PASS — real n8n workflow translated: Bonjour le monde"
else
  echo "[smoke] FAIL: expected translation not found in the execution output"
  exit 1
fi
