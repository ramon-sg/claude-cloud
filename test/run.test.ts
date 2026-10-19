/**
 * @file Tests for the process runner: output modes, the time limit and stdout capture.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { RunTimeoutError, captureProcess, runProcess } from "../src/run.ts";

/** Absolute URL of the runner module, imported by the child scripts. */
const RUN_MODULE = new URL("../src/run.ts", import.meta.url).href;

/**
 * Runs `runProcess("sh", ["-c", <command>], opts)` in a child node and returns what reached its
 * stdout and its stderr.
 *
 * @param command - Shell command for the inner process.
 * @param opts - Options literal passed to `runProcess`.
 * @returns The child's stdout and stderr.
 */
function inChild(command: string, opts: string): { stdout: string; stderr: string } {
  const script = `import { runProcess } from ${JSON.stringify(RUN_MODULE)};
await runProcess("sh", ["-c", ${JSON.stringify(command)}], ${opts});`;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return { stdout: result.stdout, stderr: result.stderr };
}

test("stdio stderr sends the child's stdout to our stderr, never to our stdout", () => {
  assert.deepEqual(inChild("echo routed", '{ stdio: "stderr" }'), { stdout: "", stderr: "routed\n" });
});

test("the default stdio inherits our stdout", () => {
  assert.deepEqual(inChild("echo hello", "{}"), { stdout: "hello\n", stderr: "" });
});

test("a run past its time limit is killed and rejects with RunTimeoutError", async () => {
  const start = Date.now();
  await assert.rejects(runProcess("sh", ["-c", "sleep 5"], { timeoutMs: 100, stdio: "stderr" }), RunTimeoutError);
  assert.ok(Date.now() - start < 2000);
});

test("a run within its time limit resolves", async () => {
  await runProcess("sh", ["-c", "exit 0"], { timeoutMs: 5000, stdio: "stderr" });
});

test("captureProcess returns stdout and rejects on a non-zero exit", async () => {
  assert.equal(await captureProcess("sh", ["-c", "printf 403"]), "403");
  await assert.rejects(captureProcess("sh", ["-c", "printf x; exit 7"]), /code 7/);
});
