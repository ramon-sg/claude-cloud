# @ramon-sg/claude-cloud

A zero-dependency CLI that prepares [Claude Code on the web](https://claude.ai/code) cloud
sessions. It installs the tool versions a repo pins, starts Docker, completes the partial
clone, and tells you when the saved machine is not what the repo asks for, working around the
limits of the cloud sandbox that the platform does not document.

- Written in TypeScript, published compiled, **no runtime dependencies**, Node `>=20` (the cloud
  image ships Node 22, so it runs before any tool of your repo is installed).
- The **repo decides the version**: `.claude/cloud.json` pins the exact version of this package,
  so updating it is a commit.

## What it solves

Installing Node and starting Docker takes a few lines of shell. The expensive part is what the
platform does not tell you:

- The egress proxy blocks GitHub releases and GitHub's GraphQL API, so tools that download from
  GitHub fail. `claude-cloud` installs Node from nodejs.org; Bun, Deno, pnpm and Yarn from npm;
  and uv from PyPI.
- The setup script runs from `/home/user`, not from the repo, and a failure is silent.
- A setup that takes more than about 5 minutes does not leave a saved machine.
- Two `apt` runs at the same time collide on the dpkg lock, so apt work runs in series.
- `dockerd` is off and the clone is partial (shallow, without `origin/<default branch>`).
- There is no IPv6.
- The proxy replaces TLS, and `docker build` does not trust its CA.
- A resumed session does not run the setup again, and changing the setup does not rebuild the
  saved machine.

## Set up claude.ai

In the environment form at `https://claude.ai/code`:

1. **Network access:** choose *Custom* and keep **Also include default list of common package
   managers** checked. Add any extra domains your `apt` repos or setup steps need, one per line.
   Run `npx @ramon-sg/claude-cloud doctor` in a session to see which hosts are blocked.
2. **Setup script:** the cloud runs it as root from `/home/user`, before Claude starts:

   ```bash
   #!/bin/bash
   npx -y @ramon-sg/claude-cloud@1 setup
   ```

   The `@1` only pins the launcher. Each repo then relaunches the exact version it asks for, so a
   new launcher major is adopted by editing this field on purpose. To force the saved machine to
   be rebuilt, change anything in this field (a comment with the date works).

3. In each repo run `npx @ramon-sg/claude-cloud init`, then commit `.claude/cloud.json` and
   `.claude/settings.json`.

Environment changes are read when a session is created: start a new session to test them. A
resumed session does not run the setup again.

## `.claude/cloud.json`

It lives in `.claude/` rather than in `package.json` so repos without Node can use it. A JSON
schema ships with the package (`schema.json`). Unknown fields are reported and ignored, and a
broken file never stops a session.

```json
{
  "$schema": "https://unpkg.com/@ramon-sg/claude-cloud/schema.json",
  "version": "1.0.0",
  "aptRepos": ["https://example.com/setup.deb.sh"],
  "apt": ["direnv", "jq"],
  "docker": { "pull": "auto" },
  "setup": ["scripts/cloud-setup-extra.sh"],
  "session": ["scripts/worktree-setup.sh"],
  "requiredEnv": ["API_TOKEN"],
  "notes": ".claude/cloud-notes.md"
}
```

| Field         | Required | Meaning                                                                                                                                              |
| ------------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `version`     | yes      | Exact version of this package to run (no ranges). If `setup` runs a different one it relaunches with this one.                                       |
| `aptRepos`    | no       | `https://` URLs of apt repository setup scripts, downloaded and run before installing packages.                                                      |
| `apt`         | no       | Debian packages to install. Names are validated and passed as arguments, never to a shell.                                                           |
| `docker.pull` | no       | `"auto"` (default) pulls the images found in compose files and in `FROM` lines pinned with `@sha256`; a list of image names pulls those; `false` leaves Docker alone during `setup`. |
| `setup`       | no       | Shell commands run once during `setup`, in the repo, with the pinned tools first on `PATH`. A failing command is recorded and the rest still run.    |
| `session`     | no       | Shell commands run at the start of every session, in the repo. A failing command is reported and the rest still run.                                 |
| `requiredEnv` | no       | Environment variables that must be set; the session warns about the missing ones.                                                                    |
| `notes`       | no       | Path (inside the repo) to a text file whose contents are shown at the start of every session.                                                        |

Tool versions are deduced, in order, from `.tool-versions`, `mise.toml`, `.nvmrc` and
`package.json#packageManager`. The default branch comes from `origin/HEAD`. Each tool is installed
under `/opt/claude-cloud/<tool>-<version>`, so versions coexist and the repos of one environment
share the folder. A tool with no installer produces a warning and is skipped.

## Commands

| Command                       | What it does                                                                                                                                                                                                                       |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `claude-cloud setup [--repo <path>]` | Runs as root before Claude starts. For every git repo in the home dir (`/home/user`) with a `.claude/cloud.json` (or only `<path>`): installs tools, apt packages and images, runs the `setup` steps, installs itself to `/opt/claude-cloud/bin/claude-cloud` and records the result. Repos without the file are skipped with a notice. It always exits 0: failures are recorded, never fatal. |
| `claude-cloud session`        | Runs from the `SessionStart` hook, in seconds and without network (except to complete the clone). Warns when setup did not run, failed steps, or the machine was prepared with another configuration; writes the `PATH` line to `$CLAUDE_ENV_FILE`; starts Docker; fetches the full history and `origin/<default branch>`; runs the `session` steps. It never fails the session start. |
| `claude-cloud docker`         | Starts `dockerd` detached and waits up to 60 seconds for it to answer. Exits 1 if it does not.                                                                                                                                      |
| `claude-cloud doctor`         | Checks that the proxy lets the needed hosts through, that the pinned tools are installed, that Docker answers, and the recorded state (fingerprint and each step). Exits 1 if any check fails.                                       |
| `claude-cloud init`           | Creates `.claude/cloud.json` if missing and adds the `SessionStart` hook to `.claude/settings.json`, keeping the hooks already there. Safe to run again.                                                                           |

Environment variables: `CLAUDE_CLOUD_DIR` overrides `/opt/claude-cloud` and `CLAUDE_CLOUD_HOME`
overrides `/home/user`; both exist mainly for tests.

### The `SessionStart` hook

`init` adds this hook. Outside a cloud session it does nothing, and it calls the copy of the
package that `setup` left on the saved machine, so it needs no network and no `node_modules`:

```json
{
  "type": "command",
  "command": "[ \"$CLAUDE_CODE_REMOTE\" = true ] || exit 0; /opt/claude-cloud/bin/claude-cloud session || echo 'claude-cloud: the environment setup did not run; see npx @ramon-sg/claude-cloud doctor'",
  "timeout": 600
}
```

When the repo pins another version than the one that is running and that version is installed,
`session` hands over to it.

### Machine fingerprint

`setup` stores a fingerprint of the config, the pinned versions, the images and the package
version. If the repo changes afterwards, `session` warns that "the machine was prepared with
another configuration". The saved machine is rebuilt by claude.ai about every 7 days, or when you
edit the setup script field.

## The proxy CA and `docker build`

The cloud proxy replaces TLS, so `docker build` does not trust it. `session` finds the CA bundle
(`SSL_CERT_FILE`, then `NODE_EXTRA_CA_CERTS`, then `/root/.ccr/ca-bundle.crt`) and exports its
path as `CLOUD_PROXY_CA`. Pass it to the build as a secret, only when it is set:

```bash
docker build ${CLOUD_PROXY_CA:+--secret id=proxy_ca,src="$CLOUD_PROXY_CA"} -t app .
```

```dockerfile
RUN --mount=type=secret,id=proxy_ca \
    if [ -f /run/secrets/proxy_ca ]; then \
      export SSL_CERT_FILE=/run/secrets/proxy_ca NODE_EXTRA_CA_CERTS=/run/secrets/proxy_ca; \
    fi; \
    npm ci
```

## What it does not do

- It does not make the platform's limits go away: no open ports or previews, `gh pr` and
  `gh issue` fail (GitHub's GraphQL is blocked; use `gh api`), and a PR cannot be taken out of
  draft from the cloud.
- It does not install plugins, or run the hooks of plugins, from your machine.
- It does not install tools from GitHub releases; the proxy blocks them.
- It does not run Docker inside Docker, and it does not start a Docker daemon in local sessions
  (the hook exits when `CLAUDE_CODE_REMOTE` is not `true`).
- It does not keep secrets safe: environment variables of a cloud environment are readable by
  anyone who uses it.
- It does not run your `setup` steps on a resumed session; only a new session does.
- `setup` runs code fetched from npm as root. The version is pinned in the repo and the relaunch
  uses exactly that version.

## License

MIT
