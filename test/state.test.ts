/**
 * @file Tests for the machine fingerprint and the per-repo state file.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import type { CloudConfig } from "../src/config.ts";
import { fingerprint, readState, statePath, writeState } from "../src/state.ts";
import type { MachineState } from "../src/state.ts";

const BASE: CloudConfig = {
  version: "1.0.0",
  aptRepos: [],
  apt: ["jq"],
  docker: { pull: "auto" },
  setup: ["make"],
  session: [],
  requiredEnv: [],
};

let dir = "";
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "cc-state-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

test("fingerprint has the sha256- prefix", () => {
  assert.match(fingerprint(BASE, {}, [], "1.0.0"), /^sha256-[0-9a-f]{64}$/);
});

test("fingerprint ignores key order", () => {
  const reordered: CloudConfig = {
    requiredEnv: [],
    session: [],
    setup: ["make"],
    docker: { pull: "auto" },
    apt: ["jq"],
    aptRepos: [],
    version: "1.0.0",
  };
  assert.equal(
    fingerprint(BASE, { node: "20", bun: "1" }, [], "1.0.0"),
    fingerprint(reordered, { bun: "1", node: "20" }, [], "1.0.0"),
  );
});

test("fingerprint changes with apt, versions, images or package version", () => {
  const base = fingerprint(BASE, {}, [], "1.0.0");
  assert.notEqual(base, fingerprint({ ...BASE, apt: ["jq", "git"] }, {}, [], "1.0.0"));
  assert.notEqual(base, fingerprint(BASE, { node: "20" }, [], "1.0.0"));
  assert.notEqual(base, fingerprint(BASE, {}, ["img"], "1.0.0"));
  assert.notEqual(base, fingerprint(BASE, {}, [], "1.0.1"));
});

test("fingerprint ignores notes, session and requiredEnv", () => {
  const other: CloudConfig = { ...BASE, notes: "hi", session: ["x"], requiredEnv: ["Y"] };
  assert.equal(fingerprint(BASE, {}, [], "1.0.0"), fingerprint(other, {}, [], "1.0.0"));
});

test("statePath uses the repo basename under state/", () => {
  assert.equal(statePath("/opt/t", "/home/user/my-repo"), "/opt/t/state/my-repo.json");
});

test("readState returns undefined without a file", () => {
  assert.equal(readState(dir, "/x/repo"), undefined);
});

test("writeState then readState round-trips and leaves no temp files", () => {
  const state: MachineState = {
    fingerprint: "sha256-a",
    packageVersion: "1.0.0",
    finishedAt: "2026-01-01T00:00:00Z",
    steps: [{ name: "a", ok: true, ms: 1 }],
  };
  writeState(dir, "/x/repo", state);
  assert.deepEqual(readState(dir, "/x/repo"), state);
  assert.deepEqual(readdirSync(join(dir, "state")), ["repo.json"]);
});

test("readState returns undefined for invalid JSON or missing fields", () => {
  mkdirSync(join(dir, "state"));
  writeFileSync(statePath(dir, "/x/repo"), "{not json");
  assert.equal(readState(dir, "/x/repo"), undefined);
  writeFileSync(statePath(dir, "/x/repo"), JSON.stringify({ fingerprint: "a" }));
  assert.equal(readState(dir, "/x/repo"), undefined);
});
