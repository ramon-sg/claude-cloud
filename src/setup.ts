/**
 * @file The `setup` phase for one repo: runs as root before Claude starts, installs the pinned
 * tools, apt packages and Docker images and copies this package into the tools dir, then runs the
 * repo's setup steps and records the result. Values from the repo config are untrusted: they are
 * validated and always passed as argv, never interpolated into a shell string.
 */
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, symlinkSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { findProxyCa } from "./ca.ts";
import { readConfig } from "./config.ts";
import type { CloudConfig } from "./config.ts";
import { DOCKERD_LOG, PULL_JOBS } from "./constants.ts";
import { configImages, readToolVersions } from "./detect.ts";
import { realDocker } from "./docker.ts";
import type { DockerOps } from "./docker.ts";
import { curlNodeIndex, installTools, resolveVersions } from "./installers.ts";
import type { Versions } from "./installers.ts";
import { linkPath, packageBin, packageInstallDir } from "./launcher.ts";
import type { Run } from "./run.ts";
import { pathDirs, toolsEnv } from "./session.ts";
import { fingerprint, writeState } from "./state.ts";
import type { MachineState } from "./state.ts";
import { lanes, step } from "./steps.ts";
import type { StepResult } from "./steps.ts";

/** Strict Debian package name; anything else is never handed to apt-get. */
const DEBIAN_PACKAGE_NAME = /^[a-z0-9][a-z0-9+.-]+$/;

/** Only scheme accepted for apt repo setup scripts. */
const HTTPS_PREFIX = "https://";

/** Script that downloads an apt repo setup script (`$1`) and runs it; fails if curl fails. */
const APT_REPO_SCRIPT = 'set -o pipefail; curl -1sLf -- "$1" | bash';

/** Placeholder for `$0` in inline bash scripts. */
const SCRIPT_NAME = "_";

/** Environment that keeps apt from asking questions. */
const APT_ENV = { DEBIAN_FRONTEND: "noninteractive" };

/** Characters that make an image reference unsafe to pass on: any whitespace. */
const WHITESPACE = /\s/;

/** Prefix of the name of each repo setup step. */
const SETUP_STEP_PREFIX = "setup: ";

/** Manifest file of this package. */
const MANIFEST = "package.json";

/** Compiled code of this package, copied together with the manifest. */
const DIST_DIR = "dist";

/** Entry point of the CLI, relative to the package root. */
const CLI_ENTRY = join(DIST_DIR, "cli.js");

/** Mode of the CLI entry point: executable by everyone. */
const EXECUTABLE_MODE = 0o755;

/** Root of the running package: the folder above `dist/` (or `src/` in tests). */
const RUNNING_PACKAGE_ROOT = fileURLToPath(new URL("..", import.meta.url));

/** Everything `setupRepo` needs from the outside, so tests can inject fakes. */
export interface SetupContext {
  /** Tools directory. */
  toolsDir: string;
  /** Process runner. */
  run: Run;
  /** Version of this package. */
  packageVersion: string;
  /** Process environment; `process.env` when omitted. */
  env?: NodeJS.ProcessEnv;
  /** Docker operations; the real ones when omitted. */
  docker?: DockerOps;
  /** Root of the package copied by the self install; the running package when omitted. */
  packageRoot?: string;
}

/** Resolved dependencies shared by the setup lanes. */
interface Deps {
  repo: string;
  toolsDir: string;
  run: Run;
  env: NodeJS.ProcessEnv;
}

/**
 * Builds a step that always fails with a message, for input that is refused without running it.
 *
 * @param name - Step name.
 * @param message - Why it was refused.
 * @returns The failed result.
 */
function refused(name: string, message: string): Promise<StepResult> {
  return step(name, async () => {
    throw new Error(message);
  });
}

/**
 * Runs the apt work in series: repo scripts, then `apt-get update`, then `apt-get install`.
 *
 * @param config - Repo config.
 * @param deps - Shared dependencies.
 * @returns One result per apt repo and refused package, plus update (when there is a repo or a
 *   valid package) and install (when there is a valid package).
 */
async function aptLane(config: CloudConfig, deps: Deps): Promise<StepResult[]> {
  if (!config.aptRepos.length && !config.apt.length) return [];
  const env = { ...deps.env, ...APT_ENV };
  const results: StepResult[] = [];
  for (const url of config.aptRepos) {
    const name = `apt repo ${url}`;
    if (!url.startsWith(HTTPS_PREFIX)) {
      results.push(await refused(name, `apt repo must be an ${HTTPS_PREFIX} URL`));
      continue;
    }
    results.push(await step(name, () => deps.run("bash", ["-c", APT_REPO_SCRIPT, SCRIPT_NAME, url], { env })));
  }
  const valid = config.apt.filter((pkg) => DEBIAN_PACKAGE_NAME.test(pkg));
  for (const pkg of config.apt.filter((p) => !valid.includes(p))) {
    results.push(await refused(`apt package ${pkg}`, "invalid Debian package name"));
  }
  if (!valid.length && !config.aptRepos.length) return results;
  results.push(await step("apt-get update", () => deps.run("apt-get", ["update", "-q"], { env })));
  if (valid.length) {
    results.push(await step("apt-get install", () => deps.run("apt-get", ["install", "-y", "-q", "--", ...valid], { env })));
  }
  return results;
}

/**
 * Pulls images with at most `PULL_JOBS` pulls at a time, keeping the input order in the results.
 *
 * @param images - Validated image references.
 * @param deps - Shared dependencies.
 * @returns One result per image.
 */
async function pullAll(images: string[], deps: Deps): Promise<StepResult[]> {
  const results: StepResult[] = new Array(images.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < images.length) {
      const index = next++;
      const image = images[index] as string;
      results[index] = await step(`docker pull ${image}`, () => deps.run("docker", ["pull", "-q", image], { env: deps.env }));
    }
  };
  await Promise.all(Array.from({ length: Math.min(PULL_JOBS, images.length) }, worker));
  return results;
}

/**
 * Starts Docker and pulls the images. Docker is started even with no images, because setup
 * steps may use it (`docker build`); only `docker.pull: false` leaves it alone.
 *
 * @param config - Repo config.
 * @param images - Image references from the config or detection (untrusted).
 * @param docker - Docker operations.
 * @param deps - Shared dependencies.
 * @returns A failed `docker` step when the daemon does not answer, otherwise one result per image.
 */
async function dockerLane(config: CloudConfig, images: string[], docker: DockerOps, deps: Deps): Promise<StepResult[]> {
  if (config.docker.pull === false) return [];
  const results: StepResult[] = [];
  const valid = images.filter((image) => !WHITESPACE.test(image) && !image.startsWith("-") && image !== "");
  for (const image of images.filter((i) => !valid.includes(i))) {
    results.push(await refused(`docker pull ${image}`, "invalid image reference"));
  }
  const up = await docker.ensure().catch(() => false);
  if (!up) return [...results, await refused("docker", `dockerd did not start; see ${DOCKERD_LOG}`)];
  return [...results, ...(await pullAll(valid, deps))];
}

/**
 * Runs the repo's setup commands in series, in the repo, with the pinned tools on PATH.
 *
 * @param commands - Shell commands from the config (repo-owned by design).
 * @param deps - Shared dependencies; `env` already carries the tools PATH.
 * @returns One result per command.
 */
async function setupSteps(commands: string[], deps: Deps): Promise<StepResult[]> {
  const results: StepResult[] = [];
  for (const command of commands) {
    results.push(
      await step(SETUP_STEP_PREFIX + command, () => deps.run("bash", ["-c", command], { cwd: deps.repo, env: deps.env })),
    );
  }
  return results;
}

/**
 * Points a link at a target, replacing any old link atomically.
 *
 * @param link - Link path.
 * @param target - Link target.
 * @throws When the link cannot be created.
 */
function replaceLink(link: string, target: string): void {
  mkdirSync(dirname(link), { recursive: true });
  const temp = `${link}.${process.pid}.tmp`;
  rmSync(temp, { force: true });
  symlinkSync(target, temp);
  renameSync(temp, link);
}

/**
 * Reads the version from a package manifest; never throws.
 *
 * @param root - Package root.
 * @returns The version, or undefined when the manifest is missing or invalid.
 */
function manifestVersion(root: string): string | undefined {
  try {
    const version: unknown = (JSON.parse(readFileSync(join(root, MANIFEST), "utf8")) as { version?: unknown }).version;
    return typeof version === "string" ? version : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Copies the package manifest and `dist/` into a target folder, through a temp folder renamed
 * into place, and leaves the CLI entry point executable.
 *
 * @param source - Root of the running package.
 * @param target - Destination package root.
 * @param version - Version expected in the source manifest.
 * @throws When the source is another version or the copy fails.
 */
function copyPackage(source: string, target: string, version: string): void {
  const found = manifestVersion(source);
  if (found !== version) throw new Error(`the package at ${source} is ${found ?? "unknown"}, not ${version}`);
  const temp = `${target}.${process.pid}.tmp`;
  rmSync(temp, { recursive: true, force: true });
  mkdirSync(temp, { recursive: true });
  cpSync(join(source, MANIFEST), join(temp, MANIFEST));
  cpSync(join(source, DIST_DIR), join(temp, DIST_DIR), { recursive: true });
  chmodSync(join(temp, CLI_ENTRY), EXECUTABLE_MODE);
  rmSync(target, { recursive: true, force: true });
  renameSync(temp, target);
}

/**
 * Copies the running package into `<toolsDir>/pkg/<version>` (unless that version is already
 * there) and links its binary, without npm or network, so it works before anything else runs.
 *
 * @param version - Version of this package.
 * @param toolsDir - Tools directory.
 * @param source - Root of the running package.
 * @returns The self install result.
 */
function selfInstall(version: string, toolsDir: string, source: string): Promise<StepResult> {
  return step(`self install ${version}`, async () => {
    const target = packageInstallDir(toolsDir, version);
    if (manifestVersion(target) !== version) copyPackage(source, target, version);
    const bin = packageBin(toolsDir, version);
    replaceLink(bin, relative(dirname(bin), join(target, CLI_ENTRY)));
    replaceLink(linkPath(toolsDir), bin);
  });
}

/**
 * Runs the phases and writes the state; may throw, the caller turns that into a step. Phase 1
 * runs the tools, apt, Docker and the self install in parallel lanes; phase 2 runs the repo's
 * setup steps. The fingerprint reads versions and images again after the setup steps, because
 * those steps may generate the files they come from and `session` reads them later.
 *
 * @param repo - Repo root.
 * @param config - Valid repo config.
 * @param ctx - Dependencies.
 * @returns The recorded state.
 */
async function runPhases(repo: string, config: CloudConfig, ctx: SetupContext): Promise<MachineState> {
  const env = ctx.env ?? process.env;
  const versions = readToolVersions(repo);
  const images = configImages(config, repo);
  const base: Deps = { repo, toolsDir: ctx.toolsDir, run: ctx.run, env };
  let resolved: Versions = {};
  const toolsLane = async (): Promise<StepResult[]> => {
    const resolution = await resolveVersions(versions, curlNodeIndex(ctx.run, env));
    resolved = resolution.resolved;
    return [...resolution.results, ...(await installTools(resolved, ctx.toolsDir, ctx.run, env))];
  };
  const steps = await lanes(
    toolsLane,
    () => aptLane(config, base),
    () => dockerLane(config, images, ctx.docker ?? realDocker, base),
    async () => [await selfInstall(ctx.packageVersion, ctx.toolsDir, ctx.packageRoot ?? RUNNING_PACKAGE_ROOT)],
  );
  const dirs = pathDirs(versions, ctx.toolsDir, resolved);
  const toolsDeps: Deps = { ...base, env: toolsEnv(dirs, env, findProxyCa(env, existsSync)) };
  steps.push(...(await setupSteps(config.setup, toolsDeps)));
  const state: MachineState = {
    fingerprint: fingerprint(config, readToolVersions(repo), configImages(config, repo), ctx.packageVersion),
    packageVersion: ctx.packageVersion,
    finishedAt: new Date().toISOString(),
    steps,
    resolved,
  };
  const saved = await step("write state", async () => writeState(ctx.toolsDir, repo, state));
  return saved.ok ? state : { ...state, steps: [...steps, saved] };
}

/**
 * Prepares the machine for one repo: tools, apt, Docker and the self install in parallel lanes
 * (apt work in series inside its lane), then the repo's setup steps; writes the state.
 *
 * @param repo - Repo root.
 * @param ctx - Dependencies (tools dir, runner, package version, optional env and Docker).
 * @returns The state; when the config is missing or invalid, a state with one failed `config`
 *   step that is not written. Never rejects.
 * @example
 * const state = await setupRepo("/home/user/app", { toolsDir: "/opt/claude-cloud", run: runProcess, packageVersion: "1.0.0" });
 */
export async function setupRepo(repo: string, ctx: SetupContext): Promise<MachineState> {
  const failed = (name: string, error: string): MachineState => ({
    fingerprint: "",
    packageVersion: ctx.packageVersion,
    finishedAt: new Date().toISOString(),
    steps: [{ name, ok: false, ms: 0, error }],
    resolved: {},
  });
  const { config, errors } = readConfig(repo);
  if (!config) return failed("config", errors.join("; ") || "no config");
  try {
    return await runPhases(repo, config, ctx);
  } catch (err) {
    return failed("setup", err instanceof Error ? err.message : String(err));
  }
}
