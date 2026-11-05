#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
skip_tests=false
targets=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --skip-tests) skip_tests=true ;;
    --all) targets="darwin-arm64 darwin-x64 linux-arm64 linux-x64 win32-x64" ;;
    --target) shift; targets="${1:?--target needs platform-arch}" ;;
    *) printf 'Unknown option: %s\n' "$1" >&2; exit 1 ;;
  esac
  shift
done
if [ "$skip_tests" = false ]; then bash scripts/test.sh; fi
[ -n "$targets" ] || targets="$(node -p 'process.platform + "-" + process.arch')"
for target in $targets; do
  case "$target" in
    darwin-arm64|darwin-x64|linux-arm64|linux-x64|win32-x64) ;;
    *) printf 'Unsupported target: %s\n' "$target" >&2; exit 1 ;;
  esac
  bun_target="bun-${target/win32/windows}"
  if [ "$target" = linux-x64 ] || [ "$target" = win32-x64 ]; then bun_target="$bun_target-baseline"; fi
  suffix=""
  [ "$target" != win32-x64 ] || suffix=".exe"
  mkdir -p "dist/$target"
  node_modules/.bin/bun build src/index.ts --compile --bytecode --minify --sourcemap=none \
    --no-compile-autoload-dotenv --no-compile-autoload-bunfig --define BROWSER_COMPILED=true \
    --target="$bun_target" --outfile="dist/$target/browser$suffix"
  node scripts/package.mjs "$target"
done
