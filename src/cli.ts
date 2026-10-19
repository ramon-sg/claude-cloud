#!/usr/bin/env node
/**
 * @file Command line entry point of claude-cloud: wires `setup`, `session` and `docker` to their
 * modules, relaunching or delegating to the version each repo pins.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { readConfig } from "./config.ts";
import { CONFIG_FILE, DOCKERD_LOG, OUTPUT_PREFIX, homeDir, toolsDir } from "./constants.ts";
import { doctor } from "./doctor.ts";
import { dockerResponds, realDocker } from "./docker.ts";
import type { DockerOps } from "./docker.ts";
import { init } from "./init.ts";
import { findRepos, packageBin, planSetup, relaunch } from "./launcher.ts";
import type { SetupPlanItem } from "./launcher.ts";
import { runProcess } from "./run.ts";
import type { Run } from "./run.ts";
import { session } from "./session.ts";
import { setupRepo } from "./setup.ts";

/** Help text shown by `--help`. */
const HELP = `${OUTPUT_PREFIX}prepares Claude Code cloud sessions.

Usage: claude-cloud <command>

Commands:
  setup [--repo <path>]  prepare the machine for every repo in the home dir (or only <path>)
  session                report the machine state and wire the tools into the session
  docker                 start the Docker daemon and wait until it answers
  doctor                 check the network allowlist, tools, Docker and the machine state
  init                   create .claude/cloud.json and register the SessionStart hook

Options:
  --help                 show this help
  --version              print the package version
`;

/** Environment variable with the project dir that Claude Code passes to hooks. */
const PROJECT_DIR_VAR = "CLAUDE_PROJECT_DIR";

/** Environment marker set on a delegated `session`, so it never delegates again. */
export const DELEGATED_ENV = "CLAUDE_CLOUD_DELEGATED";

/** Value of `DELEGATED_ENV` that marks a delegated run. */
const DELEGATED_VALUE = "1";

/** Option that limits setup to one repo. */
const REPO_OPTION = "--repo";

/** Timeout of the git call that finds the repo root, in milliseconds. */
const GIT_TIMEOUT_MS = 10_000;

/** Exit code for success. */
const EXIT_OK = 0;

/** Exit code for failure or wrong usage. */
const EXIT_FAIL = 1;

/** Everything the CLI needs from the outside, so tests can inject fakes. */
export interface CliDeps {
  /** Process environment. */
  env: NodeJS.ProcessEnv;
  /** Process runner. */
  run: Run;
  /** Docker operations. */
  docker: DockerOps;
  /** Version of this package. */
  packageVersion: string;
  /** Prints one line on stdout. */
  print: (line: string) => void;
  /** Fetch used by `doctor`; the global one when omitted. */
  fetch?: typeof fetch;
  /** Docker probe used by `doctor`; `docker info` when omitted. */
  dockerInfo?: () => boolean;
  /** Working directory, used to find the repo when `CLAUDE_PROJECT_DIR` is not set. */
  cwd: string;
}

/**
 * Reads the package version from the package.json next to `src/` or `dist/`.
 *
 * @returns The version string.
 * @throws When package.json cannot be read or parsed.
 */
function readVersion(): string {
  const file = new URL("../package.json", import.meta.url);
  const pkg = JSON.parse(readFileSync(file, "utf8")) as { version: string };
  return pkg.version;
}

/**
 * Turns an unknown error into its message.
 *
 * @param err - Anything thrown.
 * @returns The message.
 */
function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Runs setup for one repo with this version and prints its summary.
 *
 * @param repo - Repo root.
 * @param deps - CLI dependencies.
 */
async function runOne(repo: string, deps: CliDeps): Promise<void> {
  const { config, errors } = readConfig(repo);
  for (const error of errors) deps.print(`${OUTPUT_PREFIX}${repo}: ${error}`);
  if (config && config.version !== deps.packageVersion) {
    deps.print(`${OUTPUT_PREFIX}running ${deps.packageVersion} although ${CONFIG_FILE} asks for ${config.version}`);
  }
  const state = await setupRepo(repo, {
    toolsDir: toolsDir(deps.env),
    run: deps.run,
    packageVersion: deps.packageVersion,
    env: deps.env,
    docker: deps.docker,
  });
  const failed = state.steps.filter((s) => !s.ok).map((s) => s.name);
  const detail = failed.length ? ` (${failed.join(", ")})` : "";
  deps.print(`${OUTPUT_PREFIX}setup ${repo}: ${state.steps.length} steps, ${failed.length} failed${detail}`);
}

/**
 * Carries out one item of the setup plan; may throw, the caller reports it and moves on.
 *
 * @param item - Plan item.
 * @param deps - CLI dependencies.
 */
async function runPlanItem(item: SetupPlanItem, deps: CliDeps): Promise<void> {
  if (item.action === "skip") {
    deps.print(`${OUTPUT_PREFIX}skipping ${item.repo}: ${item.reason ?? ""}`);
    return;
  }
  if (item.action === "run" || !item.version) {
    await runOne(item.repo, deps);
    return;
  }
  deps.print(`${OUTPUT_PREFIX}relaunching with ${item.version} for ${item.repo}`);
  try {
    await relaunch(item.repo, item.version, deps.run, deps.env);
  } catch (err) {
    deps.print(`${OUTPUT_PREFIX}relaunch with ${item.version} for ${item.repo} failed: ${message(err)}`);
  }
}

/**
 * Runs `setup`: one repo with `--repo`, otherwise every repo of the home dir in series (apt
 * cannot run twice at once). Always exits 0: a failure is reported, never fatal.
 *
 * @param args - Arguments after `setup`.
 * @param deps - CLI dependencies.
 * @returns Exit code 0.
 */
async function setupCommand(args: string[], deps: CliDeps): Promise<number> {
  try {
    const at = args.indexOf(REPO_OPTION);
    if (at >= 0) {
      const value = args[at + 1];
      if (!value || value.startsWith("-")) deps.print(`${OUTPUT_PREFIX}${REPO_OPTION} needs a path`);
      else await runOne(resolve(deps.cwd, value), deps);
      return EXIT_OK;
    }
    const repos = findRepos(homeDir(deps.env));
    if (!repos.length) deps.print(`${OUTPUT_PREFIX}no repos found in ${homeDir(deps.env)}`);
    for (const item of planSetup(repos, deps.packageVersion, readConfig)) {
      try {
        await runPlanItem(item, deps);
      } catch (err) {
        deps.print(`${OUTPUT_PREFIX}setup error for ${item.repo}: ${message(err)}`);
      }
    }
  } catch (err) {
    deps.print(`${OUTPUT_PREFIX}setup error: ${message(err)}`);
  }
  return EXIT_OK;
}

/**
 * Finds the repo of the session: `CLAUDE_PROJECT_DIR`, else the git toplevel, else the cwd.
 *
 * @param deps - CLI dependencies.
 * @returns The repo root.
 */
function sessionRepo(deps: CliDeps): string {
  const fromEnv = deps.env[PROJECT_DIR_VAR];
  if (fromEnv) return fromEnv;
  try {
    return execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd: deps.cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: GIT_TIMEOUT_MS,
    }).trim();
  } catch {
    return deps.cwd;
  }
}

/**
 * Runs `session`, delegating to the installed version the repo pins when it differs from this
 * one. A delegated run carries `DELEGATED_ENV` and never delegates again, so two versions can
 * not bounce between each other. Always exits 0 so the session start is never blocked.
 *
 * @param deps - CLI dependencies.
 * @returns Exit code 0.
 */
async function sessionCommand(deps: CliDeps): Promise<number> {
  const repo = sessionRepo(deps);
  const tools = toolsDir(deps.env);
  const wanted = readConfig(repo).config?.version;
  const delegated = deps.env[DELEGATED_ENV] === DELEGATED_VALUE;
  if (!delegated && wanted && wanted !== deps.packageVersion && existsSync(packageBin(tools, wanted))) {
    try {
      await deps.run(packageBin(tools, wanted), ["session"], { env: { ...deps.env, [DELEGATED_ENV]: DELEGATED_VALUE } });
    } catch (err) {
      deps.print(`${OUTPUT_PREFIX}session ${wanted} failed: ${message(err)}`);
    }
    return EXIT_OK;
  }
  const lines = await session(repo, { env: deps.env, toolsDir: tools, run: deps.run, packageVersion: deps.packageVersion, docker: deps.docker });
  for (const line of lines) deps.print(line);
  return EXIT_OK;
}

/**
 * Runs `docker`: starts the daemon and waits for it.
 *
 * @param deps - CLI dependencies.
 * @returns 0 when Docker answers, 1 otherwise.
 */
async function dockerCommand(deps: CliDeps): Promise<number> {
  if (await deps.docker.ensure().catch(() => false)) return EXIT_OK;
  deps.print(`${OUTPUT_PREFIX}dockerd did not start; see ${DOCKERD_LOG}`);
  return EXIT_FAIL;
}

/**
 * Runs `doctor` for the session repo.
 *
 * @param deps - CLI dependencies.
 * @returns 0 when every check passes, 1 otherwise.
 */
async function doctorCommand(deps: CliDeps): Promise<number> {
  const result = await doctor(sessionRepo(deps), {
    fetch: deps.fetch ?? fetch,
    toolsDir: toolsDir(deps.env),
    packageVersion: deps.packageVersion,
    dockerInfo: deps.dockerInfo ?? dockerResponds,
  });
  for (const line of result.lines) deps.print(line);
  return result.ok ? EXIT_OK : EXIT_FAIL;
}

/**
 * Runs `init` for the session repo.
 *
 * @param deps - CLI dependencies.
 * @returns 0, or 1 when settings.json is not valid JSON.
 */
function initCommand(deps: CliDeps): number {
  const result = init(sessionRepo(deps), deps.packageVersion);
  for (const line of result.lines) deps.print(line);
  return result.ok ? EXIT_OK : EXIT_FAIL;
}

/**
 * Runs the CLI.
 *
 * @param argv - Arguments after the executable name.
 * @param deps - Dependencies; tests inject fakes.
 * @returns The process exit code.
 * @example
 * process.exitCode = await main(["setup"], realDeps());
 */
export async function main(argv: string[], deps: CliDeps): Promise<number> {
  const [command, ...rest] = argv;
  if (command === "setup") return setupCommand(rest, deps);
  if (command === "session") return sessionCommand(deps);
  if (command === "docker") return dockerCommand(deps);
  if (command === "doctor") return doctorCommand(deps);
  if (command === "init") return initCommand(deps);
  if (command === "--version") {
    deps.print(deps.packageVersion);
    return EXIT_OK;
  }
  deps.print(HELP);
  return command === undefined || command === "--help" ? EXIT_OK : EXIT_FAIL;
}

/**
 * Builds the real dependencies of the CLI.
 *
 * @returns Dependencies backed by the process, the real runner and the real Docker.
 */
function realDeps(): CliDeps {
  return {
    env: process.env,
    run: runProcess,
    docker: realDocker,
    packageVersion: readVersion(),
    print: (line) => console.log(line),
    cwd: process.cwd(),
  };
}

/**
 * Tells whether this module is the process entry point (also when started through a symlink).
 *
 * @returns True when run as the CLI rather than imported.
 */
function isEntryPoint(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return import.meta.url === pathToFileURL(realpathSync(entry)).href;
  } catch {
    return false;
  }
}

if (isEntryPoint()) {
  process.exitCode = await main(process.argv.slice(2), realDeps());
}
