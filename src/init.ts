/**
 * @file The `init` command: scaffolds `.claude/cloud.json` and registers the SessionStart hook in
 * `.claude/settings.json` without touching anything else.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { CONFIG_FILE, OUTPUT_PREFIX, PACKAGE } from "./constants.ts";

/** Path of the Claude Code settings file, relative to the repo root. */
const SETTINGS_FILE = ".claude/settings.json";

/** Text that marks a SessionStart hook as ours. */
const HOOK_MARKER = "claude-cloud session";

/** Timeout of the hook, in seconds. */
const HOOK_TIMEOUT_SECONDS = 600;

/** Indentation of the files written. */
const JSON_INDENT = 2;

/** Command of the SessionStart hook: does nothing outside cloud sessions. */
const HOOK_COMMAND =
  "[ \"$CLAUDE_CODE_REMOTE\" = true ] || exit 0; /opt/claude-cloud/bin/claude-cloud session || echo 'claude-cloud: the environment setup did not run; see npx @ramon-sg/claude-cloud doctor'";

/** Result of `init`. */
export interface InitResult {
  /** Prefixed lines describing what was done. */
  lines: string[];
  /** False when settings.json could not be updated because it is not valid JSON. */
  ok: boolean;
}

/** Loose shape of the settings file, enough to find the SessionStart hooks. */
interface Settings {
  [key: string]: unknown;
  hooks?: { [event: string]: unknown; SessionStart?: unknown };
}

/**
 * Writes a JSON file with a trailing newline, creating its folder.
 *
 * @param file - Absolute path.
 * @param value - Value to serialize.
 */
function writeJson(file: string, value: unknown): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(value, null, JSON_INDENT)}\n`);
}

/**
 * Tells whether some SessionStart entry already runs `claude-cloud session`.
 *
 * @param entries - The `hooks.SessionStart` array.
 * @returns True when any hook command contains the marker.
 */
function hasHook(entries: unknown[]): boolean {
  return entries.some((entry) => {
    const hooks = (entry as { hooks?: unknown } | null)?.hooks;
    return Array.isArray(hooks) && hooks.some((h) => String((h as { command?: unknown } | null)?.command ?? "").includes(HOOK_MARKER));
  });
}

/**
 * Creates `.claude/cloud.json` unless it exists.
 *
 * @param repo - Repo root.
 * @param packageVersion - Version of this package.
 * @returns A line describing the outcome.
 */
function scaffoldConfig(repo: string, packageVersion: string): string {
  const file = join(repo, CONFIG_FILE);
  if (existsSync(file)) return `${CONFIG_FILE} already exists, left as is`;
  writeJson(file, {
    $schema: `https://unpkg.com/${PACKAGE}@${packageVersion}/schema.json`,
    version: packageVersion,
    aptRepos: [],
    apt: [],
    docker: { pull: "auto" },
    setup: [],
    session: [],
    requiredEnv: [],
  });
  return `created ${CONFIG_FILE}`;
}

/**
 * Adds the SessionStart hook to `.claude/settings.json`, keeping everything else.
 *
 * @param repo - Repo root.
 * @returns The outcome line and whether it succeeded.
 */
function registerHook(repo: string): { line: string; ok: boolean } {
  const file = join(repo, SETTINGS_FILE);
  let settings: Settings = {};
  if (existsSync(file)) {
    try {
      settings = JSON.parse(readFileSync(file, "utf8")) as Settings;
    } catch {
      return { line: `${SETTINGS_FILE} is not valid JSON, left untouched; add the SessionStart hook by hand`, ok: false };
    }
  }
  const hooks = settings.hooks ?? {};
  const entries = Array.isArray(hooks.SessionStart) ? hooks.SessionStart : [];
  if (hasHook(entries)) return { line: `${SETTINGS_FILE} already has the SessionStart hook`, ok: true };
  const hook = { type: "command", command: HOOK_COMMAND, timeout: HOOK_TIMEOUT_SECONDS };
  writeJson(file, { ...settings, hooks: { ...hooks, SessionStart: [...entries, { hooks: [hook] }] } });
  return { line: `added the SessionStart hook to ${SETTINGS_FILE}`, ok: true };
}

/**
 * Sets a repo up for claude-cloud; safe to run again.
 *
 * @param repo - Repo root.
 * @param packageVersion - Version of this package, written into the config.
 * @returns What it did, and whether settings.json could be updated.
 * @example
 * init("/home/user/app", "1.0.0").lines.forEach((l) => console.log(l));
 */
export function init(repo: string, packageVersion: string): InitResult {
  const config = scaffoldConfig(repo, packageVersion);
  const hook = registerHook(repo);
  return { lines: [config, hook.line].map((l) => OUTPUT_PREFIX + l), ok: hook.ok };
}
