/**
 * @file Tests for repo discovery, the setup plan and the relaunch command.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { readConfig } from "../src/config.ts";
import { findRepos, planSetup, relaunch } from "../src/launcher.ts";
import type { Run } from "../src/run.ts";

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "cc-launcher-"));
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

/**
 * Creates a repo under the temp home, optionally with a cloud.json.
 *
 * @param name - Folder name.
 * @param config - Raw config contents, or undefined for no file.
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

test("findRepos lists first-level folders with .git, sorted", () => {
  makeRepo("b");
  makeRepo("a");
  mkdirSync(join(home, "not-a-repo"));
  writeFileSync(join(home, "file"), "x");
  assert.deepEqual(findRepos(home), [join(home, "a"), join(home, "b")]);
});

test("findRepos returns an empty list for a missing home", () => {
  assert.deepEqual(findRepos(join(home, "missing")), []);
});

test("planSetup skips, runs and relaunches", () => {
  const none = makeRepo("none");
  const same = makeRepo("same", { version: "1.0.0" });
  const other = makeRepo("other", { version: "1.2.0" });
  const broken = makeRepo("broken", { version: "^1" });
  const plan = planSetup([none, same, other, broken], "1.0.0", readConfig);
  assert.deepEqual(plan[0], { repo: none, action: "skip", reason: "no .claude/cloud.json" });
  assert.deepEqual(plan[1], { repo: same, action: "run", version: "1.0.0" });
  assert.deepEqual(plan[2], { repo: other, action: "relaunch", version: "1.2.0" });
  assert.equal(plan[3]?.action, "skip");
  assert.match(plan[3]?.reason ?? "", /exact semver/);
});

test("relaunch passes the pinned package as a single npx argument", async () => {
  const calls: Array<{ cmd: string; args: string[] }> = [];
  const run: Run = async (cmd, args) => {
    calls.push({ cmd, args });
  };
  await relaunch("/home/user/app", "1.2.0", run, {});
  assert.deepEqual(calls, [
    { cmd: "npx", args: ["-y", "@ramon-sg/claude-cloud@1.2.0", "setup", "--repo", "/home/user/app"] },
  ]);
});
