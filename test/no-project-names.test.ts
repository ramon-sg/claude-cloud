/**
 * @file Guards that no project-specific name leaks into the package sources.
 */
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";

const SRC_DIR = new URL("../src", import.meta.url).pathname;
const FORBIDDEN = /abastio/i;

/**
 * Lists every file under a directory, recursively.
 *
 * @param dir - Directory to walk.
 * @returns Absolute file paths.
 */
function listFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? listFiles(join(dir, entry.name)) : [join(dir, entry.name)],
  );
}

describe("no project names", () => {
  it("keeps src/ free of the forbidden name", () => {
    const offenders = listFiles(SRC_DIR).filter((file) => FORBIDDEN.test(readFileSync(file, "utf8")));
    assert.deepEqual(offenders, []);
  });
});
