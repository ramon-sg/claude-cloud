/**
 * @file The `doctor` command: checks the network allowlist, the pinned tools, Docker and the
 * recorded machine state, and reports one line per check.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { readConfig } from "./config.ts";
import { CONFIG_FILE, OUTPUT_PREFIX } from "./constants.ts";
import { TOOLS, readToolVersions } from "./detect.ts";
import { INSTALLERS } from "./installers.ts";
import { expectedFingerprint } from "./session.ts";
import { readState } from "./state.ts";

/** Hosts the setup needs to reach through the cloud proxy. */
export const DOMAINS = ["registry.npmjs.org", "nodejs.org", "registry-1.docker.io", "pypi.org", "api.github.com"];

/** Time limit of each HEAD request, in milliseconds. */
const FETCH_TIMEOUT_MS = 5000;

/** HTTP status the proxy answers with when a host is not on the allowlist. */
const BLOCKED_STATUS = 403;

/** Milliseconds in a second. */
const MS_PER_SECOND = 1000;

/** Decimals shown in step durations. */
const DURATION_DECIMALS = 1;

/** Everything `doctor` needs from the outside, so tests can inject fakes. */
export interface DoctorContext {
  /** Fetch used for the HEAD requests. */
  fetch: typeof fetch;
  /** Tools directory. */
  toolsDir: string;
  /** Version of this package. */
  packageVersion: string;
  /** Tells whether `docker info` succeeds. */
  dockerInfo: () => boolean;
}

/** Result of `doctor`. */
export interface DoctorResult {
  /** One prefixed line per check. */
  lines: string[];
  /** False when any check failed. */
  ok: boolean;
}

/** One check outcome before formatting. */
interface Check {
  /** Description of what was checked, with its verdict. */
  text: string;
  /** Whether it passed. */
  ok: boolean;
}

/**
 * Checks that a host answers through the proxy: any status except 403 counts as reachable.
 *
 * @param host - Host name.
 * @param doFetch - Fetch to use.
 * @returns The check outcome.
 */
async function checkDomain(host: string, doFetch: typeof fetch): Promise<Check> {
  try {
    const res = await doFetch(`https://${host}/`, { method: "HEAD", signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    const ok = res.status !== BLOCKED_STATUS;
    return { text: `network ${host}: ${ok ? "ok" : "blocked"}`, ok };
  } catch {
    return { text: `network ${host}: blocked`, ok: false };
  }
}

/**
 * Checks that every pinned tool has its executable installed.
 *
 * @param repo - Repo root.
 * @param toolsDir - Tools directory.
 * @returns One check per pinned tool.
 */
function checkTools(repo: string, toolsDir: string): Check[] {
  const versions = readToolVersions(repo);
  return TOOLS.flatMap((tool) => {
    const version = versions[tool];
    if (!version) return [];
    const present = existsSync(join(INSTALLERS[tool].binDir(toolsDir, version), tool));
    return [{ text: `tool ${tool} ${version}: ${present ? "ok" : "missing"}`, ok: present }];
  });
}

/**
 * Checks the repo config, the recorded state, its fingerprint and the step durations.
 *
 * @param repo - Repo root.
 * @param ctx - Dependencies.
 * @returns The checks, in order.
 */
function checkState(repo: string, ctx: DoctorContext): Check[] {
  if (!existsSync(join(repo, CONFIG_FILE))) return [{ text: `${CONFIG_FILE}: missing`, ok: false }];
  const { config, errors } = readConfig(repo);
  const out: Check[] = errors.map((text) => ({ text: `${CONFIG_FILE}: ${text}`, ok: false }));
  if (!config) return out;
  const state = readState(ctx.toolsDir, repo);
  if (!state) return [...out, { text: "state: missing (setup did not run)", ok: false }];
  const same = expectedFingerprint(repo, config, state) === state.fingerprint;
  out.push({ text: `fingerprint: ${same ? "ok" : "mismatch"}`, ok: same });
  for (const s of state.steps) {
    const seconds = (s.ms / MS_PER_SECOND).toFixed(DURATION_DECIMALS);
    out.push({ text: `step ${s.name}: ${s.ok ? "ok" : "failed"} (${seconds}s)`, ok: s.ok });
  }
  return out;
}

/**
 * Runs every diagnostic for a repo; never throws.
 *
 * @param repo - Repo root.
 * @param ctx - Dependencies (fetch, tools dir, package version, Docker probe).
 * @returns The report lines and whether everything passed.
 * @example
 * const { lines, ok } = await doctor("/home/user/app", { fetch, toolsDir, packageVersion: "1.0.0", dockerInfo });
 */
export async function doctor(repo: string, ctx: DoctorContext): Promise<DoctorResult> {
  const checks: Check[] = await Promise.all(DOMAINS.map((host) => checkDomain(host, ctx.fetch)));
  checks.push(...checkTools(repo, ctx.toolsDir));
  const docker = ctx.dockerInfo();
  checks.push({ text: `docker: ${docker ? "ok" : "missing"}`, ok: docker });
  checks.push(...checkState(repo, ctx));
  return { lines: checks.map((c) => OUTPUT_PREFIX + c.text), ok: checks.every((c) => c.ok) };
}
