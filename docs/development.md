# Development

## Command reference

```bash
scripts/generate-cli-docs.sh                              # refresh docs/
scripts/generate-cli-docs.sh --check                      # fail on stale docs
scripts/generate-cli-docs.sh --out-dir .agents/scratch/cli-docs  # preview
```

Run after `bun install --frozen-lockfile`. The script works from any directory;
`--out-dir` is relative to your current directory. Open `command-reference.html`
from the output folder to browse the tree and search commands.
CI uploads a `browser-cli-docs` artifact on pull requests and pushes to `main`
or `release/**`. It contains the HTML reference plus Markdown and JSON indexes.
Tests and `scripts/release.sh` check the committed files; commit regenerated
`docs/` with command changes.

Browse the generated [command reference](docs/command-reference.html) or the
[command index](docs/command-index.md) for arguments, options, examples and notes.

## Build, test and release

```sh
bash scripts/install.sh   # install dependencies
bash scripts/test.sh      # typecheck + tests
bash scripts/build.sh     # compile this platform's binary into dist/
```

`scripts/build.sh` compiles `src/` into a minified bytecode binary per target.
`scripts/verify-compiled.mjs` asserts the shipped artifact behaves correctly.
Run `dist/<platform>-<arch>/browser` directly during development.

Release by pushing a `release/<version>` branch whose `package.json` says that
version: `release/0.1.19` publishes 0.1.19 under the `latest` dist-tag, and
`release/0.1.20-pre.1` publishes a prerelease under `pre`. The repository's
script does that from the reviewed `origin/main` commit:

```sh
bash scripts/release.sh            # print the release plan (dry run)
bash scripts/release.sh --confirm  # wait for main CI, push release/<version>, wait for the workflow, check a registry install
```

`.github/workflows/release.yml` runs on that push. npm trusts that workflow in
the `npm-publish` environment (trusted publishing over OIDC), so no npm token is
stored anywhere, and the environment deploys only from `release/*` branches. The
workflow builds and tests nothing: it downloads the `compiled-packages` artifact of
main's successful `test.yml` run for the release commit, refuses when that run or
artifact is missing or the download's sha256 differs from the digest GitHub
recorded, packs it, verifies packed file lists and immutable package integrity,
publishes, with `--provenance`, the five platform packages at once and, once npm shows all of them,
the launcher, then pushes the version tag and installs the published version
from the registry. The script waits for main CI before pushing the branch, then
installs and checks the release on your machine too. Fetching and packing take
about 22 seconds on a runner; most of a release is npm processing each package
after it accepts it, 1 to 4 minutes for 0.1.34 and 0.1.35. Each of the six packages needs a trusted publisher for
`phnx-labs/browser-cli`, workflow `release.yml`, environment `npm-publish`, with
"Allow npm publish" checked. A run that fails after publishing (the tag push,
say) is safe to rerun with `bash scripts/release.sh --confirm`, which reruns the failed
workflow: published packages are verified, not republished. A stable version
older than the current `latest` is refused, and release branches cannot be
force-pushed or deleted.

Keep credentials out of the binary: it is built from this public source.

