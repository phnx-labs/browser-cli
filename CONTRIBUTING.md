# Contributing

Bug reports, fixes and new site guides are welcome. For a larger change, open an
issue first so we can agree on the shape before you write it.

## Build and test

You need [Bun](https://bun.sh) and Node 22.5 or newer. Everything goes through
the scripts in `scripts/`:

```sh
bash scripts/install.sh   # install dependencies
bash scripts/test.sh      # command docs freshness, typecheck, tests
bash scripts/build.sh     # compile this platform's binary into dist/
```

Run the binary you built as `dist/<platform>-<arch>/browser`; do not install it
over the `browser` you use day to day. Tests that need a real browser or a
display (`*.live.test.ts`) skip themselves when none is available.

When you change a command's help, run `bash scripts/generate-cli-docs.sh` and
commit the regenerated files in `docs/`; `scripts/test.sh` fails while they are
stale. More detail is in [docs/development.md](docs/development.md).

## Pull requests

- One change per PR, based on `main`, with a title that says what it does.
- Say what changed for the user and how you checked it: paste the command you
  ran and its output, or a screenshot for anything visual.
- Tests sit beside the code they cover (`foo.ts`, `foo.test.ts`) and drive real
  processes, sockets and browsers rather than mocks. Add one that fails without
  your fix.
- `bash scripts/test.sh` passes, which is what CI runs. The comment budget in
  `scripts/comment-budget.json` may not grow: prefer a clear name to a comment.
- Update `CHANGELOG.md` for anything a user would notice, and the skill under
  `skills/browser/` when an agent should use the CLI differently.

Security problems go by email, not in an issue or PR: see
[SECURITY.md](SECURITY.md).
