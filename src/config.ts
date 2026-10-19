/**
 * @file Reader and validator for `<repo>/.claude/cloud.json`.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { CONFIG_FILE } from "./constants.ts";


/** Top-level key that editors use to point at the JSON schema; allowed but not part of the config. */
const SCHEMA_KEY = "$schema";

/** Exact semver: no ranges, no prefixes. */
const EXACT_SEMVER = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$/;

/** Top-level keys of `CloudConfig`; must match `schema.json#/properties` (minus `$schema`). */
export const CONFIG_KEYS = [
  "version",
  "aptRepos",
  "apt",
  "docker",
  "setup",
  "session",
  "requiredEnv",
  "notes",
] as const;

/** Keys accepted inside the `docker` object. */
const DOCKER_KEYS = ["pull"] as const;

/** Keys that hold a list of strings. */
const LIST_KEYS = ["aptRepos", "apt", "setup", "session", "requiredEnv"] as const;

/** Value of `docker.pull` that asks for image auto-detection. */
const PULL_AUTO = "auto";

/** Parsed and normalized contents of `.claude/cloud.json`. */
export interface CloudConfig {
  version: string;
  aptRepos: string[];
  apt: string[];
  docker: { pull: "auto" | false | string[] };
  setup: string[];
  session: string[];
  requiredEnv: string[];
  notes?: string;
}

/** Result of reading a config: errors never throw, they are collected. */
export interface ReadConfigResult {
  config?: CloudConfig;
  errors: string[];
}

/**
 * Builds an error message prefixed with the config file name.
 *
 * @param message - What went wrong.
 * @returns The prefixed message.
 */
function fail(message: string): string {
  return `${CONFIG_FILE}: ${message}`;
}

/**
 * Tells whether a value is a plain JSON object.
 *
 * @param value - Any parsed JSON value.
 * @returns True for non-null, non-array objects.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Tells whether a value is an array of strings.
 *
 * @param value - Any parsed JSON value.
 * @returns True when every element is a string.
 */
function isStringList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

/**
 * Validates `docker`, falling back to the default when it is invalid.
 *
 * @param value - Raw `docker` value, possibly undefined.
 * @param errors - Collector that receives any problem found.
 * @returns A valid docker section.
 */
function parseDocker(value: unknown, errors: string[]): CloudConfig["docker"] {
  if (value === undefined) return { pull: PULL_AUTO };
  if (!isRecord(value)) {
    errors.push(fail('"docker" must be an object'));
    return { pull: PULL_AUTO };
  }
  for (const key of Object.keys(value)) {
    if (!(DOCKER_KEYS as readonly string[]).includes(key)) {
      errors.push(fail(`unknown field "docker.${key}"`));
    }
  }
  const pull = value.pull;
  if (pull === undefined || pull === PULL_AUTO) return { pull: PULL_AUTO };
  if (pull === false || isStringList(pull)) return { pull };
  errors.push(fail('"docker.pull" must be "auto", false or an array of strings'));
  return { pull: PULL_AUTO };
}

/**
 * Validates a list-of-strings field, using `[]` when it is invalid or missing.
 *
 * @param raw - The whole parsed object.
 * @param key - Field to read.
 * @param errors - Collector that receives any problem found.
 * @returns The list, or an empty list.
 */
function parseList(raw: Record<string, unknown>, key: string, errors: string[]): string[] {
  const value = raw[key];
  if (value === undefined) return [];
  if (isStringList(value)) return value;
  errors.push(fail(`"${key}" must be an array of strings`));
  return [];
}

/**
 * Validates the parsed object and builds a normalized config.
 *
 * @param raw - Parsed JSON object.
 * @param errors - Collector that receives any problem found.
 * @returns The config, or undefined when `version` is missing or invalid.
 */
function parseConfig(raw: Record<string, unknown>, errors: string[]): CloudConfig | undefined {
  const known: readonly string[] = [...CONFIG_KEYS, SCHEMA_KEY];
  for (const key of Object.keys(raw)) {
    if (!known.includes(key)) errors.push(fail(`unknown field "${key}"`));
  }
  const version = raw.version;
  if (typeof version !== "string" || !EXACT_SEMVER.test(version)) {
    errors.push(fail('"version" must be an exact semver string such as "1.0.0"'));
    return undefined;
  }
  const lists = Object.fromEntries(LIST_KEYS.map((key) => [key, parseList(raw, key, errors)]));
  const config: CloudConfig = {
    version,
    aptRepos: lists.aptRepos ?? [],
    apt: lists.apt ?? [],
    docker: parseDocker(raw.docker, errors),
    setup: lists.setup ?? [],
    session: lists.session ?? [],
    requiredEnv: lists.requiredEnv ?? [],
  };
  if (typeof raw.notes === "string") config.notes = raw.notes;
  else if (raw.notes !== undefined) errors.push(fail('"notes" must be a string'));
  return config;
}

/**
 * Reads and validates a repo's cloud config without ever throwing.
 *
 * @param repo - Path of the repo root.
 * @returns The config (absent when the file is missing or `version` is invalid) and the list of errors.
 * @example
 * readConfig("/home/user/my-repo"); // { config: { version: "1.0.0", ... }, errors: [] }
 */
export function readConfig(repo: string): ReadConfigResult {
  const file = join(repo, CONFIG_FILE);
  if (!existsSync(file)) return { errors: [] };
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return { errors: [fail(`cannot read file: ${reason}`)] };
  }
  if (!isRecord(raw)) return { errors: [fail("must contain a JSON object")] };
  const errors: string[] = [];
  const config = parseConfig(raw, errors);
  return config ? { config, errors } : { errors };
}
