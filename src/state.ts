/**
 * @file Machine fingerprint and the per-repo state file that records what setup last did.
 */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { CloudConfig } from "./config.ts";
import type { Tool } from "./detect.ts";
import type { StepResult } from "./steps.ts";

/** Directory, inside the tools dir, that holds one state file per repo. */
const STATE_DIR = "state";

/** Prefix of every fingerprint. */
const FINGERPRINT_PREFIX = "sha256-";

/** Hash algorithm used for fingerprints. */
const HASH_ALGORITHM = "sha256";

/** Indentation of the state file. */
const JSON_INDENT = 2;

/** What setup recorded the last time it finished for a repo. */
export interface MachineState {
  /** Fingerprint of the inputs that shaped the machine. */
  fingerprint: string;
  /** Version of this package that ran setup. */
  packageVersion: string;
  /** ISO timestamp of when setup finished. */
  finishedAt: string;
  /** Outcome of every step. */
  steps: StepResult[];
}

/**
 * Serializes a value as JSON with object keys sorted recursively; arrays keep their order.
 *
 * @param value - Any JSON-compatible value.
 * @returns A canonical JSON string.
 */
function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    const entries = Object.entries(value)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${stableJson(v)}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/**
 * Hashes everything that decides how the machine is built, so a change asks for a rebuild.
 * `session`, `requiredEnv` and `notes` are left out: changing them does not need a rebuild.
 *
 * @param config - Repo config.
 * @param versions - Pinned tool versions.
 * @param images - Docker images to pull.
 * @param packageVersion - Version of this package.
 * @returns `sha256-<hex>`.
 * @example
 * fingerprint(config, { node: "20.1.0" }, ["postgres:16"], "1.0.0"); // "sha256-ab12..."
 */
export function fingerprint(
  config: CloudConfig,
  versions: Partial<Record<Tool, string>>,
  images: string[],
  packageVersion: string,
): string {
  const { version, aptRepos, apt, docker, setup } = config;
  const json = stableJson({ version, aptRepos, apt, docker, setup, versions, images, packageVersion });
  return FINGERPRINT_PREFIX + createHash(HASH_ALGORITHM).update(json).digest("hex");
}

/**
 * Locates the state file of a repo.
 *
 * @param toolsDir - Tools directory.
 * @param repo - Repo root path.
 * @returns `<toolsDir>/state/<basename(repo)>.json`.
 * @example
 * statePath("/opt/claude-cloud", "/home/user/app"); // "/opt/claude-cloud/state/app.json"
 */
export function statePath(toolsDir: string, repo: string): string {
  return join(toolsDir, STATE_DIR, `${basename(repo)}.json`);
}

/**
 * Writes the state file atomically (temp file in the same dir, then rename).
 *
 * @param toolsDir - Tools directory.
 * @param repo - Repo root path.
 * @param state - State to record.
 * @example
 * writeState("/opt/claude-cloud", "/home/user/app", state);
 */
export function writeState(toolsDir: string, repo: string, state: MachineState): void {
  const file = statePath(toolsDir, repo);
  mkdirSync(join(toolsDir, STATE_DIR), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(state, null, JSON_INDENT)}\n`);
  renameSync(temp, file);
}

/**
 * Tells whether a parsed value has the shape of a `MachineState`.
 *
 * @param value - Any parsed JSON value.
 * @returns True when all required fields are present with the right types.
 */
function isMachineState(value: unknown): value is MachineState {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.fingerprint === "string" &&
    typeof v.packageVersion === "string" &&
    typeof v.finishedAt === "string" &&
    Array.isArray(v.steps)
  );
}

/**
 * Reads a repo's state file; never throws because it runs at session start.
 *
 * @param toolsDir - Tools directory.
 * @param repo - Repo root path.
 * @returns The state, or undefined when the file is missing, unreadable, invalid or incomplete.
 * @example
 * readState("/opt/claude-cloud", "/home/user/app"); // undefined before the first setup
 */
export function readState(toolsDir: string, repo: string): MachineState | undefined {
  try {
    const parsed: unknown = JSON.parse(readFileSync(statePath(toolsDir, repo), "utf8"));
    return isMachineState(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}
