/**
 * @file Process runner: the single place where child processes are spawned.
 * Modules that execute processes receive a `Run` so tests can inject a fake.
 */
import { spawn } from "node:child_process";

/**
 * Function that runs a command and resolves when it exits with code 0.
 *
 * @param cmd - Executable to run.
 * @param args - Arguments passed to the executable.
 * @param opts - Optional working directory and environment.
 * @returns A promise that rejects with an error carrying the exit code.
 */
export type Run = (
  cmd: string,
  args: string[],
  opts?: { cwd?: string; env?: NodeJS.ProcessEnv },
) => Promise<void>;

/**
 * Spawns a process with inherited stdio.
 *
 * @param cmd - Executable to run.
 * @param args - Arguments passed to the executable.
 * @param opts - Optional working directory and environment.
 * @returns Resolves on exit code 0; rejects with the exit code in the message otherwise.
 * @throws When the process cannot be spawned or exits with a non-zero code or signal.
 */
export const runProcess: Run = (cmd, args, opts = {}) =>
  new Promise<void>((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: "inherit", cwd: opts.cwd, env: opts.env });
    child.on("error", reject);
    child.on("close", (code, signal) => {
      if (code === 0) return resolve();
      reject(new Error(`${cmd} exited with ${code === null ? `signal ${signal}` : `code ${code}`}`));
    });
  });
