/**
 * @file Tests for the step runner that turns thrown errors into results.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { step } from "../src/steps.ts";

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
