/**
 * @file The `setup` phase for one repo: runs as root before Claude starts, installs the pinned
 * tools, apt packages and Docker images, runs the repo's setup steps, installs this package into
 * the tools dir and records the result. Values from the repo config are untrusted: they are
 * validated and always passed as argv, never interpolated into a shell string.
 */
import { existsSync, mkdirSync, renameSync, rmSync, symlinkSync } from "node:fs";
import { dirname } from "node:path";
import { findProxyCa } from "./ca.ts";
import { readConfig } from "./config.ts";
import type { CloudConfig } from "./config.ts";
import { DOCKERD_LOG, PACKAGE, PULL_JOBS } from "./constants.ts";
import { configImages, readToolVersions } from "./detect.ts";
import { realDocker } from "./docker.ts";
import type { DockerOps } from "./docker.ts";
import { installTools } from "./installers.ts";
import { linkPath, packageBin, packageDir } from "./launcher.ts";
import type { Run } from "./run.ts";
import { toolsEnv } from "./session.ts";
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
 * @returns One result per apt repo, plus update and install when there is apt work.
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
 * Starts Docker and pulls the images; does nothing when there are no images to pull.
 *
 * @param images - Image references from the config or detection (untrusted).
 * @param docker - Docker operations.
 * @param deps - Shared dependencies.
 * @returns A failed `docker` step when the daemon does not answer, otherwise one result per image.
 */
async function dockerLane(images: string[], docker: DockerOps, deps: Deps): Promise<StepResult[]> {
  if (!images.length) return [];
  const results: StepResult[] = [];
  const valid = images.filter((image) => !WHITESPACE.test(image) && !image.startsWith("-") && image !== "");
  for (const image of images.filter((i) => !valid.includes(i))) {
    results.push(await refused(`docker pull ${image}`, "invalid image reference"));
  }
  if (!valid.length) return results;
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
 * Points `<toolsDir>/bin/claude-cloud` at a target, replacing any old link atomically.
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
 * Installs this package version into the tools dir (unless already there) and links its binary.
 *
 * @param version - Version of this package.
 * @param deps - Shared dependencies; `env` carries the tools PATH so the pinned npm is used.
 * @returns The self install result.
 */
function selfInstall(version: string, deps: Deps): Promise<StepResult> {
  return step(`self install ${version}`, async () => {
    const bin = packageBin(deps.toolsDir, version);
    if (!existsSync(bin)) {
      const args = ["install", "--prefix", packageDir(deps.toolsDir, version), "--no-save", "--no-audit", "--no-fund"];
      await deps.run("npm", [...args, `${PACKAGE}@${version}`], { env: deps.env });
    }
    replaceLink(linkPath(deps.toolsDir), bin);
  });
}

/**
 * Runs the three phases and writes the state; may throw, the caller turns that into a step.
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
  const toolsDeps: Deps = { ...base, env: toolsEnv(versions, ctx.toolsDir, env, findProxyCa(env, existsSync)) };
  const steps = await lanes(
    () => installTools(versions, ctx.toolsDir, ctx.run, env),
    () => aptLane(config, base),
    () => dockerLane(images, ctx.docker ?? realDocker, base),
  );
  steps.push(...(await setupSteps(config.setup, toolsDeps)));
  steps.push(await selfInstall(ctx.packageVersion, toolsDeps));
  const state: MachineState = {
    fingerprint: fingerprint(config, versions, images, ctx.packageVersion),
    packageVersion: ctx.packageVersion,
    finishedAt: new Date().toISOString(),
    steps,
  };
  const saved = await step("write state", async () => writeState(ctx.toolsDir, repo, state));
  return saved.ok ? state : { ...state, steps: [...steps, saved] };
}

/**
 * Prepares the machine for one repo: tools, apt and Docker in parallel lanes (apt work in series
 * inside its lane), then the repo's setup steps, then the self install; writes the state.
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
  });
  const { config, errors } = readConfig(repo);
  if (!config) return failed("config", errors.join("; ") || "no config");
  try {
    return await runPhases(repo, config, ctx);
  } catch (err) {
    return failed("setup", err instanceof Error ? err.message : String(err));
  }
}
