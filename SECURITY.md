# Security policy

## Reporting a vulnerability

Email **contact@phoenix.so** with "Browser CLI security" in the subject. Please do
not open a public issue, pull request or discussion for a vulnerability.

Include the version (`browser --version`), your operating system and browser,
and the steps or a proof of concept that reproduce it. We reply by email,
keep you informed while we work on a fix, and credit you in the
[CHANGELOG](CHANGELOG.md) when the fix ships unless you ask us not to.

## Supported versions

Security fixes go into the next release of `@phnx-labs/browser-cli` on npm.
Only the latest published version is supported; check it with
`npm view @phnx-labs/browser-cli version` and upgrade with
`npm install -g @phnx-labs/browser-cli@latest`.

## Threat model

- **It acts as you.** Browser CLI drives a browser profile that may be signed
  in to your accounts. Anything that can run `browser` as your user can read
  and act on every site that profile can reach. Give agents a dedicated
  profile when they should not see your personal accounts.
- **Local by default.** The service listens on a Unix socket in
  `~/.agents/browser/run/`, a directory only your user can open (a named pipe
  owned by your user on Windows). It reaches browsers over their local DevTools
  or WebDriver BiDi ports, or Arc's Apple Events on macOS.
- **Remote control is off until you turn it on.** A `browser` command sent
  from another machine (`start --device`, or through agents-cli) is refused
  unless you ran `browser remote-control on` on the machine whose browser it
  would drive. This is consent for commands that Browser CLI or agents-cli
  forwards, not access control: anyone who can log in to that machine as you
  can run `browser` there directly. Remote commands travel over your own SSH
  configuration, or over an HTTPS relay only when you set `BROWSER_RELAY_URL`
  and `BROWSER_RELAY_TOKEN`.
- **No telemetry.** Browser CLI reports nothing to us or to any other service.
  Its network traffic goes to the browsers and machines you point it at, with
  one exception: the first time a recording needs ffmpeg and finds none, it
  installs ffmpeg with the system package manager (brew, winget, apt and
  others, through `sudo -n` when not root) or, failing that, runs
  `npm install ffmpeg-static` into `~/.agents/.cache/ffmpeg`.
- **What it stores.** Everything is under `~/.agents/browser/` (or
  `$AGENTS_HOME/browser/`): profile definitions (`profiles/`, `local/`), the
  remote-control setting (`local/settings.yaml`), the browser data directories
  it launched, screenshots, recordings and network captures (`cache/`), kept
  sign-ins (`logins/`), task history (`data/history.db`, 365 days) and logs
  (`logs/`, URLs without query strings or fragments). Treat the folder as
  sensitive: captures and browser data can hold page content and cookies.
- **Credentials.** `browser type --secret <bundle>/<KEY>` types a value read
  from the `secrets` tool without printing it; Browser CLI stores no passwords
  of its own.

## What is in scope

Browser CLI drives browsers that are signed in as you, so these matter most:

- The local IPC service and anything that lets another local user or process
  drive your browser or read its pages, cookies or captures.
- Remote browsers: `start --device` over SSH, and the HTTPS relay
  (`BROWSER_RELAY_URL`, `BROWSER_RELAY_TOKEN`).
- Profile, history and capture data under `~/.agents/`.
- The npm packages and their install script (`bin/install.cjs`).

An agent doing what you told it to with your own signed-in browser is the
expected behavior described under "Security and privacy" in the
[README](README.md), not a vulnerability.
