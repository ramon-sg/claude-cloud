/**
 * @file Tests for tool version, image and default branch detection.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { defaultBranch, detectImages, readToolVersions } from "../src/detect.ts";

/**
 * Creates a temp directory holding the given files.
 *
 * @param files - Map of relative path to contents.
 * @returns The directory path.
 */
function makeRepo(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "detect-"));
  for (const [name, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, name)), { recursive: true });
    writeFileSync(join(dir, name), content);
  }
  return dir;
}

/**
 * Runs git with a fixed identity.
 *
 * @param cwd - Working directory.
 * @param args - Git arguments.
 */
function git(cwd: string, args: string[]): void {
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, stdio: "ignore" });
}

test("reads .tool-versions", () => {
  const repo = makeRepo({ ".tool-versions": "# c\nnodejs 24.14.1\nbun 1.4.2\n" });
  assert.deepEqual(readToolVersions(repo), { node: "24.14.1", bun: "1.4.2" });
});

test(".tool-versions wins over .nvmrc", () => {
  const repo = makeRepo({ ".tool-versions": "node 22.1.0\n", ".nvmrc": "v20.0.0\n" });
  assert.deepEqual(readToolVersions(repo), { node: "22.1.0" });
});

test(".nvmrc strips leading v", () => {
  assert.deepEqual(readToolVersions(makeRepo({ ".nvmrc": "v20.5.0\n" })), { node: "20.5.0" });
});

test("packageManager drops the hash", () => {
  const repo = makeRepo({ "package.json": JSON.stringify({ packageManager: "pnpm@9.1.0+sha512.abc" }) });
  assert.deepEqual(readToolVersions(repo), { pnpm: "9.1.0" });
});

test("mise.toml reads [tools] and ignores unknown tools", () => {
  const repo = makeRepo({ "mise.toml": '[tools]\nnode = "22.3.0"\npython = "3.12"\n[env]\nuv = "1"\n' });
  assert.deepEqual(readToolVersions(repo), { node: "22.3.0" });
});

test("detectImages merges compose and Dockerfile images", () => {
  const repo = makeRepo({
    "docker-compose.yml": 'services:\n  a:\n    image: postgres:16\n  b:\n    image: "${X}"\n',
    "packages/api/Dockerfile": "FROM oven/bun:1@sha256:abc AS base\n",
    "node_modules/x/Dockerfile": "FROM bad@sha256:zzz\n",
  });
  assert.deepEqual(detectImages(repo), ["oven/bun:1@sha256:abc", "postgres:16"]);
});

test("defaultBranch follows origin/HEAD", () => {
  const root = mkdtempSync(join(tmpdir(), "branch-"));
  const origin = join(root, "origin.git");
  const clone = join(root, "clone");
  git(root, ["init", "--bare", "-b", "main", origin]);
  git(root, ["clone", origin, clone]);
  git(clone, ["commit", "--allow-empty", "-m", "i"]);
  git(clone, ["push", "origin", "HEAD:main"]);
  git(clone, ["fetch", "origin"]);
  git(clone, ["update-ref", "refs/remotes/origin/trunk", "refs/remotes/origin/main"]);
  git(clone, ["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/trunk"]);
  assert.equal(defaultBranch(clone), "trunk");
});

test("defaultBranch falls back to main", () => {
  assert.equal(defaultBranch(makeRepo({})), "main");
});
