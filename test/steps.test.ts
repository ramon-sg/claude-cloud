/**
 * @file Tests for the step runner that turns thrown errors into results.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { lanes, step } from "../src/steps.ts";
import type { StepResult } from "../src/steps.ts";

test("step reports success with the elapsed time", async () => {
  const result = await step("ok", async () => {});
  assert.equal(result.name, "ok");
  assert.equal(result.ok, true);
  assert.equal(result.error, undefined);
  assert.ok(result.ms >= 0);
});

test("step captures a thrown Error without rejecting", async () => {
  const result = await step("boom", async () => {
    throw new Error("it broke");
  });
  assert.equal(result.ok, false);
  assert.equal(result.error, "it broke");
});

test("step stringifies a thrown non-Error", async () => {
  const result = await step("odd", () => Promise.reject("plain text"));
  assert.equal(result.ok, false);
  assert.equal(result.error, "plain text");
});

/** Pause used to prove lanes run concurrently. */
const LANE_WAIT_MS = 50;

/**
 * Builds a lane that waits and then reports one step.
 *
 * @param name - Step name.
 * @returns A lane function.
 */
function waitingLane(name: string): () => Promise<StepResult[]> {
  return async () => [await step(name, () => new Promise<void>((r) => setTimeout(r, LANE_WAIT_MS)))];
}

test("lanes run concurrently and keep lane order", async () => {
  const start = Date.now();
  const results = await lanes(waitingLane("a"), waitingLane("b"));
  assert.ok(Date.now() - start < LANE_WAIT_MS * 2);
  assert.deepEqual(results.map((r) => r.name), ["a", "b"]);
});

test("lanes turn a rejecting lane into a failed result", async () => {
  const results = await lanes(waitingLane("a"), async () => {
    throw new Error("bad lane");
  });
  assert.deepEqual(results.map((r) => r.name), ["a", "lane 1"]);
  assert.equal(results[1]?.ok, false);
  assert.equal(results[1]?.error, "bad lane");
});
