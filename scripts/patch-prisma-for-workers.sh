#!/usr/bin/env bash
# Patch the Prisma-generated client so it can run inside Cloudflare Workers
# where import.meta.url is undefined in bundled modules and the Node-only
# runtime (@prisma/client/runtime/client) must be swapped for the edge
# runtime (@prisma/client/runtime/wasm-compiler-edge).
#
# Run after `npx prisma generate`.

set -euo pipefail

GEN_DIR="src/generated/prisma"

if [ ! -d "$GEN_DIR" ]; then
  echo "⚠️  $GEN_DIR not found — skipping patch"
  exit 0
fi

# 1. Guard the fileURLToPath(import.meta.url) call in client.ts
sed -i.bak \
  "s|globalThis\['__dirname'\] = path.dirname(fileURLToPath(import.meta.url))|globalThis['__dirname'] = typeof import.meta.url === 'string' ? path.dirname(fileURLToPath(import.meta.url)) : '/'|" \
  "$GEN_DIR/client.ts"
rm -f "$GEN_DIR/client.ts.bak"

# 2. Swap the Node runtime for the edge/wasm runtime in all generated files
find "$GEN_DIR" -name '*.ts' -exec sed -i.bak \
  's|@prisma/client/runtime/client|@prisma/client/runtime/wasm-compiler-edge|g' {} +
find "$GEN_DIR" -name '*.bak' -delete

echo "✅  Patched $GEN_DIR for Cloudflare Workers compatibility"
