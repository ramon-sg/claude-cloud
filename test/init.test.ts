/**
 * @file Tests for `init`: scaffolds cloud.json and registers the SessionStart hook once.
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { init } from "../src/init.ts";

let repo: string;

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), "cc-init-"));
});
afterEach(() => rmSync(repo, { recursive: true, force: true }));

const settings = (): { hooks: { SessionStart: Array<{ hooks: Array<{ command: string; timeout: number; type: string }> }> } } =>
  JSON.parse(readFileSync(join(repo, ".claude/settings.json"), "utf8"));

test("creates cloud.json and the hook; a second run changes nothing", () => {
  const first = init(repo, "1.2.3");
  assert.equal(first.ok, true);
  const config = JSON.parse(readFileSync(join(repo, ".claude/cloud.json"), "utf8"));
  assert.equal(config.$schema, "https://unpkg.com/@ramon-sg/claude-cloud@1.2.3/schema.json");
  assert.equal(config.version, "1.2.3");
  assert.deepEqual(config.docker, { pull: "auto" });
  assert.ok(readFileSync(join(repo, ".claude/cloud.json"), "utf8").endsWith("}\n"));
  const entry = settings().hooks.SessionStart[0]?.hooks[0];
  assert.equal(entry?.timeout, 600);
  assert.equal(entry?.type, "command");
  assert.ok(entry?.command.includes("claude-cloud session"));
  const second = init(repo, "1.2.3");
  assert.equal(settings().hooks.SessionStart.length, 1);
  assert.ok(second.lines.length > 0);
});

test("does not overwrite an existing cloud.json", () => {
  mkdirSync(join(repo, ".claude"));
  writeFileSync(join(repo, ".claude/cloud.json"), '{"version":"0.0.1"}');
  init(repo, "1.0.0");
  assert.equal(readFileSync(join(repo, ".claude/cloud.json"), "utf8"), '{"version":"0.0.1"}');
});

test("keeps other settings and other SessionStart hooks", () => {
  mkdirSync(join(repo, ".claude"));
  writeFileSync(
    join(repo, ".claude/settings.json"),
    JSON.stringify({ permissions: { allow: ["Bash"] }, hooks: { SessionStart: [{ hooks: [{ type: "command", command: "echo hi" }] }], Stop: [] } }),
  );
  init(repo, "1.0.0");
  const s = settings() as unknown as Record<string, unknown> & ReturnType<typeof settings>;
  assert.equal(s.hooks.SessionStart.length, 2);
  assert.equal(s.hooks.SessionStart[0]?.hooks[0]?.command, "echo hi");
  assert.deepEqual(s.permissions, { allow: ["Bash"] });
  assert.ok("Stop" in s.hooks);
});

test("leaves an invalid settings.json untouched and reports it", () => {
  mkdirSync(join(repo, ".claude"));
  writeFileSync(join(repo, ".claude/settings.json"), "{ nope");
  const result = init(repo, "1.0.0");
  assert.equal(result.ok, false);
  assert.equal(readFileSync(join(repo, ".claude/settings.json"), "utf8"), "{ nope");
  assert.ok(existsSync(join(repo, ".claude/cloud.json")));
});

test("settings.json values that are not the expected shape are left untouched", () => {
  for (const text of ["null", '"x"', '{"hooks":"x"}', '{"hooks":{"SessionStart":{}}}']) {
    mkdirSync(join(repo, ".claude"), { recursive: true });
    writeFileSync(join(repo, ".claude/settings.json"), text);
    const result = init(repo, "1.0.0");
    assert.equal(result.ok, false, text);
    assert.equal(readFileSync(join(repo, ".claude/settings.json"), "utf8"), text);
    const line = result.lines.at(-1) ?? "";
    assert.ok(line.includes("by hand"), line);
    assert.ok(line.includes("claude-cloud session") && line.includes('"timeout":600'), line);
  }
});
