# State and migration

Browser CLI keeps its state under `~/.agents/browser/` (or `$AGENTS_HOME/browser/`). Offered profiles sync in `profiles/<device>.yaml`; only that device writes its file. Private profile declarations use the same name-to-configuration map in `local/profiles.yaml` and override this machine's offered declarations. Remote-control consent lives in `local/settings.yaml`, outside fleet sync. Runtime sockets and locks use `run/`, captures and browser caches use `cache/`, kept sign-ins use `logins/`, task history uses `data/`, and logs use `logs/`.

## Migrating older layouts

Before running a command, the CLI or service moves older folders into this layout under one exclusive lock:

| From | To |
| --- | --- |
| `~/.agents/.cache/browser/` | `browser/cache/` |
| `~/.agents/.history/browser/` | `browser/data/` |
| `~/.agents/.history/browser-profiles/` | `browser/logins/` |
| `~/.agents/.cache/helpers/browser/` | `browser/run/` |
| `~/.agents/.cache/logs/browser-service.log` | `browser/logs/browser-service.legacy.log` |

- Once complete, later commands check a local marker and the legacy paths without taking the migration lock. A recreated legacy folder triggers another migration.
- If the migration lock is unavailable, the CLI warns; commands that need no service can continue, while starting the service waits for a successful retry.
- Existing directories merge. Conflicting files are kept under `local/migration-conflicts/` with a warning naming both copies. History rows merge in one transaction, so a fresh database does not hide old tasks. Tombstone files stop old binaries from recreating migrated folders.
- Live browser stores are left in place: close the named browser and rerun the command, then restart the service before using that profile.
- Moves stay inside the selected `AGENTS_HOME`. `EXDEV` means the source and destination are on different filesystems: the CLI leaves the source untouched and names both paths. Stop browsers using that source, move it by hand into the named destination without overwriting existing files, and rerun the CLI. Other move failures also warn without stopping the service.
- An old service that cannot be identified or stopped is left running; status and configuration remain available, but driving is blocked until it is stopped and the new service is restarted.
- Offered profiles are also written to the older device file (`~/.agents/devices/<machine>/agents.yaml`) for machines still on older versions; the new profile files take precedence when both exist.

On the first task listing, Browser CLI adopts task summaries from the older Agents history database, read-only; `browser sessions migrate [--from /path/to/sessions.db] --json` repeats the import safely.
