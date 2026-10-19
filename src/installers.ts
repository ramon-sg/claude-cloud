/**
 * @file Tool installers whose download sources pass the Claude cloud egress proxy
 * (nodejs.org, npm and PyPI; GitHub releases are blocked).
 */
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { TOOLS } from "./detect.ts";
import type { Tool } from "./detect.ts";
import type { Run } from "./run.ts";
import { step } from "./steps.ts";
import type { StepResult } from "./steps.ts";

/** Pinned versions by tool. */
type Versions = Partial<Record<Tool, string>>;

/** Base URL of the Node.js distribution. */
const NODE_DIST_URL = "https://nodejs.org/dist";

/** Node.js archive architectures by `process.arch`. */
const NODE_ARCHS: Readonly<Record<string, string>> = { x64: "x64", arm64: "arm64" };

/** Executable name checked for each tool to decide whether it is installed. */
const EXECUTABLES: Readonly<Record<Tool, string>> = {
  node: "node",
  bun: "bun",
  deno: "deno",
  pnpm: "pnpm",
  yarn: "yarn",
  uv: "uv",
};

/** npm package name for yarn 2 and later. */
const YARN_BERRY_PACKAGE = "@yarnpkg/cli-dist";

/** npm package that provides each npm-installed tool (yarn is resolved by version). */
const NPM_PACKAGES: Readonly<Record<"bun" | "deno" | "pnpm", string>> = {
  bun: "bun",
  deno: "deno",
  pnpm: "pnpm",
};

/** Strict shape of an accepted version: no leading `-` or `/`, no shell metacharacters. */
const VERSION_PATTERN = /^\d+(\.\d+){0,2}([-+][0-9A-Za-z.]+)?$/;

/** Script that downloads (`$1`) and extracts into a directory (`$2`); fails if curl fails. */
const NODE_INSTALL_SCRIPT = 'set -o pipefail; curl -fsSL -- "$1" | tar -xJ -C "$2" --strip-components=1';

/** Placeholder for `$0` in the node install script. */
const SCRIPT_NAME = "_";

/** Describes how one tool is installed and where its executables end up. */
export interface Installer {
  /**
   * Directory the tool version is installed into.
   *
   * @param toolsDir - Root directory holding all tools.
   * @param version - Tool version.
   * @returns The install directory.
   */
  dir(toolsDir: string, version: string): string;
  /**
   * Directory holding the tool's executables.
   *
   * @param toolsDir - Root directory holding all tools.
   * @param version - Tool version.
   * @returns The bin directory.
   */
  binDir(toolsDir: string, version: string): string;
  /**
   * Installs the tool version.
   *
   * @param toolsDir - Root directory holding all tools.
   * @param version - Tool version.
   * @param run - Process runner.
   * @param env - Environment for child processes.
   * @returns Resolves when installed.
   * @throws When the installation fails.
   */
  install(toolsDir: string, version: string, run: Run, env: NodeJS.ProcessEnv): Promise<void>;
}

/**
 * Maps a Node.js `process.arch` to the name used in its release archives.
 *
 * @param arch - Value of `process.arch`.
 * @returns The archive architecture.
 * @throws When the architecture has no Linux build we support.
 * @example
 * nodeArch("x64"); // "x64"
 */
export function nodeArch(arch: string): string {
  const mapped = NODE_ARCHS[arch];
  if (!mapped) throw new Error(`unsupported architecture for node: ${arch}`);
  return mapped;
}

/**
 * Checks that a version is safe to use in paths and command arguments.
 *
 * @param tool - Tool name, for the error message.
 * @param version - Version taken from an untrusted file.
 * @returns Nothing when valid.
 * @throws When the version does not match the strict pattern.
 * @example
 * assertVersion("node", "24.14.1"); // ok
 */
export function assertVersion(tool: string, version: string): void {
  if (!VERSION_PATTERN.test(version)) throw new Error(`invalid version for ${tool}: ${version}`);
}

/**
 * Tells whether a version is safe to use.
 *
 * @param version - Version taken from an untrusted file.
 * @returns True when it matches the strict pattern.
 */
function isValidVersion(version: string): boolean {
  return VERSION_PATTERN.test(version);
}

/**
 * Builds the default directory layout for a tool.
 *
 * @param tool - Tool name.
 * @param binSubdir - Path of the bin directory inside the install directory.
 * @returns The `dir` and `binDir` functions.
 */
function layout(tool: Tool, binSubdir: string): Pick<Installer, "dir" | "binDir"> {
  const dir = (toolsDir: string, version: string): string => {
    assertVersion(tool, version);
    return join(toolsDir, `${tool}-${version}`);
  };
  return { dir, binDir: (toolsDir, version) => join(dir(toolsDir, version), binSubdir) };
}

/**
 * Creates an installer that runs `npm install` into the tool's own prefix.
 *
 * @param tool - Tool name.
 * @param packageFor - Resolves the npm package name for a version.
 * @returns The installer.
 */
function npmInstaller(tool: Tool, packageFor: (version: string) => string): Installer {
  const base = layout(tool, join("node_modules", ".bin"));
  return {
    ...base,
    install: (toolsDir, version, run, env) =>
      run(
        "npm",
        ["install", "--prefix", base.dir(toolsDir, version), "--no-save", "--no-audit", "--no-fund", `${packageFor(version)}@${version}`],
        { env },
      ),
  };
}

const nodeLayout = layout("node", "bin");
const uvLayout = layout("uv", "bin");

/** Installers by tool. */
export const INSTALLERS: Record<Tool, Installer> = {
  node: {
    ...nodeLayout,
    install: (toolsDir, version, run, env) => {
      const target = nodeLayout.dir(toolsDir, version);
      const url = `${NODE_DIST_URL}/v${version}/node-v${version}-linux-${nodeArch(process.arch)}.tar.xz`;
      mkdirSync(target, { recursive: true });
      return run("bash", ["-c", NODE_INSTALL_SCRIPT, SCRIPT_NAME, url, target], { env });
    },
  },
  bun: npmInstaller("bun", () => NPM_PACKAGES.bun),
  deno: npmInstaller("deno", () => NPM_PACKAGES.deno),
  pnpm: npmInstaller("pnpm", () => NPM_PACKAGES.pnpm),
  yarn: npmInstaller("yarn", (version) => (version.split(".")[0] === "1" ? "yarn" : YARN_BERRY_PACKAGE)),
  uv: {
    ...uvLayout,
    install: (toolsDir, version, run, env) =>
      run("python3", ["-m", "pip", "install", "--target", uvLayout.dir(toolsDir, version), `uv==${version}`], { env }),
  },
};

/**
 * Prepends a directory to a PATH value.
 *
 * @param dir - Directory to put first.
 * @param path - Existing PATH, if any.
 * @returns The new PATH.
 */
function prependPath(dir: string, path: string | undefined): string {
  return path ? `${dir}:${path}` : dir;
}

/**
 * Installs the pinned tools: node first, then the rest in series.
 *
 * @param versions - Pinned versions by tool.
 * @param toolsDir - Root directory holding all tools.
 * @param run - Process runner.
 * @param env - Environment for child processes.
 * @returns One result per tool that needed installing; tools already present are skipped.
 * @example
 * await installTools({ node: "24.14.1" }, "/opt/claude-cloud", runProcess, process.env);
 */
export async function installTools(
  versions: Versions,
  toolsDir: string,
  run: Run,
  env: NodeJS.ProcessEnv,
): Promise<StepResult[]> {
  const results: StepResult[] = [];
  let childEnv = env;
  for (const tool of TOOLS) {
    const version = versions[tool];
    if (!version) continue;
    if (!isValidVersion(version)) {
      results.push(await step(`${tool} ${version}`, async () => assertVersion(tool, version)));
      continue;
    }
    const installer = INSTALLERS[tool];
    const binDir = installer.binDir(toolsDir, version);
    if (!existsSync(join(binDir, EXECUTABLES[tool]))) {
      results.push(await step(`${tool} ${version}`, () => installer.install(toolsDir, version, run, childEnv)));
    }
    if (tool === "node") childEnv = { ...env, PATH: prependPath(binDir, env.PATH) };
  }
  return results;
}

/**
 * Lists the bin directories of the pinned tools, in `TOOLS` order; invalid versions are skipped.
 *
 * @param versions - Pinned versions by tool.
 * @param toolsDir - Root directory holding all tools.
 * @returns The bin directories to put on PATH.
 * @example
 * toolBinDirs({ node: "24.14.1" }, "/opt/claude-cloud"); // ["/opt/claude-cloud/node-24.14.1/bin"]
 */
export function toolBinDirs(versions: Versions, toolsDir: string): string[] {
  return TOOLS.flatMap((tool) => {
    const version = versions[tool];
    return version && isValidVersion(version) ? [INSTALLERS[tool].binDir(toolsDir, version)] : [];
  });
}

/**
 * Builds the shell line that puts the pinned tools on PATH.
 *
 * @param versions - Pinned versions by tool.
 * @param toolsDir - Root directory holding all tools.
 * @returns An `export PATH=...` line with a literal `$PATH`, or an empty string when nothing valid is pinned; invalid versions are skipped.
 * @example
 * pathLine({ node: "24.14.1" }, "/opt/claude-cloud"); // export PATH="/opt/claude-cloud/node-24.14.1/bin:$PATH"
 */
export function pathLine(versions: Versions, toolsDir: string): string {
  const dirs = toolBinDirs(versions, toolsDir);
  return dirs.length ? `export PATH="${dirs.join(":")}:$PATH"` : "";
}
