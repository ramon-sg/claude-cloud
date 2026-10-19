/**
 * @file Finds the cloned repos, decides per repo whether this version runs setup or relaunches the
 * version the repo pins, and builds the paths and commands for that relaunch and for delegation.
 */
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type { readConfig } from "./config.ts";
import { CONFIG_FILE, PACKAGE } from "./constants.ts";
import type { Run } from "./run.ts";

/** Directory, inside the tools dir, that holds one installed copy of this package per version. */
const PKG_DIR = "pkg";

/** Name of the CLI executable. */
const BIN_NAME = "claude-cloud";

/** What setup does with one repo. */
export interface SetupPlanItem {
  /** Repo root. */
  repo: string;
  /** Run here, relaunch with another version, or skip. */
  action: "run" | "relaunch" | "skip";
  /** Version the repo asks for, when known. */
  version?: string;
  /** Why the repo is skipped. */
  reason?: string;
}

/**
 * Tells whether a path is a directory, following symlinks; never throws.
 *
 * @param path - Path to check.
 * @returns True for a directory.
 */
function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Lists the first-level folders of a home directory that are git repos.
 *
 * @param home - Directory holding the clones.
 * @returns Sorted absolute paths; empty when the directory cannot be read.
 * @example
 * findRepos("/home/user"); // ["/home/user/app"]
 */
export function findRepos(home: string): string[] {
  let names: string[];
  try {
    names = readdirSync(home);
  } catch {
    return [];
  }
  return names
    .map((name) => join(home, name))
    .filter((path) => isDirectory(path) && existsSync(join(path, ".git")))
    .sort();
}

/**
 * Decides, for each repo, whether to run setup here, relaunch another version or skip it.
 *
 * @param repos - Repo roots.
 * @param current - Version of this package.
 * @param read - Config reader (`readConfig`).
 * @returns One item per repo, in the same order.
 * @example
 * planSetup(["/home/user/app"], "1.0.0", readConfig); // [{ repo: "/home/user/app", action: "run", version: "1.0.0" }]
 */
export function planSetup(repos: string[], current: string, read: typeof readConfig): SetupPlanItem[] {
  return repos.map((repo): SetupPlanItem => {
    const { config, errors } = read(repo);
    if (!config) return { repo, action: "skip", reason: errors.length ? errors.join("; ") : `no ${CONFIG_FILE}` };
    if (config.version === current) return { repo, action: "run", version: current };
    return { repo, action: "relaunch", version: config.version };
  });
}

/**
 * Runs setup for one repo with the exact version it pins, through npx.
 * The version is already validated as exact semver and travels as one argv element.
 *
 * @param repo - Repo root.
 * @param version - Exact version from the repo config.
 * @param run - Process runner.
 * @param env - Environment for npx.
 * @returns Resolves when the relaunched setup exits with 0.
 * @throws When npx cannot run or exits with a non-zero code.
 * @example
 * await relaunch("/home/user/app", "1.2.0", runProcess, process.env);
 */
export function relaunch(repo: string, version: string, run: Run, env: NodeJS.ProcessEnv): Promise<void> {
  return run("npx", ["-y", `${PACKAGE}@${version}`, "setup", "--repo", repo], { env });
}

/**
 * Locates the directory where setup installs a given version of this package.
 *
 * @param toolsDir - Tools directory.
 * @param version - Package version.
 * @returns `<toolsDir>/pkg/<version>`.
 * @example
 * packageDir("/opt/claude-cloud", "1.0.0"); // "/opt/claude-cloud/pkg/1.0.0"
 */
export function packageDir(toolsDir: string, version: string): string {
  return join(toolsDir, PKG_DIR, version);
}

/**
 * Locates the CLI executable of an installed version of this package.
 *
 * @param toolsDir - Tools directory.
 * @param version - Package version.
 * @returns `<toolsDir>/pkg/<version>/node_modules/.bin/claude-cloud`.
 * @example
 * packageBin("/opt/claude-cloud", "1.0.0"); // "/opt/claude-cloud/pkg/1.0.0/node_modules/.bin/claude-cloud"
 */
export function packageBin(toolsDir: string, version: string): string {
  return join(packageDir(toolsDir, version), "node_modules", ".bin", BIN_NAME);
}

/**
 * Locates the copy of this package installed for a version.
 *
 * @param toolsDir - Tools directory.
 * @param version - Package version.
 * @returns `<toolsDir>/pkg/<version>/node_modules/@ramon-sg/claude-cloud`.
 * @example
 * packageInstallDir("/opt/claude-cloud", "1.0.0"); // "/opt/claude-cloud/pkg/1.0.0/node_modules/@ramon-sg/claude-cloud"
 */
export function packageInstallDir(toolsDir: string, version: string): string {
  return join(packageDir(toolsDir, version), "node_modules", ...PACKAGE.split("/"));
}

/**
 * Locates the directory of the stable link, which `session` puts on PATH.
 *
 * @param toolsDir - Tools directory.
 * @returns `<toolsDir>/bin`.
 * @example
 * linkDir("/opt/claude-cloud"); // "/opt/claude-cloud/bin"
 */
export function linkDir(toolsDir: string): string {
  return join(toolsDir, "bin");
}

/**
 * Locates the stable link that the repo hook calls.
 *
 * @param toolsDir - Tools directory.
 * @returns `<toolsDir>/bin/claude-cloud`.
 * @example
 * linkPath("/opt/claude-cloud"); // "/opt/claude-cloud/bin/claude-cloud"
 */
export function linkPath(toolsDir: string): string {
  return join(linkDir(toolsDir), BIN_NAME);
}
