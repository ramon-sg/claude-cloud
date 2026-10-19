/**
 * @file Tests for the command line wiring of setup, session and docker.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { main } from "../src/cli.ts";
import type { CliDeps } from "../src/cli.ts";
import type { Run } from "../src/run.ts";

let root: string;
let home: string;
let tools: string;
let calls: Array<{ cmd: string; args: string[] }>;
let envs: Array<NodeJS.ProcessEnv | undefined>;
let printed: string[];

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "cc-cli-"));
  home = join(root, "home");
  tools = join(root, "tools");
  mkdirSync(home);
  calls = [];
  envs = [];
  printed = [];
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const run: Run = async (cmd, args, opts) => {
  calls.push({ cmd, args });
  envs.push(opts?.env);
  if (args.includes("fail")) throw new Error("exit 1");
};

const deps = (up = true): CliDeps => ({
  env: { CLAUDE_CLOUD_DIR: tools, CLAUDE_CLOUD_HOME: home },
  run,
  docker: { start: () => undefined, ensure: async () => up },
  packageVersion: "1.0.0",
  print: (line) => printed.push(line),
  cwd: root,
});

/**
 * Creates a repo in the temp home.
 *
 * @param name - Folder name.
 * @param config - Raw cloud.json contents, or undefined for none.
 * @returns The repo path.
 */
function makeRepo(name: string, config?: unknown): string {
  const repo = join(home, name);
  mkdirSync(join(repo, ".git"), { recursive: true });
  if (config !== undefined) {
    mkdirSync(join(repo, ".claude"));
    writeFileSync(join(repo, ".claude/cloud.json"), JSON.stringify(config));
  }
  return repo;
}

test("setup --repo with another version runs anyway and warns, without relaunching", async () => {
  const repo = makeRepo("app", { version: "2.0.0", setup: ["echo hi"] });
  const code = await main(["setup", "--repo", repo], deps());
  assert.equal(code, 0);
  assert.ok(printed.includes("claude-cloud: running 1.0.0 although .claude/cloud.json asks for 2.0.0"));
  assert.ok(!calls.some((c) => c.cmd === "npx"));
  assert.ok(calls.some((c) => c.cmd === "bash" && c.args[1] === "echo hi"));
  assert.ok(printed.includes(`claude-cloud: setup ${repo}: 2 steps, 0 failed`));
});

test("setup without --repo skips, runs and relaunches in series and exits 0", async () => {
  const none = makeRepo("a-none");
  const same = makeRepo("b-same", { version: "1.0.0", setup: ["fail"] });
  const other = makeRepo("c-other", { version: "1.2.0" });
  const code = await main(["setup"], deps());
  assert.equal(code, 0);
  assert.ok(printed.includes(`claude-cloud: skipping ${none}: no .claude/cloud.json`));
  assert.ok(printed.includes(`claude-cloud: setup ${same}: 2 steps, 1 failed (setup: fail)`));
  assert.deepEqual(calls.at(-1), {
    cmd: "npx",
    args: ["-y", "@ramon-sg/claude-cloud@1.2.0", "setup", "--repo", other],
  });
});

test("a failed relaunch is reported and setup still exits 0", async () => {
  makeRepo("app", { version: "9.9.9" });
  const failing: Run = async () => {
    throw new Error("npx exited with code 1");
  };
  const code = await main(["setup"], { ...deps(), run: failing });
  assert.equal(code, 0);
  assert.ok(printed.some((l) => l.includes("relaunch") && l.includes("npx exited with code 1")));
});

test("session delegates to the installed version the repo asks for", async () => {
  const repo = makeRepo("app", { version: "1.5.0" });
  const bin = join(tools, "pkg", "1.5.0", "node_modules", ".bin");
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, "claude-cloud"), "");
  const code = await main(["session"], { ...deps(), env: { ...deps().env, CLAUDE_PROJECT_DIR: repo } });
  assert.equal(code, 0);
  assert.deepEqual(calls, [{ cmd: join(bin, "claude-cloud"), args: ["session"] }]);
  assert.equal(envs[0]?.CLAUDE_CLOUD_DELEGATED, "1");
  assert.deepEqual(printed, []);
});

test("a delegated session never delegates again", async () => {
  const repo = makeRepo("app", { version: "1.5.0" });
  const bin = join(tools, "pkg", "1.5.0", "node_modules", ".bin");
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, "claude-cloud"), "");
  const env = { ...deps().env, CLAUDE_PROJECT_DIR: repo, CLAUDE_CLOUD_DELEGATED: "1" };
  assert.equal(await main(["session"], { ...deps(), env }), 0);
  assert.ok(!calls.some((c) => c.cmd === join(bin, "claude-cloud")));
  assert.ok(printed[0]?.startsWith("claude-cloud: you are in a Claude Code cloud session"));
});

test("session runs itself when the asked version is not installed", async () => {
  const repo = makeRepo("app", { version: "1.5.0" });
  const code = await main(["session"], { ...deps(), env: { ...deps().env, CLAUDE_PROJECT_DIR: repo } });
  assert.equal(code, 0);
  assert.ok(printed[0]?.startsWith("claude-cloud: you are in a Claude Code cloud session"));
});

test("docker exits 0 when it responds and 1 with the log path otherwise", async () => {
  assert.equal(await main(["docker"], deps()), 0);
  assert.equal(await main(["docker"], deps(false)), 1);
  assert.ok(printed.includes("claude-cloud: dockerd did not start; see /var/log/claude-cloud-dockerd.log"));
});

test("--version prints the package version and unknown commands exit 1", async () => {
  assert.equal(await main(["--version"], deps()), 0);
  assert.equal(printed[0], "1.0.0");
  assert.equal(await main(["bogus"], deps()), 1);
});

test("setup --repo without a value prints an error and runs nothing", async () => {
  makeRepo("app", { version: "1.0.0" });
  assert.equal(await main(["setup", "--repo"], deps()), 0);
  assert.equal(await main(["setup", "--repo", "--other"], deps()), 0);
  assert.deepEqual(printed, ["claude-cloud: --repo needs a path", "claude-cloud: --repo needs a path"]);
  assert.deepEqual(calls, []);
});

test("setup --repo resolves a relative path against the cwd", async () => {
  makeRepo("app", { version: "1.0.0" });
  assert.equal(await main(["setup", "--repo", "home/app"], deps()), 0);
  assert.ok(printed.includes(`claude-cloud: setup ${join(home, "app")}: 1 steps, 0 failed`));
});

test("a repo that throws does not stop the next ones", async () => {
  const first = makeRepo("a-first", { version: "1.0.0" });
  const second = makeRepo("b-second", { version: "1.2.0" });
  const throwing = (line: string): void => {
    if (line.includes(`setup ${first}:`)) throw new Error("boom");
    printed.push(line);
  };
  assert.equal(await main(["setup"], { ...deps(), print: throwing }), 0);
  assert.ok(printed.includes(`claude-cloud: setup error for ${first}: boom`));
  assert.deepEqual(calls.at(-1), { cmd: "npx", args: ["-y", "@ramon-sg/claude-cloud@1.2.0", "setup", "--repo", second] });
});
