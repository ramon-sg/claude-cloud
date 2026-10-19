/**
 * @file Tests for the Docker starter with a fake command probe.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { DOCKERD_MISSING, ensureDocker, startDockerDetached } from "../src/docker.ts";
import type { Probe } from "../src/docker.ts";

/** Probe of a machine without Docker: every command fails. */
const nothingInstalled: Probe = () => false;

test("without a dockerd on PATH, start reports it is not installed", () => {
  assert.equal(startDockerDetached(nothingInstalled), DOCKERD_MISSING);
});

test("start does nothing when Docker already answers", () => {
  assert.equal(startDockerDetached((cmd) => cmd === "docker"), undefined);
});

test("ensureDocker returns false at once when dockerd is not installed", async () => {
  const start = Date.now();
  assert.equal(await ensureDocker(nothingInstalled), false);
  assert.ok(Date.now() - start < 1000);
});
