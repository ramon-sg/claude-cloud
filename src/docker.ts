/**
 * @file Starts the Docker daemon detached (cloud sessions have no init system) and waits for it.
 */
import { execFileSync, spawn } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import { DOCKERD_LOG, DOCKER_WAIT_SECONDS } from "./constants.ts";

/** Timeout of each probe command, in milliseconds. */
const PROBE_TIMEOUT_MS = 10_000;

/** Delay between readiness checks, in milliseconds. */
const POLL_MS = 1000;

/** Milliseconds in a second. */
const MS_PER_SECOND = 1000;

/** Message returned when there is no `dockerd` executable on PATH. */
export const DOCKERD_MISSING = "dockerd not installed";

/**
 * Probe that tells whether a command exits with code 0.
 *
 * @param cmd - Executable.
 * @param args - Arguments.
 * @returns True on exit code 0.
 */
export type Probe = (cmd: string, args: string[]) => boolean;

/** Operations on Docker that `session` and `setup` can have replaced in tests. */
export interface DockerOps {
  /** Starts the daemon in the background if it is not running; never throws. Returns an error message on failure. */
  start(): string | undefined;
  /** Starts the daemon and waits until it answers; resolves false on timeout. */
  ensure(): Promise<boolean>;
}

/**
 * Tells whether a command exits with code 0.
 *
 * @param cmd - Executable.
 * @param args - Arguments.
 * @returns True on exit code 0; false on any failure, including a missing executable.
 */
function succeeds(cmd: string, args: string[]): boolean {
  try {
    execFileSync(cmd, args, { stdio: "ignore", timeout: PROBE_TIMEOUT_MS });
    return true;
  } catch {
    return false;
  }
}

/**
 * Tells whether the daemon already answers.
 *
 * @returns True when `docker info` succeeds.
 * @example
 * if (!dockerResponds()) console.log("docker is down");
 */
export function dockerResponds(): boolean {
  return succeeds("docker", ["info"]);
}

/**
 * Starts `dockerd` detached, logging to `DOCKERD_LOG`. Does nothing when Docker already
 * answers or when one is already running. Never throws.
 *
 * @param probe - Command probe; the real one when omitted (tests inject a fake).
 * @returns `DOCKERD_MISSING` when there is no `dockerd` on PATH, another error message when the
 *   daemon could not be started, undefined otherwise.
 * @example
 * const problem = startDockerDetached();
 */
export function startDockerDetached(probe: Probe = succeeds): string | undefined {
  if (probe("docker", ["info"])) return undefined;
  if (!probe("sh", ["-c", "command -v dockerd"])) return DOCKERD_MISSING;
  if (probe("pgrep", ["-x", "dockerd"])) return undefined;
  try {
    const log = openSync(DOCKERD_LOG, "a");
    try {
      const child = spawn("dockerd", [], { detached: true, stdio: ["ignore", log, log] });
      child.on("error", () => {});
      child.unref();
    } finally {
      closeSync(log);
    }
    return undefined;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

/**
 * Starts the daemon and waits for it to answer, up to `DOCKER_WAIT_SECONDS`. Returns false at
 * once when the daemon cannot be started at all (for example, no `dockerd` installed).
 *
 * @param probe - Command probe; the real one when omitted (tests inject a fake).
 * @returns True when Docker answers in time; false when it never does or cannot start.
 * @example
 * if (await ensureDocker()) console.log("docker is up");
 */
export async function ensureDocker(probe: Probe = succeeds): Promise<boolean> {
  if (startDockerDetached(probe)) return false;
  const deadline = Date.now() + DOCKER_WAIT_SECONDS * MS_PER_SECOND;
  while (Date.now() < deadline) {
    if (probe("docker", ["info"])) return true;
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
  return probe("docker", ["info"]);
}

/** The real Docker operations. */
export const realDocker: DockerOps = { start: () => startDockerDetached(), ensure: () => ensureDocker() };
