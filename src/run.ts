/**
 * @file Process runner: the single place where child processes are spawned.
 * Modules that execute processes receive a `Run` (or a `Capture`) so tests can inject a fake.
 */
import { spawn } from "node:child_process";
import type { StdioOptions } from "node:child_process";

/** Signal sent to a process group that ran past its time limit. */
const KILL_SIGNAL = "SIGKILL";

/** File descriptor of the parent's stderr, reused as the child's stdout and stderr. */
const PARENT_STDERR = 2;

/** Where a child's output goes: inherited, or everything sent to the parent's stderr. */
export type OutputMode = "inherit" | "stderr";

/** Options shared by `Run` and `Capture`. */
export interface RunOptions {
  /** Working directory. */
  cwd?: string;
  /** Environment of the child. */
  env?: NodeJS.ProcessEnv;
  /** Output mode; `"inherit"` when omitted. `Capture` ignores it. */
  stdio?: OutputMode;
  /** Kill the child (and its process group) after this many milliseconds; no limit when omitted. */
  timeoutMs?: number;
}

/**
 * Function that runs a command and resolves when it exits with code 0.
 *
 * @param cmd - Executable to run.
 * @param args - Arguments passed to the executable.
 * @param opts - Optional working directory, environment, output mode and timeout.
 * @returns A promise that rejects with an error carrying the exit code.
 */
export type Run = (cmd: string, args: string[], opts?: RunOptions) => Promise<void>;

/**
 * Function that runs a command and resolves with its stdout when it exits with code 0.
 *
 * @param cmd - Executable to run.
 * @param args - Arguments passed to the executable.
 * @param opts - Optional working directory, environment and timeout.
 * @returns A promise with the captured stdout; rejects on a non-zero exit.
 */
export type Capture = (cmd: string, args: string[], opts?: RunOptions) => Promise<string>;

/** Error thrown when a child is killed because it ran past its time limit. */
export class RunTimeoutError extends Error {
  /**
   * Builds the error.
   *
   * @param cmd - Executable that timed out.
   * @param ms - Time limit, in milliseconds.
   */
  constructor(cmd: string, ms: number) {
    super(`${cmd} timed out after ${ms}ms`);
    this.name = "RunTimeoutError";
  }
}

/**
 * Maps an output mode to the spawn stdio setting.
 *
 * @param mode - Output mode.
 * @returns `"inherit"`, or stdin ignored and stdout plus stderr on the parent's stderr.
 */
function stdioFor(mode: OutputMode): StdioOptions {
  return mode === "stderr" ? ["ignore", PARENT_STDERR, PARENT_STDERR] : "inherit";
}

/**
 * Kills a detached child together with its process group; never throws.
 *
 * @param pid - Process id of the group leader.
 */
function killGroup(pid: number | undefined): void {
  if (pid === undefined) return;
  try {
    process.kill(-pid, KILL_SIGNAL);
  } catch {
    try {
      process.kill(pid, KILL_SIGNAL);
    } catch {
      // NOTE: the process already exited.
    }
  }
}

/**
 * Spawns a process and settles when it exits, or when it runs past its time limit.
 *
 * @param cmd - Executable to run.
 * @param args - Arguments passed to the executable.
 * @param opts - Options.
 * @param stdio - Spawn stdio setting.
 * @param onStdout - Receives stdout chunks when stdout is piped.
 * @returns Resolves on exit code 0.
 * @throws When the process cannot be spawned, exits non-zero, is killed by a signal or times out.
 */
function spawnAndWait(
  cmd: string,
  args: string[],
  opts: RunOptions,
  stdio: StdioOptions,
  onStdout?: (chunk: Buffer) => void,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const limited = opts.timeoutMs !== undefined;
    const child = spawn(cmd, args, { stdio, cwd: opts.cwd, env: opts.env, detached: limited });
    if (onStdout) child.stdout?.on("data", onStdout);
    let timer: NodeJS.Timeout | undefined;
    if (limited) {
      const ms = opts.timeoutMs ?? 0;
      timer = setTimeout(() => {
        killGroup(child.pid);
        reject(new RunTimeoutError(cmd, ms));
      }, ms);
    }
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      if (code === 0) return resolve();
      reject(new Error(`${cmd} exited with ${code === null ? `signal ${signal}` : `code ${code}`}`));
    });
  });
}

/**
 * Spawns a process with inherited stdio, or with its output sent to stderr.
 *
 * @param cmd - Executable to run.
 * @param args - Arguments passed to the executable.
 * @param opts - Optional working directory, environment, output mode and timeout.
 * @returns Resolves on exit code 0; rejects with the exit code in the message otherwise.
 * @throws When the process cannot be spawned, exits with a non-zero code or signal, or times out
 *   (`RunTimeoutError`).
 */
export const runProcess: Run = (cmd, args, opts = {}) => spawnAndWait(cmd, args, opts, stdioFor(opts.stdio ?? "inherit"));

/**
 * Spawns a process and collects its stdout; stdin and stderr are ignored.
 *
 * @param cmd - Executable to run.
 * @param args - Arguments passed to the executable.
 * @param opts - Optional working directory, environment and timeout.
 * @returns The stdout text.
 * @throws When the process cannot be spawned, exits with a non-zero code or signal, or times out.
 */
export const captureProcess: Capture = async (cmd, args, opts = {}) => {
  const chunks: Buffer[] = [];
  await spawnAndWait(cmd, args, opts, ["ignore", "pipe", "ignore"], (chunk) => chunks.push(chunk));
  return Buffer.concat(chunks).toString("utf8");
};
