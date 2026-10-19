/**
 * @file Tests for the proxy-safe tool installers, using a recording `Run`.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { INSTALLERS, installTools, nodeArch, pathLine } from "../src/installers.ts";

/** One recorded process call. */
interface Call {
  cmd: string;
  args: string[];
  env?: NodeJS.ProcessEnv;
}

/**
 * Builds a `Run` that records calls instead of spawning.
 *
 * @returns The recorder and its calls.
 */
function recorder(): { calls: Call[]; run: (cmd: string, args: string[], opts?: { env?: NodeJS.ProcessEnv }) => Promise<void> } {
  const calls: Call[] = [];
  return {
    calls,
    run: async (cmd, args, opts) => {
      calls.push({ cmd, args, env: opts?.env });
    },
  };
}

/**
 * Creates an empty temp tools directory.
 *
 * @returns Its path.
 */
function toolsDir(): string {
  return mkdtempSync(join(tmpdir(), "installers-"));
}

const ARCH = process.arch === "arm64" ? "arm64" : "x64";

test("node installs from nodejs.org through bash", async () => {
  const dir = toolsDir();
  const { calls, run } = recorder();
  const results = await installTools({ node: "24.14.1" }, dir, run, { PATH: "/usr/bin" });
  const target = join(dir, "node-24.14.1");
  assert.equal(results.length, 1);
  assert.equal(results[0]?.name, "node 24.14.1");
  assert.equal(results[0]?.ok, true);
  assert.deepEqual(calls[0]?.cmd, "bash");
  assert.deepEqual(calls[0]?.args, [
    "-c",
    `curl -fsSL https://nodejs.org/dist/v24.14.1/node-v24.14.1-linux-${ARCH}.tar.xz | tar -xJ -C ${target} --strip-components=1`,
  ]);
});

test("nodeArch maps x64 and arm64 and rejects the rest", () => {
  assert.equal(nodeArch("x64"), "x64");
  assert.equal(nodeArch("arm64"), "arm64");
  assert.throws(() => nodeArch("ia32"), /unsupported architecture/);
});

test("bun uses the pinned node npm at the front of PATH", async () => {
  const dir = toolsDir();
  const { calls, run } = recorder();
  const results = await installTools({ node: "24.14.1", bun: "1.4.2" }, dir, run, { PATH: "/usr/bin" });
  assert.deepEqual(results.map((r) => r.name), ["node 24.14.1", "bun 1.4.2"]);
  const bun = calls[1];
  const prefix = join(dir, "bun-1.4.2");
  assert.equal(bun?.cmd, "npm");
  assert.deepEqual(bun?.args, ["install", "--prefix", prefix, "--no-save", "--no-audit", "--no-fund", "bun@1.4.2"]);
  assert.equal(bun?.env?.PATH, `${join(dir, "node-24.14.1", "bin")}:/usr/bin`);
});

test("bun without pinned node uses the npm already on PATH", async () => {
  const dir = toolsDir();
  const { calls, run } = recorder();
  await installTools({ bun: "1.4.2" }, dir, run, { PATH: "/usr/bin" });
  assert.equal(calls[0]?.env?.PATH, "/usr/bin");
});

test("an installed tool is skipped and produces no result", async () => {
  const dir = toolsDir();
  const bin = INSTALLERS.bun.binDir(dir, "1.4.2");
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, "bun"), "");
  const { calls, run } = recorder();
  const results = await installTools({ bun: "1.4.2" }, dir, run, { PATH: "/usr/bin" });
  assert.deepEqual(calls, []);
  assert.deepEqual(results, []);
});

test("yarn 4 installs @yarnpkg/cli-dist and yarn 1 installs yarn", async () => {
  const dir = toolsDir();
  const four = recorder();
  await installTools({ yarn: "4.1.0" }, dir, four.run, { PATH: "/usr/bin" });
  assert.equal(four.calls[0]?.args.at(-1), "@yarnpkg/cli-dist@4.1.0");
  const one = recorder();
  await installTools({ yarn: "1.22.22" }, dir, one.run, { PATH: "/usr/bin" });
  assert.equal(one.calls[0]?.args.at(-1), "yarn@1.22.22");
});

test("uv installs with pip into its directory", async () => {
  const dir = toolsDir();
  const { calls, run } = recorder();
  await installTools({ uv: "0.5.0" }, dir, run, { PATH: "/usr/bin" });
  assert.equal(calls[0]?.cmd, "python3");
  assert.deepEqual(calls[0]?.args, ["-m", "pip", "install", "--target", join(dir, "uv-0.5.0"), "uv==0.5.0"]);
  assert.equal(INSTALLERS.uv.binDir(dir, "0.5.0"), join(dir, "uv-0.5.0", "bin"));
});

test("a failing install becomes a failed result, not a rejection", async () => {
  const dir = toolsDir();
  const results = await installTools({ deno: "2.0.0" }, dir, async () => {
    throw new Error("network down");
  }, { PATH: "/usr/bin" });
  assert.equal(results[0]?.ok, false);
  assert.equal(results[0]?.error, "network down");
});

test("pathLine lists bin dirs in tool order with a literal $PATH", () => {
  assert.equal(
    pathLine({ bun: "1.4.2", node: "24.14.1" }, "/t"),
    'export PATH="/t/node-24.14.1/bin:/t/bun-1.4.2/node_modules/.bin:$PATH"',
  );
  assert.equal(pathLine({}, "/t"), "");
});
