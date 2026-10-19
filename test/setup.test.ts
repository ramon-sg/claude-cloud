/**
 * @file Tests for the setup phase of one repo.
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import type { DockerOps } from "../src/docker.ts";
import type { Run } from "../src/run.ts";
import { session } from "../src/session.ts";
import { setupRepo } from "../src/setup.ts";
import { readState } from "../src/state.ts";

/** Milliseconds each fake command takes, so lanes really overlap in time. */
const FAKE_MS = 5;

let root: string;
let repo: string;
let tools: string;
let log: string[];
let overlaps: string[];
let active: Set<string>;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "cc-setup-"));
  repo = join(root, "repo");
  tools = join(root, "tools");
  mkdirSync(join(repo, ".claude"), { recursive: true });
  log = [];
  overlaps = [];
  active = new Set();
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

/**
 * Tells whether a command is apt work or a repo setup step (both must run alone).
 *
 * @param cmd - Executable.
 * @param args - Arguments.
 * @returns The exclusive group name, or undefined.
 */
function exclusive(cmd: string, args: string[]): string | undefined {
  if (cmd === "apt-get") return "apt";
  if (cmd !== "bash") return undefined;
  const script = args[1] ?? "";
  if (script.includes("curl -1sLf")) return "apt";
  if (script.includes("tar -xJ")) return undefined;
  return "setup";
}

/** Fake runner that records each call, takes some time and flags overlapping exclusive work. */
const run: Run = async (cmd, args) => {
  const label = `${cmd} ${args.join(" ")}`;
  log.push(label);
  const group = exclusive(cmd, args);
  if (group) {
    if (active.size) overlaps.push(`${label} overlaps ${[...active].join(", ")}`);
    active.add(label);
  }
  await new Promise((resolve) => setTimeout(resolve, FAKE_MS));
  if (group) active.delete(label);
  if (label.includes("fail")) throw new Error("exit 1");
};

const docker = (up = true): DockerOps => ({ start: () => undefined, ensure: async () => up });

const ctx = (up = true) => ({ toolsDir: tools, run, packageVersion: "1.0.0", env: {}, docker: docker(up) });

const writeConfig = (extra: Record<string, unknown> = {}) =>
  writeFileSync(join(repo, ".claude/cloud.json"), JSON.stringify({ version: "1.0.0", ...extra }));

test("apt work runs in order and never overlaps, even with tools and docker in parallel", async () => {
  writeFileSync(join(repo, ".tool-versions"), "nodejs 24.14.1\npnpm 9.0.0\n");
  writeConfig({
    aptRepos: ["https://example.com/a.sh", "https://example.com/b.sh"],
    apt: ["jq", "postgresql-client"],
    docker: { pull: ["postgres:16", "redis:7", "nginx:1", "busybox:1", "alpine:3"] },
    setup: ["echo one", "echo two"],
  });
  await setupRepo(repo, ctx());
  const apt = log.filter((l) => l.startsWith("apt-get") || l.includes("curl -1sLf"));
  assert.deepEqual(apt, [
    'bash -c set -o pipefail; curl -1sLf -- "$1" | bash _ https://example.com/a.sh',
    'bash -c set -o pipefail; curl -1sLf -- "$1" | bash _ https://example.com/b.sh',
    "apt-get update -q",
    "apt-get install -y -q -- jq postgresql-client",
  ]);
  assert.deepEqual(overlaps, []);
});

test("setup steps run after the tools, with the tools on PATH, and self install comes last", async () => {
  writeFileSync(join(repo, ".tool-versions"), "nodejs 24.14.1\n");
  writeConfig({ setup: ["echo one", "echo two"] });
  const envs: Array<NodeJS.ProcessEnv | undefined> = [];
  const recording: Run = async (cmd, args, opts) => {
    if (cmd === "bash" && args[0] === "-c" && args[1]?.startsWith("echo")) envs.push(opts?.env);
    await run(cmd, args, opts);
  };
  const state = await setupRepo(repo, { ...ctx(), run: recording });
  const nodeAt = log.findIndex((l) => l.includes("nodejs.org"));
  const oneAt = log.indexOf("bash -c echo one");
  const twoAt = log.indexOf("bash -c echo two");
  assert.ok(nodeAt >= 0 && nodeAt < oneAt && oneAt < twoAt);
  assert.match(envs[0]?.PATH ?? "", new RegExp(`^${join(tools, "node-24.14.1", "bin")}`));
  assert.equal(
    log.at(-1),
    `npm install --prefix ${join(tools, "pkg", "1.0.0")} --no-save --no-audit --no-fund @ramon-sg/claude-cloud@1.0.0`,
  );
  assert.equal(
    readlinkSync(join(tools, "bin", "claude-cloud")),
    join(tools, "pkg", "1.0.0", "node_modules", ".bin", "claude-cloud"),
  );
  assert.deepEqual(state.steps.map((s) => s.name), ["node 24.14.1", "setup: echo one", "setup: echo two", "self install 1.0.0"]);
  assert.deepEqual(readState(tools, repo), state);
});

test("a failing step does not stop the others", async () => {
  writeConfig({ apt: ["fail-pkg"], setup: ["fail now", "echo after"] });
  const state = await setupRepo(repo, ctx());
  const byName = Object.fromEntries(state.steps.map((s) => [s.name, s.ok]));
  assert.equal(byName["apt-get install"], false);
  assert.equal(byName["setup: fail now"], false);
  assert.equal(byName["setup: echo after"], true);
  assert.equal(byName["self install 1.0.0"], true);
});

test("untrusted apt names, repo urls and images fail without being run", async () => {
  writeConfig({
    aptRepos: ["http://insecure.example.com/x.sh"],
    apt: ["jq", "evil;rm -rf /", "-oFoo=bar"],
    docker: { pull: ["--privileged", "a b", "ok:1"] },
  });
  const state = await setupRepo(repo, ctx());
  assert.ok(log.includes("apt-get install -y -q -- jq"));
  assert.ok(!log.some((l) => l.includes("insecure") || l.includes("evil") || l.includes("-oFoo")));
  assert.ok(!log.some((l) => l.includes("--privileged") || l.includes("a b")));
  assert.ok(log.includes("docker pull -q ok:1"));
  const failed = state.steps.filter((s) => !s.ok).map((s) => s.name);
  assert.deepEqual(failed.sort(), [
    "apt package -oFoo=bar",
    "apt package evil;rm -rf /",
    "apt repo http://insecure.example.com/x.sh",
    "docker pull --privileged",
    "docker pull a b",
  ].sort());
});

test("docker that does not start is one failed step and no pulls", async () => {
  writeConfig({ docker: { pull: ["postgres:16"] } });
  const state = await setupRepo(repo, ctx(false));
  assert.ok(!log.some((l) => l.startsWith("docker pull")));
  const dockerStep = state.steps.find((s) => s.name === "docker");
  assert.equal(dockerStep?.ok, false);
  assert.equal(dockerStep?.error, "dockerd did not start; see /var/log/claude-cloud-dockerd.log");
});

test("self install skips npm when the binary is already there and replaces the symlink", async () => {
  writeConfig();
  const bin = join(tools, "pkg", "1.0.0", "node_modules", ".bin");
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, "claude-cloud"), "");
  mkdirSync(join(tools, "bin"), { recursive: true });
  symlinkSync("/old/target", join(tools, "bin", "claude-cloud"));
  await setupRepo(repo, ctx());
  assert.ok(!log.some((l) => l.startsWith("npm install")));
  assert.equal(readlinkSync(join(tools, "bin", "claude-cloud")), join(bin, "claude-cloud"));
});

test("a repo without a valid config resolves with a failed step and writes no state", async () => {
  const state = await setupRepo(repo, ctx());
  assert.equal(state.steps[0]?.ok, false);
  assert.ok(!existsSync(join(tools, "state")));
});

test("the fingerprint written by setup matches what session expects", async () => {
  writeFileSync(join(repo, ".tool-versions"), "nodejs 24.14.1\n");
  writeFileSync(join(repo, "docker-compose.yml"), "services:\n  db:\n    image: postgres:16\n");
  writeConfig({ apt: ["jq"], setup: ["echo one"] });
  await setupRepo(repo, ctx());
  const lines = await session(repo, { env: {}, toolsDir: tools, run, packageVersion: "1.0.0", docker: docker() });
  assert.ok(!lines.some((l) => l.includes("another configuration")), lines.join("\n"));
  assert.ok(!lines.some((l) => l.includes("did not run")));
});
