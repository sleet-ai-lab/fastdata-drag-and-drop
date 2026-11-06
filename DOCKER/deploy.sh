#!/usr/bin/env bash
# ========================================
# deploy — rebuild the image and roll the stack.
#
# run it after EVERY change, so what you test is always what is
# committed:
#
#   ./DOCKER/deploy.sh
#
# it:
#   1. runs the tests, so a broken build never reaches the tunnel
#   2. rebuilds the image from the current working tree
#   3. rolls the compose stack
#   4. waits for the frontend to be healthy
#   5. checks the live site actually serves the new bundle
#
# the last step matters: the bundle filename carries a content hash,
# so comparing it against the local build proves the deployed site is
# the current code and not a stale image.
# ========================================
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
COMPOSE_FILE="${REPO_ROOT}/DOCKER/docker-compose.yml"
SITE_URL="${FASTDATA_SITE_URL:-https://fastdata-drag-and-drop.shit-1170.com/}"

cd "${REPO_ROOT}"

echo "==> tests"
bun run test

echo "==> local build (for the bundle hash check)"
bun run build

echo "==> building the image"
docker compose -f "${COMPOSE_FILE}" build

echo "==> rolling the stack"
docker compose -f "${COMPOSE_FILE}" up -d

echo "==> waiting for the frontend to be healthy"
# the compose file already has a healthcheck and the cloudflare
# service waits on it, so `up -d` already waited. this is the belt to
# that braces: we do not return until the container reports healthy.
for _ in $(seq 1 60); do
  state="$(docker inspect \
    --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' \
    fastdata-drag-and-drop-frontend 2>/dev/null || echo "missing")"
  if [ "${state}" = "healthy" ]; then
    break
  fi
  sleep 1
done

state="$(docker inspect \
  --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' \
  fastdata-drag-and-drop-frontend 2>/dev/null || echo "missing")"
if [ "${state}" != "healthy" ]; then
  echo "!! the frontend is '${state}', not healthy. recent logs:" >&2
  docker logs --tail 30 fastdata-drag-and-drop-frontend >&2 || true
  exit 1
fi
echo "    healthy"

echo "==> checking the live site serves the current bundle"
local_bundle="$(ls dist/assets/*.js 2>/dev/null | head -1 | xargs -r basename)"
if [ -z "${local_bundle}" ]; then
  echo "!! no local bundle in dist/. run the build first." >&2
  exit 1
fi
remote_bundle="$(curl -sS --max-time 25 "${SITE_URL}" | grep -oE 'index-[A-Za-z0-9_-]+\.js' | head -1)"
if [ "${remote_bundle}" != "${local_bundle}" ]; then
  echo "!! the live site serves '${remote_bundle}' but the local build is '${local_bundle}'." >&2
  echo "!! the deployed image is stale." >&2
  exit 1
fi
echo "    live: ${remote_bundle} (matches the local build)"

echo
echo "deployed: ${SITE_URL}"
# ========================================
