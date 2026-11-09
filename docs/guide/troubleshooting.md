# Platforms and troubleshooting

| Platform | Architectures |
| --- | --- |
| macOS | arm64, x64 |
| Linux | arm64, x64 |
| Windows | x64 |

Chromium CDP, Firefox BiDi and SSH endpoints work on all three. Arc is driven natively on macOS.

- **Headless on Linux.** A headless Chromium or Brave needs the usual shared libraries (fonts, `libnss3`, `libatk`, `libgbm` and others). Install your distribution's chromium package to pull them in; a missing library shows up as the browser process exiting right after `start`.
- **Chromium from snap.** Snap confinement can stop it from writing a profile under `~/.agents`, and it exits at launch with `SingletonLock: Permission denied`. Use a Chromium-family browser installed another way, or point a `custom` profile at it with `--binary`.
- **"No usable sandbox" in a container.** Chromium's sandbox needs user namespaces, which Docker's default seccomp profile blocks, so Chromium exits at launch. Run the container with `--security-opt seccomp=unconfined` (or a seccomp profile that allows `clone` with `CLONE_NEWUSER`), or run on a host or VM. browser-cli keeps Chromium's sandbox on.
- **Port already in use.** A profile that launches its own browser talks to it over a private pipe, so only a profile pinned to a `--user-data-dir` (an attach-only or Comet profile) listens on its debugging port. If `start` reports another browser on that port, `browser profiles doctor <name>` names its pid and data folder: close it and relaunch the browser with the profile's `--user-data-dir`, or create the profile with a different `--endpoint`.
- **Comet and Arc.** Comet is driven as a Chromium-family browser over CDP and works best as an attach-only profile against a browser you already launched. Arc is always attach-only and macOS-only. Its tasks open in an Arc window of their own; `screenshot` captures that window through the Computer helper (`computer setup`) without bringing Arc forward.
- **Sites that check for bots.** browser-cli launches Chromium without the `navigator.webdriver` flag that bot checks read. A headless profile still names itself `HeadlessChrome` in its user agent, so use a visible profile for sites that check it. When a site shows a CAPTCHA, solve it in the window and the agent carries on.
- **Service state.** `browser status` shows whether the service is running and lists active tasks. `browser stop --service` shuts the service down; `browser stop --task <name>` closes one task.
