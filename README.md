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
   Run `claude-cloud doctor` in a session to see which hosts are blocked (it probes with `curl`,
   so it goes through the proxy like the setup does). If the setup never ran, use
   `npx @ramon-sg/claude-cloud doctor`.
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
| `aptRepos`    | no       | HTTPS URLs of setup scripts that add APT repositories; each is downloaded and piped to `bash` before installing packages.                            |
| `apt`         | no       | Debian packages to install. Names are validated and passed as arguments, never to a shell.                                                           |
| `docker.pull` | no       | `"auto"` (default) pulls the images found in compose files and in `FROM` lines pinned with `@sha256`; a list of image names pulls those; `false` leaves Docker alone during `setup`. |
| `setup`       | no       | Shell commands run once during `setup`, in the repo, with the pinned tools first on `PATH`. A failing command is recorded and the rest still run.    |
| `session`     | no       | Shell commands run at the start of every session, in the repo. Their output goes to stderr (not into Claude's context), each one is stopped after 2 minutes, and a failing command is reported while the rest still run. |
| `requiredEnv` | no       | Environment variables that must be set; the session warns about the missing ones.                                                                    |
| `notes`       | no       | Path, relative to the repo, of a text file appended to the session notes shown at the start of every session.                                       |

Tool versions are deduced, in order, from `.tool-versions`, `mise.toml`, `.nvmrc` and
`package.json#packageManager`. The default branch comes from `origin/HEAD`. Each tool is installed
under `/opt/claude-cloud/<tool>-<version>`, so versions coexist and the repos of one environment
share the folder. A tool with no installer produces a warning and is skipped.

A Node version that is not exact (`22`, `22.1`, `lts/iron`, `lts/*` or `node`) is resolved during
`setup` to the newest matching release in `https://nodejs.org/dist/index.json` and installed under
`/opt/claude-cloud/node-<exact version>`. The resolved version is recorded in the machine state, so
`session` puts the same folder on `PATH`.

## Commands

| Command                       | What it does                                                                                                                                                                                                                       |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `claude-cloud setup [--repo <path>]` | Runs as root before Claude starts. For every git repo in the home dir (`/home/user`) with a `.claude/cloud.json` (or only `<path>`): installs tools, apt packages and images and copies itself (no npm, no network) to `/opt/claude-cloud/bin/claude-cloud`, then runs the `setup` steps and records the result. Repos without the file are skipped with a notice. It always exits 0: failures are recorded, never fatal. |
| `claude-cloud session`        | Runs from the `SessionStart` hook, in seconds and without network (except to complete the clone). Warns when setup did not run, failed steps, or the machine was prepared with another configuration; writes the `PATH` line (the pinned tools, then `/opt/claude-cloud/bin`, so `claude-cloud` itself resolves) to `$CLAUDE_ENV_FILE`; starts Docker; fetches the full history and `origin/<default branch>`; runs the `session` steps. It never fails the session start. |
| `claude-cloud docker`         | Starts `dockerd` detached and waits up to 60 seconds for it to answer. Exits 1 if it does not, at once when `dockerd` is not installed.                                                                                             |
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

## Releasing

For maintainers. Releases are published by `.github/workflows/publish.yml` when a GitHub release is
published; the workflow fails if the release tag, without its leading `v`, differs from the
`version` in `package.json`.

The first publish of a new package cannot use npm trusted publishing, because trusted publishing
is configured on a package that already exists. Publish the first version by hand:

1. Either run `npm ci && npm run build && npm publish --provenance=false` from a machine logged in
   to npm (`npm login`) with publish rights on the `@ramon-sg` scope (provenance needs a CI, and
   `package.json` asks for it), or run the workflow once with an `NPM_TOKEN` secret
   (`NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}` on the publish step).
2. On npmjs.com, open the package settings and add a trusted publisher: this GitHub repository and
   the `publish.yml` workflow.
3. Remove the `NPM_TOKEN` secret if you created one. From then on, bump `version` in
   `package.json`, update `CHANGELOG.md`, and publish a GitHub release tagged `v<version>`.

## License

MIT
