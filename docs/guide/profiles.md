# Profiles

A **profile** names a browser, where it runs, and how to reach it. Profiles are stored in `~/.agents/browser/profiles/<machine>.yaml`, or `~/.agents/browser/local/profiles.yaml` for ones only this machine sees.

```sh
browser profiles create work --browser chrome            # local Chrome, a free debugging port
browser profiles create hl --browser chromium --headless # headless Chromium
browser profiles list
browser use work                                         # the profile a bare `browser start` uses
browser profiles logins                                  # signed-in sites and accounts per profile
browser profiles logins --json
```

- **Firefox** profiles are not created with `profiles create`. Browser CLI reads Firefox's own `profiles.ini` and lists each profile in `browser profiles list`, ready to use.
- **Comet and Arc** attach to the browser you already have open and signed in. Create a Comet profile with `--attach-only`; Arc profiles always attach, one per Arc Space.
- **Separate profiles keep logins apart.** Each profile has its own cookies, so an agent working in `work` cannot reach what you are signed into in `personal`.

`logins` reads each profile's cookie store where its browser keeps it and reports which supported sites (Google, GitHub, LinkedIn, X and Reddit) have a live session. It checks that session cookies exist and never decrypts them. A store it cannot read here (a profile declared on another device, a browser reached over `ssh://`, Firefox, a profile never launched on this machine) is listed as `(not read: <reason>)`, and in `--json` as one `{"profile", "service": null, "account": null, "unread"}` row.

Each profile resolves to an endpoint, shown in `browser profiles list`:

- `cdp://127.0.0.1:9222`: a Chromium-family browser over the DevTools Protocol
- `bidi=firefox-bidi://127.0.0.1:9674`: Firefox over WebDriver BiDi
- `ssh://user@box?port=9222`: a browser on another machine, reached over SSH
