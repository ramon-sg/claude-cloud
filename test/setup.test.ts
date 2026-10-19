/**
 * @file Tests for the setup phase of one repo.
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import type { DockerOps } from "../src/docker.ts";
import type { Run } from "../src/run.ts";
import { session } from "../src/session.ts";
import { setupRepo } from "../src/setup.ts";
import { readState } from "../src/state.ts";
import { FAKE_CLI, fakePackage } from "./fake-package.ts";

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

/** Setup commands used by these tests; only these count as repo setup steps in the detector. */
const SETUP_COMMANDS = ["echo one", "echo two"];

/**
 * Tells whether a command is apt work or a repo setup step (both must run alone).
 *
 * @param cmd - Executable.
 * @param args - Arguments.
 * @returns The exclusive group name, or undefined.
 */
function exclusive(cmd: string, args: string[]): string | undefined {
  if (cmd === "apt-get") return "apt";
  if (cmd !== "bash" || args[0] !== "-c") return undefined;
  const script = args[1] ?? "";
  if (script.includes("curl -1sLf")) return "apt";
  if (args.length === 2 && SETUP_COMMANDS.includes(script)) return "setup";
  return undefined;
}

/** Fake Node.js release index served to curl. */
const INDEX = [
  { version: "v24.14.1", lts: "Krypton" },
  { version: "v22.12.0", lts: "Jod" },
  { version: "v22.11.0", lts: "Jod" },
];

/** Fake runner that records each call, takes some time and flags overlapping exclusive work. */
const run: Run = async (cmd, args) => {
  if (cmd === "curl" && args.includes("https://nodejs.org/dist/index.json")) {
    writeFileSync(args[args.indexOf("-o") + 1] ?? "", JSON.stringify(INDEX));
  }
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

let ensures: number;
beforeEach(() => {
  ensures = 0;
});

const docker = (up = true): DockerOps => ({
  start: () => undefined,
  ensure: async () => {
    ensures++;
    return up;
  },
});

const ctx = (up = true) => ({
  toolsDir: tools,
  run,
  packageVersion: "1.0.0",
  env: {},
  docker: docker(up),
  packageRoot: fakePackage(root, "1.0.0"),
});

/** Where the self install puts the package. */
const installed = (): string => join(tools, "pkg", "1.0.0", "node_modules", "@ramon-sg", "claude-cloud");

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

test("setup steps run after the tools and the self install, with both on PATH", async () => {
  writeFileSync(join(repo, ".tool-versions"), "nodejs 24.14.1\n");
  writeConfig({ setup: ["echo one", "echo two"] });
  const envs: Array<NodeJS.ProcessEnv | undefined> = [];
  let linkedBeforeSteps = false;
  const recording: Run = async (cmd, args, opts) => {
    if (cmd === "bash" && args[0] === "-c" && args[1]?.startsWith("echo")) {
      envs.push(opts?.env);
      linkedBeforeSteps ||= existsSync(join(tools, "bin", "claude-cloud"));
    }
    await run(cmd, args, opts);
  };
  const state = await setupRepo(repo, { ...ctx(), env: { PATH: "/usr/bin" }, run: recording });
  const nodeAt = log.findIndex((l) => l.includes("nodejs.org"));
  const oneAt = log.indexOf("bash -c echo one");
  const twoAt = log.indexOf("bash -c echo two");
  assert.ok(nodeAt >= 0 && nodeAt < oneAt && oneAt < twoAt);
  assert.ok(linkedBeforeSteps);
  assert.equal(envs[0]?.PATH, `${join(tools, "node-24.14.1", "bin")}:${join(tools, "bin")}:/usr/bin`);
  assert.deepEqual(state.steps.map((s) => s.name), ["node 24.14.1", "self install 1.0.0", "setup: echo one", "setup: echo two"]);
  assert.deepEqual(state.resolved, { node: "24.14.1" });
  assert.deepEqual(readState(tools, repo), state);
});

test("self install copies the running package without npm and links its binary", async () => {
  writeConfig();
  const state = await setupRepo(repo, ctx());
  assert.equal(state.steps.find((s) => s.name === "self install 1.0.0")?.ok, true, JSON.stringify(state.steps));
  assert.ok(!log.some((l) => l.startsWith("npm")));
  assert.equal(JSON.parse(readFileSync(join(installed(), "package.json"), "utf8")).version, "1.0.0");
  const cli = join(installed(), "dist", "cli.js");
  assert.equal(readFileSync(cli, "utf8"), FAKE_CLI);
  assert.ok(existsSync(join(installed(), "dist", "setup.js")));
  assert.equal(statSync(cli).mode & 0o777, 0o755);
  const bin = join(tools, "pkg", "1.0.0", "node_modules", ".bin", "claude-cloud");
  assert.equal(readlinkSync(bin), join("..", "@ramon-sg", "claude-cloud", "dist", "cli.js"));
  assert.equal(readlinkSync(join(tools, "bin", "claude-cloud")), bin);
  assert.equal(realpathSync(join(tools, "bin", "claude-cloud")), realpathSync(cli));
});

test("a failing step does not stop the others", async () => {
  writeConfig({ apt: ["fail-pkg"], setup: ["fail now", "echo after"] });
  const state = await setupRepo(repo, ctx());
  const byName = Object.fromEntries(state.steps.map((s) => [s.name, s.ok]));
  assert.equal(byName["apt-get install"], false);
  assert.equal(byName["setup: fail now"], false);
  assert.equal(byName["setup: echo after"], true);
  assert.equal(byName["self install 1.0.0"], true, JSON.stringify(state.steps));
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

test("self install skips the copy when that version is already there and replaces the link", async () => {
  writeConfig();
  mkdirSync(join(installed(), "dist"), { recursive: true });
  writeFileSync(join(installed(), "package.json"), JSON.stringify({ version: "1.0.0" }));
  writeFileSync(join(installed(), "dist", "cli.js"), "already here");
  mkdirSync(join(tools, "bin"), { recursive: true });
  symlinkSync("/old/target", join(tools, "bin", "claude-cloud"));
  await setupRepo(repo, ctx());
  assert.equal(readFileSync(join(installed(), "dist", "cli.js"), "utf8"), "already here");
  assert.equal(readlinkSync(join(tools, "bin", "claude-cloud")), join(tools, "pkg", "1.0.0", "node_modules", ".bin", "claude-cloud"));
});

test("self install replaces another version's leftovers and refuses a source of another version", async () => {
  writeConfig();
  mkdirSync(installed(), { recursive: true });
  writeFileSync(join(installed(), "package.json"), JSON.stringify({ version: "0.9.0" }));
  await setupRepo(repo, ctx());
  assert.equal(JSON.parse(readFileSync(join(installed(), "package.json"), "utf8")).version, "1.0.0");
  rmSync(join(tools, "pkg"), { recursive: true });
  const state = await setupRepo(repo, { ...ctx(), packageRoot: fakePackage(root, "2.0.0") });
  const self = state.steps.find((s) => s.name === "self install 1.0.0");
  assert.equal(self?.ok, false);
  assert.match(self?.error ?? "", /is 2\.0\.0, not 1\.0\.0/);
});

test("a partial node version is resolved, installed by its exact version and recorded", async () => {
  writeFileSync(join(repo, ".nvmrc"), "22\n");
  writeConfig({ setup: ["echo one"] });
  const envs: Array<NodeJS.ProcessEnv | undefined> = [];
  const recording: Run = async (cmd, args, opts) => {
    if (cmd === "bash" && args[1] === "echo one") envs.push(opts?.env);
    await run(cmd, args, opts);
  };
  const state = await setupRepo(repo, { ...ctx(), run: recording });
  assert.ok(log.some((l) => l.includes("node-v22.12.0-linux")));
  assert.deepEqual(state.resolved, { node: "22.12.0" });
  assert.ok(envs[0]?.PATH?.startsWith(join(tools, "node-22.12.0", "bin")));
  const envFile = join(root, "env");
  const lines = await session(repo, { env: { CLAUDE_ENV_FILE: envFile }, toolsDir: tools, run, packageVersion: "1.0.0", docker: docker() });
  assert.ok(!lines.some((l) => l.includes("another configuration")), lines.join("\n"));
  assert.ok(readFileSync(envFile, "utf8").includes(join(tools, "node-22.12.0", "bin")));
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

test("docker is ensured with pull auto even when no image is detected", async () => {
  writeConfig({ setup: ["echo one"] });
  const state = await setupRepo(repo, ctx());
  assert.equal(ensures, 1);
  assert.ok(!state.steps.some((s) => s.name === "docker"));
});

test("docker is left alone with pull false", async () => {
  writeConfig({ docker: { pull: false } });
  await setupRepo(repo, ctx());
  assert.equal(ensures, 0);
});

test("apt-get is not run when every package is refused and there are no apt repos", async () => {
  writeConfig({ apt: ["Bad Name"] });
  const state = await setupRepo(repo, ctx());
  assert.ok(!log.some((l) => l.startsWith("apt-get")));
  assert.deepEqual(state.steps.filter((s) => s.name.startsWith("apt")).map((s) => s.name), ["apt package Bad Name"]);
});

test("files generated by setup steps are part of the fingerprint session compares", async () => {
  writeConfig({ setup: ["generate compose"] });
  const generating: Run = async (cmd, args, opts) => {
    if (cmd === "bash" && args[1] === "generate compose") {
      writeFileSync(join(repo, "docker-compose.yml"), "services:\n  db:\n    image: postgres:16\n");
    }
    await run(cmd, args, opts);
  };
  await setupRepo(repo, { ...ctx(), run: generating });
  const lines = await session(repo, { env: {}, toolsDir: tools, run, packageVersion: "1.0.0", docker: docker() });
  assert.ok(!lines.some((l) => l.includes("another configuration")), lines.join("\n"));
});
