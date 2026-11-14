# browser-cli ↔ agents-cli integration contract

browser-cli is a standalone binary. It has **no runtime dependency on
agents-cli**: it never imports it, never spawns `agents`, and never reads the
fleet device registry or the session database. Everything agents-cli knows and
browser-cli needs crosses one of the four interfaces below.

Changing a shape here is a breaking change for the agents-cli adapter.

## 1. Inherited context FD: agents to browser

agents-cli resolves the SSH target and session identity,
then hands them over as **one JSON document on an inherited file descriptor**.

```
BROWSER_CONTEXT_FD=<n>
```

The document is read once, before command parsing, and cached for the process lifetime. A
malformed document is a hard error; an **absent** one is the normal standalone case.

```jsonc
{
  "version": 1,
  "target": {
    "alias": "laptop",
    "host": "user@100.x.y.z",
    "user": "user",
    "hostname": "100.x.y.z",
    "platform": "darwin",
    "sshArgs": ["-i", "/home/u/.ssh/id_agents"]
  },
  "session": { "sessionId": "…", "launchId": "…", "actor": "claude" },
  "remoteControl": { "allowed": true }
}
```

`remoteControl` is informational. Consent is read on the receiving device from its
own config (section 4); a value in this document never allows a remote drive.

Standalone, the target is bound at `start` with `--device`:

```
browser start --device box --profile work
browser start --device local --profile work   # force this machine
```

`--device <alias>` resolves against `context.target`, then `~/.ssh/config`.
It never reads the agents fleet registry.

## 2. Event FD: browser to agents

Every request to the service emits one NDJSON record. When the parent passes an fd,
records go there as well as to browser-cli's own ledger (`logs/actions/`).

```
BROWSER_EVENTS_FD=<n>
```

```jsonc
{
  "event": "browser.action",
  "ts": "2026-09-13T08:04:02.118Z",
  "command": "navigate",
  "invocationId": "uuid",
  "pid": 41233,
  "task": "a1b2c3d4",
  "profile": "work",
  "url": "https://example.com",
  "ok": true,
  "backend": "cdp",
  "cli": "0.2.12",
  "daemon": "0.2.12",
  "ms": 412,
  "host": "laptop",
  "sessionId": "…",
  "launchId": "…",
  "actor": "claude"
}
```

A failed request adds `error`, its message, and `code`, the error's class name unless it is a plain `Error` (`ArcNativeCapabilityError`, `FirefoxCapabilityError`, `BrowserCdpConnectionError`, `BrowserServiceNotRunningError`, …). `backend` is how the service drove the task (`cdp`, `arc-native` or `bidi`), absent when the request had no live task. `cli` is the CLI that sent the request and `daemon` the service that answered it, absent when no service answered.

Writes are best-effort and never block a verb. Payloads are metadata only.

## 3. Ownership split

| Concern | Owner |
| --- | --- |
| Fleet device registry, device auth, tailnet addressing | agents-cli |
| `--device` to SSH target | agents-cli (via context) or browser-cli (`~/.ssh/config`) |
| Remote-control consent | the receiving device's own `local/settings.yaml`, read by browser-cli there; `context.remoteControl` grants nothing |
| Profile declarations, chrome-data, task index | browser-cli |
| CDP / BiDi / Arc drivers and the IPC service | browser-cli |
| Fleet session DB, cross-machine session history | agents-cli |
| Local action ledger and `browser sessions` | browser-cli |

## 4. State on disk

browser-cli keeps its own state under `~/.agents/browser/` (or `$AGENTS_HOME/browser/`):

| Path | Meaning |
| --- | --- |
| `run/browser.sock`, `run/service.pid` | IPC socket and service pid |
| `cache/<profile>@<device>/` | runtime chrome-data, pids and captures |
| `logins/` | durable user-data dirs (kept sign-ins) |
| `profiles/<machine>.yaml` | profiles this machine offers to the fleet |
| `local/profiles.yaml` | profiles only this machine sees |
| `local/settings.yaml` | `browserRemoteControl`, never synced |
| `data/history.db` | task summaries, 365 days |
| `logs/actions/YYYY-MM-DD.jsonl`, `logs/daemon.jsonl` | action ledger and service log |

Settings it shares with agents-cli stay in agents-cli's files:

| Path | Keys |
| --- | --- |
| `~/.agents/devices/<machine>/agents.yaml` `config:` | `defaultBrowserProfile`, `browserViewer`, `browserTaskIdleMinutes` |
| `~/.agents/agents.yaml` `config.defaultBrowserDevice` | fleet browser hub |

A dotted name older builds wrote into the device `config:` (`browser.profile`) is still read when the stored key is absent, and setting a value replaces it.

Older layouts (`~/.agents/.cache/browser/`, `~/.agents/.cache/helpers/browser/`, `~/.agents/.history/browser-profiles/`, `~/.agents/.history/browser/`) are moved into the paths above the first time a command runs: see [State and migration](state-and-migration.md).

Directory roots honor `AGENTS_HOME`, `HOME`, `AGENTS_HISTORY_DIR` and `AGENTS_DEVICES_DIR`.
