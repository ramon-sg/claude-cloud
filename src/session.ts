/**
 * @file The `session` phase: runs from the SessionStart hook of a cloud session, reports the
 * state of the machine, wires the pinned tools into the session and runs the repo's session steps.
 */
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { findProxyCa, shellQuote } from "./ca.ts";
import { CONFIG_FILE, readConfig } from "./config.ts";
import type { CloudConfig } from "./config.ts";
import { OUTPUT_PREFIX, PACKAGE, SETUP_SLOW_MS } from "./constants.ts";
import { defaultBranch, detectImages, readToolVersions } from "./detect.ts";
import type { Tool } from "./detect.ts";
import { realDocker } from "./docker.ts";
import type { DockerOps } from "./docker.ts";
import { pathLine, toolBinDirs } from "./installers.ts";
import type { Run } from "./run.ts";
import { fingerprint, readState } from "./state.ts";
import type { MachineState } from "./state.ts";

/** Generic note shown in every cloud session. */
const GENERIC_NOTE =
  "you are in a Claude Code cloud session. There are no open ports or previews: test against localhost. gh pr and gh issue fail (the GitHub proxy blocks GraphQL): use gh api (REST).";

/** Milliseconds in a second. */
const MS_PER_SECOND = 1000;

/** Seconds in a minute. */
const SECONDS_PER_MINUTE = 60;

/** Environment variable holding the file where the session reads extra exports from. */
const ENV_FILE_VAR = "CLAUDE_ENV_FILE";

/** Environment variable that exposes the proxy CA path to the session. */
const PROXY_CA_VAR = "CLOUD_PROXY_CA";

/** Path of the shallow marker inside a git directory. */
const SHALLOW_MARKER = join(".git", "shallow");

/** Environment that keeps git from ever prompting. */
const GIT_NON_INTERACTIVE = { GIT_TERMINAL_PROMPT: "0" };

/** Everything `session` needs from the outside, so tests can inject fakes. */
export interface SessionContext {
  /** Process environment. */
  env: NodeJS.ProcessEnv;
  /** Tools directory. */
  toolsDir: string;
  /** Process runner. */
  run: Run;
  /** Version of this package. */
  packageVersion: string;
  /** Docker operations; the real ones when omitted. */
  docker?: DockerOps;
}

/**
 * Builds the environment for repo commands: the pinned tools' bin dirs first on PATH, plus the CA.
 *
 * @param versions - Pinned versions by tool.
 * @param toolsDir - Tools directory.
 * @param baseEnv - Environment to extend; it is not modified.
 * @param ca - Proxy CA path, when found.
 * @returns A new environment.
 * @example
 * toolsEnv({ node: "24.14.1" }, "/opt/claude-cloud", process.env, "/root/.ccr/ca-bundle.crt");
 */
export function toolsEnv(
  versions: Partial<Record<Tool, string>>,
  toolsDir: string,
  baseEnv: NodeJS.ProcessEnv,
  ca?: string,
): NodeJS.ProcessEnv {
  const dirs = toolBinDirs(versions, toolsDir);
  const path = [...dirs, ...(baseEnv.PATH ? [baseEnv.PATH] : [])].join(":");
  const env: NodeJS.ProcessEnv = { ...baseEnv, PATH: path };
  if (ca) env[PROXY_CA_VAR] = ca;
  return env;
}

/**
 * Formats a duration in milliseconds as `<m>m<s>s`.
 *
 * @param ms - Milliseconds.
 * @returns For example `4m10s`.
 */
function minutesSeconds(ms: number): string {
  const total = Math.round(ms / MS_PER_SECOND);
  return `${Math.floor(total / SECONDS_PER_MINUTE)}m${total % SECONDS_PER_MINUTE}s`;
}

/**
 * Computes the fingerprint the machine should have, using the package version stored in the state
 * so a package upgrade alone is not reported here (setup's relaunch handles versions).
 *
 * @param repo - Repo root.
 * @param config - Repo config.
 * @param state - Recorded state.
 * @returns The expected fingerprint.
 */
function expectedFingerprint(repo: string, config: CloudConfig, state: MachineState): string {
  const pull = config.docker.pull;
  const images = pull === "auto" ? detectImages(repo) : pull === false ? [] : pull;
  return fingerprint(config, readToolVersions(repo), images, state.packageVersion);
}

/**
 * Describes what is wrong with the machine, from the recorded state.
 *
 * @param repo - Repo root.
 * @param config - Repo config.
 * @param state - Recorded state, if any.
 * @returns Warning messages, without prefix.
 */
function machineWarnings(repo: string, config: CloudConfig, state: MachineState | undefined): string[] {
  if (!state) {
    return [
      `the environment setup did not run for ${repo.split(sep).filter(Boolean).pop()}. Set the setup script of the environment in claude.ai to: npx -y ${PACKAGE}@1 setup`,
    ];
  }
  const out: string[] = [];
  const failed = state.steps.filter((s) => !s.ok).map((s) => s.name);
  if (failed.length) out.push(`setup failed: ${failed.join(", ")}. Run claude-cloud doctor.`);
  if (expectedFingerprint(repo, config, state) !== state.fingerprint) {
    out.push(
      "the machine was prepared with another configuration. Edit the setup script field in claude.ai (any change) so it is rebuilt.",
    );
  }
  const total = state.steps.reduce((sum, s) => sum + s.ms, 0);
  if (total > SETUP_SLOW_MS) out.push(`setup took ${minutesSeconds(total)}, close to the ~5 minute limit.`);
  return out;
}

/**
 * Reads the notes file, only when it resolves inside the repo.
 *
 * @param repo - Repo root.
 * @param notes - Path from the config.
 * @returns The trimmed contents, or undefined when absent, outside the repo or unreadable.
 */
function readNotes(repo: string, notes: string | undefined): string | undefined {
  if (!notes || isAbsolute(notes)) return undefined;
  const target = resolve(repo, notes);
  const rel = relative(resolve(repo), target);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) return undefined;
  try {
    return readFileSync(target, "utf8").trim() || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Appends the PATH line and the CA export to `$CLAUDE_ENV_FILE`, when it is set.
 *
 * @param env - Process environment.
 * @param lines - Lines to write; empty ones are dropped.
 */
function writeEnvFile(env: NodeJS.ProcessEnv, lines: string[]): void {
  const file = env[ENV_FILE_VAR];
  const body = lines.filter(Boolean);
  if (!file || !body.length) return;
  appendFileSync(file, `${body.join("\n")}\n`);
}

/**
 * Makes the clone complete and brings the default branch, so `git diff main...` works.
 * Each git call is an argv array; the branch is validated before it is used in a refspec.
 *
 * @param repo - Repo root.
 * @param run - Process runner.
 * @param env - Environment for git.
 */
async function syncGit(repo: string, run: Run, env: NodeJS.ProcessEnv): Promise<void> {
  const opts = { cwd: repo, env: { ...env, ...GIT_NON_INTERACTIVE } };
  if (existsSync(join(repo, SHALLOW_MARKER))) {
    await run("git", ["fetch", "-q", "--unshallow", "origin"], opts).catch(() => undefined);
  }
  const branch = defaultBranch(repo);
  const valid = await run("git", ["check-ref-format", "--branch", branch], opts).then(
    () => !branch.startsWith("-"),
    () => false,
  );
  if (!valid) return;
  await run("git", ["fetch", "-q", "origin", `${branch}:refs/remotes/origin/${branch}`], opts).catch(() => undefined);
}

/**
 * Runs the repo's session commands in order; a failure is reported and does not stop the rest.
 *
 * @param repo - Repo root.
 * @param commands - Shell commands from the config (repo-owned by design).
 * @param run - Process runner.
 * @param env - Environment for the commands.
 * @returns The failed commands.
 */
async function runSessionSteps(repo: string, commands: string[], run: Run, env: NodeJS.ProcessEnv): Promise<string[]> {
  const failed: string[] = [];
  for (const command of commands) {
    try {
      await run("bash", ["-c", command], { cwd: repo, env });
    } catch {
      failed.push(command);
    }
  }
  return failed;
}

/**
 * Does the work of `session`; may throw, the caller turns that into a line.
 *
 * @param repo - Repo root.
 * @param ctx - Dependencies.
 * @param out - Output lines, filled in order.
 */
async function sessionBody(repo: string, ctx: SessionContext, out: string[]): Promise<void> {
  out.push(GENERIC_NOTE);
  if (!existsSync(join(repo, CONFIG_FILE))) return;
  const { config, errors } = readConfig(repo);
  out.push(...errors);
  const versions = readToolVersions(repo);
  const ca = findProxyCa(ctx.env, existsSync);
  writeEnvFile(ctx.env, [pathLine(versions, ctx.toolsDir), ca ? `export ${PROXY_CA_VAR}=${shellQuote(ca)}` : ""]);
  if (config) out.push(...machineWarnings(repo, config, readState(ctx.toolsDir, repo)));
  const missing = (config?.requiredEnv ?? []).filter((name) => !ctx.env[name]);
  if (missing.length) out.push(`missing environment variables: ${missing.join(", ")}`);
  const notes = readNotes(repo, config?.notes);
  if (notes) out.push(notes);
  (ctx.docker ?? realDocker).start();
  const env = toolsEnv(versions, ctx.toolsDir, ctx.env, ca);
  await syncGit(repo, ctx.run, env);
  const failed = await runSessionSteps(repo, config?.session ?? [], ctx.run, env);
  out.push(...failed.map((command) => `session step failed: ${command}`));
}

/**
 * Runs the session phase for a repo.
 *
 * @param repo - Repo root.
 * @param ctx - Dependencies (environment, tools dir, runner, package version, Docker).
 * @returns The lines to print on stdout, each with the output prefix; never rejects.
 * @example
 * (await session("/home/user/app", { env: process.env, toolsDir, run: runProcess, packageVersion: "1.0.0" }))
 *   .forEach((line) => console.log(line));
 */
export async function session(repo: string, ctx: SessionContext): Promise<string[]> {
  const out: string[] = [];
  try {
    await sessionBody(repo, ctx, out);
  } catch (err) {
    out.push(`session error: ${err instanceof Error ? err.message : String(err)}`);
  }
  return out.map((line) => OUTPUT_PREFIX + line);
}
