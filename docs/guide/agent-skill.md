# The agent skill

The package ships the browser skill in the standard Agent Skills layout, so agents learn the CLI from the version that is installed:

```
skills/browser/
  SKILL.md                    # workflow, defaults, where to look for flags
  references/arc.md           # Arc limits and sharing the user's window
  references/sites/<site>.md  # site guides (higgsfield, linkedin, perplexity, slack)
  scripts/slack/*.js          # page scripts the Slack guide runs with evaluate --file
```

```sh
npx skills add phnx-labs/browser-cli    # install into your agents
browser skills path                     # the installed copy (link agents here)
browser skills get arc                  # read one document
browser help --json                     # every command, argument and option
```

The skill lists no flags. Agents read `browser <command> --help` or `browser help --json`, which always match the installed binary.

- `browser skills path` prints the installed `skills/browser` directory.
- `browser skills list [--json]` lists `SKILL.md` and its reference documents.
- `browser skills get [name]` prints `SKILL.md`, or a reference such as `arc` or a site guide such as `slack`.
- `browser help [command...] [--json]` prints a command's help; `--json` prints the command tree in the shape of [`command-index.json`](../command-index.json).

`browser start --url` prints the site guide whose file name matches the host (`app.slack.com` matches `references/sites/slack.md`), or whose frontmatter `domains:` list names it. `--no-skills` skips it. When the skill cannot be found, `start` still runs and prints a warning saying why.

The binary sits in the package's `bin/` and reads `../skills`; when install scripts were skipped, the npm launcher passes the location as `BROWSER_SKILLS_DIR`. A development run of `dist/<platform>-<arch>/browser` sets it by hand (`BROWSER_SKILLS_DIR=$PWD/skills`).
