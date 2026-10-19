/**
 * @file Step results: runs one unit of work and reports its outcome without ever throwing.
 */

/** Outcome of one named step. */
export interface StepResult {
  /** Human-readable step name. */
  name: string;
  /** Whether the step finished without throwing. */
  ok: boolean;
  /** Elapsed wall-clock time in milliseconds. */
  ms: number;
  /** Error message when the step failed. */
  error?: string;
}

/**
 * Runs a step, timing it and converting any failure into a result.
 *
 * @param name - Name reported in the result.
 * @param fn - Work to run.
 * @returns The outcome; this promise never rejects.
 * @example
 * await step("pull images", async () => pull()); // { name: "pull images", ok: true, ms: 1200 }
 */
export async function step(name: string, fn: () => Promise<void>): Promise<StepResult> {
  const start = Date.now();
  try {
    await fn();
    return { name, ok: true, ms: Date.now() - start };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    return { name, ok: false, ms: Date.now() - start, error };
  }
}
