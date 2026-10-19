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

/** Prefix of the name given to a lane whose function rejected. */
const LANE_NAME_PREFIX = "lane ";

/**
 * Runs lanes of steps concurrently and joins their results in lane order.
 *
 * @param laneFns - Lane functions, each resolving to the results of its own steps.
 * @returns Results ordered by lane, then by position within the lane; never rejects.
 * @example
 * await lanes(async () => [await step("a", fa)], async () => [await step("b", fb)]);
 */
export async function lanes(...laneFns: Array<() => Promise<StepResult[]>>): Promise<StepResult[]> {
  const groups = await Promise.all(
    laneFns.map(async (laneFn, index): Promise<StepResult[]> => {
      const start = Date.now();
      try {
        return await laneFn();
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        return [{ name: `${LANE_NAME_PREFIX}${index}`, ok: false, ms: Date.now() - start, error }];
      }
    }),
  );
  return groups.flat();
}
