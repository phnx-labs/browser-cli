#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
tools=bench/.work/tools
mkdir -p "$tools"

BROWSER_USE_VERSION=${BROWSER_USE_VERSION:-0.13.14}
BROWSER_HARNESS_VERSION=${BROWSER_HARNESS_VERSION:-0.1.13}
AGENT_BROWSER_VERSION=${AGENT_BROWSER_VERSION:-0.41.2}
CHROME_VERSION=${CHROME_VERSION:-153.0.8010.36}

bash scripts/install.sh
bash scripts/build.sh --skip-tests

uv venv -q --allow-existing -p 3.12 "$tools/browser-use"
VIRTUAL_ENV="$tools/browser-use" uv pip install -q "browser-use==$BROWSER_USE_VERSION"
uv venv -q --allow-existing -p 3.12 "$tools/browser-harness"
VIRTUAL_ENV="$tools/browser-harness" uv pip install -q "browser-harness==$BROWSER_HARNESS_VERSION"
npm install --silent --no-save --prefix "$tools/agent-browser" "agent-browser@$AGENT_BROWSER_VERSION"

if [ -n "${BENCH_CHROME:-}" ]; then
  printf '%s\n' "$BENCH_CHROME" > "$tools/chrome-path"
else
  npx --yes @puppeteer/browsers install "chrome@$CHROME_VERSION" --path "$tools/chrome" \
    | awk '{print $2}' | tail -1 | xargs realpath > "$tools/chrome-path"
fi
echo "Chrome: $(cat "$tools/chrome-path")"
bun bench/run.ts check
