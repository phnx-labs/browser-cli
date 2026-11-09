# Remote browsers

Run a task in a browser on another machine with `--device` on `start`:

```sh
browser start --device box --profile work    # box is a Host in ~/.ssh/config
browser navigate https://example.com         # later commands follow the task there
browser screenshot -o shot.png               # copied back to this machine
```

- **Turn it on first, on the other machine.** Remote control is off by default. Install Browser CLI there and run `browser remote-control on`; until then, commands from another machine are refused. `browser remote-control off` turns it off again.
- `--device <alias>` resolves against `~/.ssh/config`, or against the context Agents CLI hands over when it runs `browser`. Browser CLI itself does not read a fleet registry. `--device local` forces the task onto this machine.
- The device is bound once, at `start`; later page commands run where the task lives, so `--device` is only valid on `start`.
- One kept-alive SSH connection carries the session. Remote control works with Chromium-family browsers; Firefox and Arc run on the local machine only.
