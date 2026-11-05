#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
comment_args=(--check)
if [ -n "${COMMENT_BASE_SHA:-}" ]; then comment_args+=(--base "$COMMENT_BASE_SHA"); fi
bun scripts/comment-lines.ts "${comment_args[@]}"
bash scripts/generate-cli-docs.sh --check
bunx --no-install tsc --noEmit
node_modules/.bin/bun test "$@"
