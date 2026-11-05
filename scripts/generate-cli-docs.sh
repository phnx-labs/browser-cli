#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec "$SCRIPT_DIR/../node_modules/.bin/bun" "$SCRIPT_DIR/gen-docs.ts" "$@"
