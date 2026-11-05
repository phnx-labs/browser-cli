#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
bun install
printf 'Dependencies installed. Build with scripts/build.sh; run dist/<platform>-<arch>/browser for development.\n'
