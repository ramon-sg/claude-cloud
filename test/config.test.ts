/**
 * @file Tests for the cloud config reader and its JSON schema.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { CONFIG_KEYS, readConfig } from "../src/config.ts";

const tmpDirs: string[] = [];

/**
 * Creates a temporary repo, optionally with a `.claude/cloud.json` file.
 *
 * @param content - Raw file content, or undefined for no file.
 * @returns Absolute path of the temporary repo.
 */
function makeRepo(content?: string): string {
  const repo = mkdtempSync(join(tmpdir(), "claude-cloud-config-"));
  tmpDirs.push(repo);
  if (content === undefined) return repo;
  mkdirSync(join(repo, ".claude"));
  writeFileSync(join(repo, ".claude", "cloud.json"), content);
  return repo;
}

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("readConfig", () => {
  it("returns no config and no errors when the file is missing", () => {
    assert.deepEqual(readConfig(makeRepo()), { errors: [] });
  });

  it("reads a complete valid file", () => {
    const full = {
      version: "1.2.3",
      aptRepos: ["deb http://example.com stable main"],
      apt: ["jq"],
      docker: { pull: ["postgres:16"] },
      setup: ["npm ci"],
      session: ["npm run dev"],
      requiredEnv: ["TOKEN"],
      notes: "hello",
    };
    const result = readConfig(makeRepo(JSON.stringify({ $schema: "./schema.json", ...full })));
    assert.deepEqual(result, { config: full, errors: [] });
  });

  it("accepts docker.pull as auto or false", () => {
    const auto = readConfig(makeRepo(JSON.stringify({ version: "1.0.0", docker: { pull: "auto" } })));
    const off = readConfig(makeRepo(JSON.stringify({ version: "1.0.0", docker: { pull: false } })));
    assert.deepEqual(auto.config?.docker, { pull: "auto" });
    assert.deepEqual(off.config?.docker, { pull: false });
  });

  it("fills defaults when only version is given", () => {
    const result = readConfig(makeRepo(JSON.stringify({ version: "1.0.0" })));
    assert.deepEqual(result, {
      config: {
        version: "1.0.0",
        aptRepos: [],
        apt: [],
        docker: { pull: "auto" },
        setup: [],
        session: [],
        requiredEnv: [],
      },
      errors: [],
    });
  });

  it("reports unknown fields but keeps the config", () => {
    const result = readConfig(makeRepo(JSON.stringify({ version: "1.0.0", apts: [] })));
    assert.deepEqual(result.errors, ['.claude/cloud.json: unknown field "apts"']);
    assert.equal(result.config?.version, "1.0.0");
  });

  it("reports fields of the wrong type", () => {
    const result = readConfig(makeRepo(JSON.stringify({ version: "1.0.0", apt: "jq", notes: 3 })));
    assert.deepEqual(result.errors, [
      '.claude/cloud.json: "apt" must be an array of strings',
      '.claude/cloud.json: "notes" must be a string',
    ]);
    assert.deepEqual(result.config?.apt, []);
  });

  it("rejects a non-exact version and returns no config", () => {
    const result = readConfig(makeRepo(JSON.stringify({ version: "^1" })));
    assert.equal(result.config, undefined);
    assert.equal(result.errors.length, 1);
    assert.match(result.errors[0] ?? "", /^\.claude\/cloud\.json: "version" must be/);
  });

  it("requires version", () => {
    const result = readConfig(makeRepo("{}"));
    assert.equal(result.config, undefined);
    assert.match(result.errors[0] ?? "", /"version" must be/);
  });

  it("reports broken JSON as a single error", () => {
    const result = readConfig(makeRepo("{ nope"));
    assert.equal(result.config, undefined);
    assert.equal(result.errors.length, 1);
    assert.match(result.errors[0] ?? "", /^\.claude\/cloud\.json: /);
  });

  it("rejects a top-level value that is not an object", () => {
    const result = readConfig(makeRepo("[]"));
    assert.equal(result.config, undefined);
    assert.equal(result.errors.length, 1);
  });
});

describe("schema.json", () => {
  it("lists the same keys as CONFIG_KEYS (plus $schema)", () => {
    const schema = JSON.parse(readFileSync(new URL("../schema.json", import.meta.url), "utf8")) as {
      properties: Record<string, unknown>;
    };
    const keys = Object.keys(schema.properties).filter((key) => key !== "$schema");
    assert.deepEqual([...keys].sort(), [...CONFIG_KEYS].sort());
    assert.ok("$schema" in schema.properties);
  });
});
