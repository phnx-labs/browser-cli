# browser-cli ↔ agents-cli integration contract

`browser-cli` is a standalone binary. It has **no runtime dependency on
agents-cli** — it never imports it, never spawns `agents`, and never reads the
fleet device registry or the session database. Everything agents-cli knows and
browser-cli needs crosses one of the four seams below.

Changing a shape here is a breaking change for the agents-cli adapter.

## 1. Inherited context FD — agents → browser

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

## 2. Event FD — browser → agents

Every action emits one NDJSON record. When the parent passes an fd, records go
there; otherwise they go to browser-cli's own ledger.

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
  "host": "laptop",
  "sessionId": "…",
  "launchId": "…",
  "actor": "claude"
}
```

Writes are best-effort and never block a verb. Payloads are metadata only.

## 3. Ownership split

| Concern | Owner |
| --- | --- |
| Fleet device registry, device auth, tailnet addressing | agents-cli |
| `--device` → SSH target | agents-cli (via context) / browser-cli (`~/.ssh/config`) |
| Remote-control consent | the receiving device's own `browserRemoteControl`, read by browser-cli there; `context.remoteControl` grants nothing |
| Profile declarations, chrome-data, task index | browser-cli |
| CDP / BiDi / Arc drivers and the IPC service | browser-cli |
| Fleet session DB, cross-machine session history | agents-cli |
| Local action ledger + `browser sessions` | browser-cli |

## 4. State compatibility

browser-cli keeps every on-disk path the agents-cli `browser` subsystem used:

| Path | Meaning |
| --- | --- |
| `~/.agents/.cache/helpers/browser/browser.sock` | IPC socket |
| `~/.agents/.cache/browser/<profile>@<device>/` | runtime chrome-data / pids |
| `~/.agents/.history/browser-profiles/` | durable user-data dirs |
| `~/.agents/devices/<machine>/agents.yaml` `browser:` | machine-local profiles |
| `~/.agents/devices/<machine>/agents.yaml` `config:` | `browserRemoteControl`, `defaultBrowserProfile`, `browserViewer`, `browserTaskIdleMinutes` |
| `~/.agents/agents.yaml` `config.defaultBrowserDevice` | fleet browser hub |
| `~/.agents/.cache/browser/actions/YYYY-MM-DD.jsonl` | local action ledger |

Config keys are the ones agents-cli stores. A dotted name (`browser.remote-control`)
that 0.1.16 and earlier wrote into the device `config:` is still read when the
stored key is absent, and setting a value replaces it. Remote control is on only
when every spelling present is `true`.

Directory roots honor `AGENTS_HOME`, `AGENTS_CACHE_DIR`, `AGENTS_HELPERS_DIR`,
`AGENTS_LOGS_DIR` and `HOME`.
