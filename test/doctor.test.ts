/**
 * @file Tests for the doctor diagnostics, with a fake fetch and a fake Docker probe.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { doctor } from "../src/doctor.ts";
import type { DoctorContext } from "../src/doctor.ts";
import { configImages } from "../src/detect.ts";
import { readConfig } from "../src/config.ts";
import { fingerprint, writeState } from "../src/state.ts";

let root: string;
let repo: string;
let tools: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "cc-doctor-"));
  repo = join(root, "app");
  tools = join(root, "tools");
  mkdirSync(join(repo, ".claude"), { recursive: true });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const STATUS: Record<string, number> = {
  "registry.npmjs.org": 200,
  "api.github.com": 403,
  "registry-1.docker.io": 401,
};

const fakeFetch = (async (url: string | URL | Request) => {
  const host = new URL(String(url)).hostname;
  if (host === "pypi.org") throw new Error("network down");
  return new Response(null, { status: STATUS[host] ?? 200 });
}) as typeof fetch;

const ctx = (docker = true): DoctorContext => ({ fetch: fakeFetch, toolsDir: tools, packageVersion: "1.0.0", dockerInfo: () => docker });

test("reports each domain as ok or blocked and fails when any is blocked", async () => {
  writeFileSync(join(repo, ".claude/cloud.json"), JSON.stringify({ version: "1.0.0" }));
  const { lines, ok } = await doctor(repo, ctx());
  const has = (text: string): boolean => lines.some((l) => l.startsWith("claude-cloud: ") && l.includes(text));
  assert.ok(has("registry.npmjs.org: ok"));
  assert.ok(has("registry-1.docker.io: ok"));
  assert.ok(has("api.github.com: blocked"));
  assert.ok(has("pypi.org: blocked"));
  assert.equal(ok, false);
});

test("a repo without cloud.json is a failed check, not an exception", async () => {
  const { lines, ok } = await doctor(repo, ctx());
  assert.equal(ok, false);
  assert.ok(lines.some((l) => l.includes("cloud.json") && l.includes("missing")));
});

test("checks tools, docker, fingerprint and step durations", async () => {
  writeFileSync(join(repo, ".claude/cloud.json"), JSON.stringify({ version: "1.0.0" }));
  writeFileSync(join(repo, ".tool-versions"), "nodejs 24.14.1\n");
  const config = readConfig(repo).config!;
  const fp = fingerprint(config, { node: "24.14.1" }, configImages(config, repo), "1.0.0");
  writeState(tools, repo, {
    fingerprint: fp,
    packageVersion: "1.0.0",
    finishedAt: "2026-01-01T00:00:00.000Z",
    steps: [{ name: "apt", ok: true, ms: 1500 }, { name: "pull", ok: false, ms: 20, error: "x" }],
  });
  let result = await doctor(repo, ctx(false));
  assert.ok(result.lines.some((l) => l.includes("node 24.14.1: missing")));
  assert.ok(result.lines.some((l) => l.includes("docker: missing")));
  assert.ok(result.lines.some((l) => l.includes("fingerprint: ok")));
  assert.ok(result.lines.some((l) => l.includes("step apt: ok") && l.includes("1.5s")));
  assert.ok(result.lines.some((l) => l.includes("step pull: failed")));
  mkdirSync(join(tools, "node-24.14.1/bin"), { recursive: true });
  writeFileSync(join(tools, "node-24.14.1/bin/node"), "");
  result = await doctor(repo, ctx(true));
  assert.ok(result.lines.some((l) => l.includes("node 24.14.1: ok")));
  assert.ok(result.lines.some((l) => l.includes("docker: ok")));
  writeFileSync(join(repo, ".claude/cloud.json"), JSON.stringify({ version: "1.0.0", apt: ["jq"] }));
  result = await doctor(repo, ctx());
  assert.ok(result.lines.some((l) => l.includes("fingerprint: mismatch")));
});
