#!/usr/bin/env bash
# End-to-end Docker integration check for the data builder.
#
# Builds the image, starts a single container, waits for the health
# endpoint, and tears everything down. Prints "OK" on success.
# No Redis, no extra services — the builder schedules itself in-process.
#
# Usage: bash packages/data/scripts/integration-docker.sh
#        (run from the monorepo root)

set -euo pipefail

IMAGE="geomark-data:integration-test"
APP_NAME="geomark-test-data"
PORT="4199"

cleanup() {
  docker rm -f "$APP_NAME" >/dev/null 2>&1 || true
}
trap cleanup EXIT

echo "==> Building image"
docker build -f packages/data/Dockerfile -t "$IMAGE" . >/dev/null

echo "==> Starting geomark-data"
# OPENADDRESSES_URL is required; we point at an unreachable host so the
# initial build will fail fast — but the file server still comes up and
# /health responds, which is what this smoke test validates.
docker run -d --name "$APP_NAME" \
  -e OUTPUT_DIR="/tmp/data" \
  -e OPENADDRESSES_URL="https://example.invalid/openaddresses-test.zip" \
  -e REFRESH_INTERVAL_DAYS="30" \
  -p "${PORT}:3000" \
  "$IMAGE" >/dev/null

echo "==> Waiting for /health"
ok=0
for _ in $(seq 1 20); do
  code=$(curl -s -o /dev/null -w "%{http_code}" "http://localhost:${PORT}/health" || true)
  if [ "$code" = "200" ]; then
    ok=1
    break
  fi
  sleep 1
done

if [ "$ok" -ne 1 ]; then
  echo "FAIL: /health did not return 200 within 20s"
  echo "==== container logs ===="
  docker logs "$APP_NAME" 2>&1 | tail -20
  exit 1
fi

echo "==> /health responded:"
curl -s "http://localhost:${PORT}/health"
echo ""
echo "==> /latest.json (expected 404 before first build):"
curl -s -w "HTTP %{http_code}\n" "http://localhost:${PORT}/latest.json"

echo ""
echo "OK"
