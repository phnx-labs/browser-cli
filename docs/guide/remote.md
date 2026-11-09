# Remote browsers

Run a task in a browser on another machine with `--device` on `start`:

```sh
browser start --device box --profile work    # box is a Host in ~/.ssh/config
browser navigate https://example.com         # later commands follow the task there
browser screenshot -o shot.png               # copied back to this machine
```

- **Turn it on first, on the other machine.** Install browser-cli there and run `browser remote-control on`. The setting starts off, stays on that machine and is never synced; `browser remote-control off` turns it off again.
- `--device <alias>` resolves against `~/.ssh/config`, or against the context Agents CLI hands over when it runs `browser`. When Agents CLI has set a browser hub (`defaultBrowserDevice`), `start` goes there by default; `--device local` keeps the task on this machine.
- The device is bound once, at `start`; later page commands run where the task lives, so `--device` is only valid on `start`.
- Each command runs in browser-cli on the other machine, so any profile that machine offers works there. One SSH connection carries them and stays open for 30 idle minutes.
- A caller that cannot reach the machine over SSH, such as a cloud sandbox, sets `BROWSER_RELAY_URL` and `BROWSER_RELAY_TOKEN`, and commands and their screenshots travel over HTTPS instead.
