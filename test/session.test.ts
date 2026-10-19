/**
 * @file Tests for the session phase.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { fingerprint } from "../src/state.ts";
import { writeState } from "../src/state.ts";
import type { CloudConfig } from "../src/config.ts";
import { RunTimeoutError } from "../src/run.ts";
import type { Run, RunOptions } from "../src/run.ts";
import type { StepResult } from "../src/steps.ts";
import { SESSION_STEP_TIMEOUT_MS, session, toolsEnv } from "../src/session.ts";

const NOTE = "claude-cloud: you are in a Claude Code cloud session. There are no open ports or previews: test against localhost. gh pr and gh issue fail (the GitHub proxy blocks GraphQL): use gh api (REST).";

let root: string;
let repo: string;
let tools: string;
let calls: Array<{ cmd: string; args: string[]; cwd?: string; env?: NodeJS.ProcessEnv; opts?: RunOptions }>;
let dockerStarts: number;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "cc-session-"));
  repo = join(root, "repo");
  tools = join(root, "tools");
  mkdirSync(join(repo, ".claude"), { recursive: true });
  calls = [];
  dockerStarts = 0;
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const run: Run = async (cmd, args, opts) => {
  calls.push({ cmd, args, cwd: opts?.cwd, env: opts?.env, opts });
  if (cmd === "bash" && args[1]?.startsWith("fail")) throw new Error("exit 1");
  if (cmd === "bash" && args[1]?.startsWith("hang")) throw new RunTimeoutError("bash", opts?.timeoutMs ?? 0);
};

const ctx = (env: NodeJS.ProcessEnv = {}) => ({
  env,
  toolsDir: tools,
  run,
  packageVersion: "1.0.0",
  docker: { start: () => { dockerStarts++; return undefined; }, ensure: async () => true },
});

const writeConfig = (extra: Record<string, unknown> = {}) =>
  writeFileSync(join(repo, ".claude/cloud.json"), JSON.stringify({ version: "1.0.0", ...extra }));

const config = (extra: Partial<CloudConfig> = {}): CloudConfig => ({
  version: "1.0.0", aptRepos: [], apt: [], docker: { pull: "auto" }, setup: [], session: [], requiredEnv: [], ...extra,
});

const record = (steps: StepResult[], fp = fingerprint(config(), {}, [], "1.0.0"), resolved = {}) =>
  writeState(tools, repo, { fingerprint: fp, packageVersion: "1.0.0", finishedAt: "now", steps, resolved });

test("repo without cloud.json prints only the generic note", async () => {
  assert.deepEqual(await session(repo, ctx()), [NOTE]);
  assert.equal(dockerStarts, 0);
});

test("no state prints the setup-did-not-run line", async () => {
  writeConfig();
  const lines = await session(repo, ctx());
  assert.equal(lines[0], NOTE);
  assert.ok(lines.includes("claude-cloud: the environment setup did not run for repo. Set the setup script of the environment in claude.ai to: npx -y @ramon-sg/claude-cloud@1 setup"));
});

test("config errors are printed and the session continues", async () => {
  writeConfig({ bogus: 1 });
  const lines = await session(repo, ctx());
  assert.ok(lines.some((l) => l.includes("bogus")));
});

test("failed steps are listed", async () => {
  writeConfig();
  record([{ name: "a", ok: false, ms: 1 }, { name: "b", ok: true, ms: 1 }, { name: "c", ok: false, ms: 1 }]);
  const lines = await session(repo, ctx());
  assert.ok(lines.includes("claude-cloud: setup failed: a, c. Run claude-cloud doctor."));
});

test("different fingerprint asks to rebuild", async () => {
  writeConfig();
  record([], "sha256-other");
  const lines = await session(repo, ctx());
  assert.ok(lines.includes("claude-cloud: the machine was prepared with another configuration. Edit the setup script field in claude.ai (any change) so it is rebuilt."));
});

test("matching fingerprint prints no rebuild line", async () => {
  writeConfig();
  record([]);
  const lines = await session(repo, ctx());
  assert.ok(!lines.some((l) => l.includes("another configuration") || l.includes("did not run")));
});

test("slow setup reports minutes and seconds", async () => {
  writeConfig();
  record([{ name: "a", ok: true, ms: 100_000 }, { name: "b", ok: true, ms: 150_000 }]);
  const lines = await session(repo, ctx());
  assert.ok(lines.includes("claude-cloud: setup took 4m10s, close to the ~5 minute limit."));
});

test("missing env vars are listed by name only", async () => {
  writeConfig({ requiredEnv: ["A", "B"] });
  const lines = await session(repo, ctx({ A: "super-secret-value" }));
  assert.ok(lines.includes("claude-cloud: missing environment variables: B"));
  assert.ok(!lines.join("\n").includes("super-secret-value"));
});

test("notes inside the repo are printed; escaping paths are skipped", async () => {
  writeFileSync(join(repo, "NOTES.md"), "hello notes\n");
  writeFileSync(join(root, "outside.md"), "leak");
  writeConfig({ notes: "NOTES.md" });
  assert.ok((await session(repo, ctx())).includes("claude-cloud: hello notes"));
  for (const notes of ["../outside.md", join(root, "outside.md")]) {
    writeConfig({ notes });
    assert.ok(!(await session(repo, ctx())).join("\n").includes("leak"));
  }
});

test("without CLAUDE_ENV_FILE nothing is written, warnings print and steps still run", async () => {
  writeConfig({ session: ["echo hi"] });
  writeFileSync(join(repo, ".nvmrc"), "24.14.1\n");
  const lines = await session(repo, ctx());
  assert.ok(lines.some((l) => l.includes("did not run")));
  assert.ok(!lines.some((l) => l.includes("session error")));
  assert.ok(calls.some((c) => c.cmd === "bash" && c.args[1] === "echo hi"));
  assert.deepEqual(readdirSync(root).sort(), ["repo", "tools"].filter((n) => existsSync(join(root, n))));
});

test("with CLAUDE_ENV_FILE writes the PATH line and the quoted CA", async () => {
  writeConfig();
  writeFileSync(join(repo, ".nvmrc"), "24.14.1\n");
  const ca = join(root, "it's.crt");
  writeFileSync(ca, "x");
  const envFile = join(root, "env");
  await session(repo, ctx({ CLAUDE_ENV_FILE: envFile, SSL_CERT_FILE: ca }));
  const text = readFileSync(envFile, "utf8");
  assert.ok(text.includes(`export PATH="${tools}/node-24.14.1/bin:${tools}/bin:$PATH"`));
  assert.ok(text.includes(`export CLOUD_PROXY_CA='${root}/it'\\''s.crt'`));
});

test("session steps run in order in the repo and a failure does not stop the next", async () => {
  writeConfig({ session: ["fail one", "echo two"] });
  writeFileSync(join(repo, ".nvmrc"), "24.14.1\n");
  const lines = await session(repo, ctx());
  const steps = calls.filter((c) => c.cmd === "bash");
  assert.deepEqual(steps.map((c) => c.args), [["-c", "fail one"], ["-c", "echo two"]]);
  assert.equal(steps[0]?.cwd, repo);
  assert.ok(steps[0]?.env?.PATH?.startsWith(`${tools}/node-24.14.1/bin`));
  assert.ok(lines.includes("claude-cloud: session step failed: fail one"));
  assert.ok(!lines.some((l) => l.includes("failed: echo two")));
});

test("starts docker, fetches the default branch with argv and skips invalid branches", async () => {
  writeConfig();
  await session(repo, ctx());
  assert.equal(dockerStarts, 1);
  const fetch = calls.find((c) => c.cmd === "git" && c.args.includes("main:refs/remotes/origin/main"));
  assert.deepEqual(fetch?.args, ["fetch", "-q", "origin", "main:refs/remotes/origin/main"]);
  assert.ok(calls.some((c) => c.args.includes("check-ref-format")));
});

test("unshallow runs only when the clone is shallow", async () => {
  writeConfig();
  await session(repo, ctx());
  assert.ok(!calls.some((c) => c.args.includes("--unshallow")));
  mkdirSync(join(repo, ".git"), { recursive: true });
  writeFileSync(join(repo, ".git/shallow"), "abc\n");
  await session(repo, ctx());
  assert.ok(calls.some((c) => c.args.includes("--unshallow")));
});

test("a failing docker start is reported and git sync and session steps still run", async () => {
  writeConfig({ session: ["echo hi"] });
  for (const start of [() => { throw new Error("kaboom"); }, () => "kaboom"]) {
    calls = [];
    const lines = await session(repo, { ...ctx(), docker: { start, ensure: async () => true } });
    assert.ok(lines.includes("claude-cloud: could not start dockerd: kaboom"));
    assert.ok(calls.some((c) => c.args.includes("main:refs/remotes/origin/main")));
    assert.ok(calls.some((c) => c.cmd === "bash" && c.args[1] === "echo hi"));
  }
});

test("a branch rejected by check-ref-format is never fetched", async () => {
  writeConfig();
  const rejecting: Run = async (cmd, args, opts) => {
    await run(cmd, args, opts);
    if (args.includes("check-ref-format")) throw new Error("bad ref");
  };
  await session(repo, { ...ctx(), run: rejecting });
  assert.ok(calls.some((c) => c.args.includes("check-ref-format")));
  assert.ok(!calls.some((c) => c.args.some((a) => a.includes(":refs/remotes/origin/"))));
});

test("a branch starting with a dash is never fetched", async () => {
  writeConfig();
  execFileSync("git", ["init", "-q"], { cwd: repo });
  execFileSync("git", ["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/-evil"], { cwd: repo });
  await session(repo, ctx());
  assert.ok(!calls.some((c) => c.args.some((a) => a.includes(":refs/remotes/origin/"))));
});

test("notes: symlinks escaping the repo are skipped and dot-prefixed names are allowed", async () => {
  writeFileSync(join(root, "outside.md"), "leak");
  symlinkSync(join(root, "outside.md"), join(repo, "link.md"));
  writeConfig({ notes: "link.md" });
  assert.ok(!(await session(repo, ctx())).join("\n").includes("leak"));
  writeFileSync(join(repo, "..notes.md"), "dotted");
  writeConfig({ notes: "..notes.md" });
  assert.ok((await session(repo, ctx())).includes("claude-cloud: dotted"));
});

test("toolsEnv prepends the directories and adds the CA", () => {
  const env = toolsEnv(["/t/node-24.14.1/bin"], { PATH: "/usr/bin", X: "1" }, "/ca.crt");
  assert.equal(env.PATH, "/t/node-24.14.1/bin:/usr/bin");
  assert.equal(env.CLOUD_PROXY_CA, "/ca.crt");
  assert.equal(env.X, "1");
  assert.equal(toolsEnv([], { PATH: "/usr/bin" }).PATH, "/usr/bin");
});

test("the PATH line puts claude-cloud's bin dir on PATH even with no pinned tools", async () => {
  writeConfig({ session: ["echo hi"] });
  const envFile = join(root, "env");
  await session(repo, ctx({ CLAUDE_ENV_FILE: envFile, PATH: "/usr/bin" }));
  assert.equal(readFileSync(envFile, "utf8"), `export PATH="${tools}/bin:$PATH"\n`);
  assert.equal(calls.find((c) => c.cmd === "bash")?.env?.PATH, `${tools}/bin:/usr/bin`);
});

test("a partial node version maps to the exact version setup resolved", async () => {
  writeConfig({ session: ["echo hi"] });
  writeFileSync(join(repo, ".nvmrc"), "22\n");
  record([], fingerprint(config(), { node: "22" }, [], "1.0.0"), { node: "22.12.0" });
  const envFile = join(root, "env");
  const lines = await session(repo, ctx({ CLAUDE_ENV_FILE: envFile }));
  assert.ok(!lines.some((l) => l.includes("another configuration")), lines.join("\n"));
  assert.ok(readFileSync(envFile, "utf8").includes(`export PATH="${tools}/node-22.12.0/bin:${tools}/bin:$PATH"`));
});

test("an env file that cannot be written is one line and the session goes on", async () => {
  writeConfig({ session: ["echo hi"] });
  const envFile = join(root, "a-directory");
  mkdirSync(envFile);
  const lines = await session(repo, ctx({ CLAUDE_ENV_FILE: envFile }));
  assert.ok(lines.some((l) => l.startsWith(`claude-cloud: could not write CLAUDE_ENV_FILE (${envFile}):`)), lines.join("\n"));
  assert.ok(!lines.some((l) => l.includes("session error")));
  assert.ok(calls.some((c) => c.cmd === "bash" && c.args[1] === "echo hi"));
});

test("session steps send their output to stderr and have a time limit", async () => {
  writeConfig({ session: ["hang forever", "echo next"] });
  const lines = await session(repo, ctx());
  const steps = calls.filter((c) => c.cmd === "bash");
  for (const step of steps) {
    assert.equal(step.opts?.stdio, "stderr");
    assert.equal(step.opts?.timeoutMs, SESSION_STEP_TIMEOUT_MS);
  }
  assert.equal(SESSION_STEP_TIMEOUT_MS, 120_000);
  assert.ok(lines.includes("claude-cloud: session step timed out: hang forever"));
  assert.ok(steps.some((c) => c.args[1] === "echo next"));
});
