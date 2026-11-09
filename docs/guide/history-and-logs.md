# History and logs

`browser sessions` opens a searchable task and capture picker in a terminal. Use arrows to move, Enter to browse or open a capture, and Escape to go back. `--no-interactive` prints the listing; `--json` prints the profile and capture records. Add `--tasks` for task rows, including tasks without captures, or `--search <text>` to filter those rows.

The same filters apply to the picker, the printed listing and `--json`: `--since <when>` and `--until <when>` take `2h`, `7d`, `4w`, `1mo`, `1y` or an ISO date and keep task rows by last activity and captures by capture time; an invalid value exits 2. `--limit <n>` caps the printed listing (default 50); `--json` is unbounded unless `--limit` is given. The count footer goes to stderr, so piped stdout carries rows only.

```sh
browser sessions --since 7d
browser sessions --tasks --since 1mo --until 7d --json
browser sessions --no-interactive --limit 20
browser history                         # recent tasks
```

Task summaries are kept for 365 days in `~/.agents/browser/data/history.db`. Captures stay where they were saved and are never deleted by that retention.

Logs are JSON lines with a `ts` field, read with `tail` and `jq`:

- **`logs/actions/<UTC day>.jsonl`:** one record per request the CLI sends (command, task, profile, `ok`, `error`, `ms`), kept 30 days.
- **`logs/daemon.jsonl`:** launches, closes, navigations, screenshots, cleanup results, lost connections and save failures. A repeated failure is written once, then at its 10th, 100th, 1000th occurrence and so on with `count`, and starts over after ten quiet minutes. At start the service rolls a `daemon.jsonl` over 10 MB to `.1`, keeping three.
- **`logs/browser-service.log`:** only what the service prints to stderr, such as a crash.

URLs are logged without credentials, query or fragment, which can carry tokens; a `data:` or `javascript:` URL is logged as its scheme alone.

```sh
tail -3 ~/.agents/browser/logs/actions/$(date -u +%F).jsonl | jq .
jq -c 'select(.error)' ~/.agents/browser/logs/daemon.jsonl
```

Where everything is stored, and how older layouts are migrated: [State and migration](../state-and-migration.md).
