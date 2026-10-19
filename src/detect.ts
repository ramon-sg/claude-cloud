/**
 * @file Deduces tool versions, Docker images and the default branch from a repo's files.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** Tools whose versions can be pinned. */
export const TOOLS = ["node", "bun", "deno", "pnpm", "yarn", "uv"] as const;

/** A tool whose version can be detected. */
export type Tool = (typeof TOOLS)[number];

/** Versions found, by tool. */
type Versions = Partial<Record<Tool, string>>;

/** Branch name used when nothing else can be determined. */
const FALLBACK_BRANCH = "main";

/** Maximum directory depth (root is 0) searched for Dockerfiles. */
const DOCKERFILE_MAX_DEPTH = 3;

/** Directories never searched for Dockerfiles. */
const SKIPPED_DIRS: readonly string[] = ["node_modules", ".git"];

/** Alternative names that map to a supported tool. */
const TOOL_ALIASES: Readonly<Record<string, Tool>> = { nodejs: "node" };

/** Matches `docker-compose*.yml|yaml` and `compose*.yml|yaml`. */
const COMPOSE_FILE = /^(docker-)?compose.*\.ya?ml$/;

/** Matches an `image:` line in a compose file. */
const IMAGE_LINE = /^\s*image:\s*(\S+)/;

/** Matches a pinned `FROM` line in a Dockerfile. */
const FROM_LINE = /^FROM\s+(?:--\S+\s+)*(\S+@sha256:\S+)/i;

/** Matches the `HEAD branch:` line of `git remote show`. */
const HEAD_BRANCH_LINE = /^\s*HEAD branch:\s*(\S+)/m;

/**
 * Reads a file as text.
 *
 * @param path - File to read.
 * @returns Its contents, or undefined when missing or unreadable.
 */
function readText(path: string): string | undefined {
  try {
    return existsSync(path) ? readFileSync(path, "utf8") : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Resolves a name to a supported tool.
 *
 * @param name - Name as written in the source file.
 * @returns The tool, or undefined when unsupported.
 */
function toTool(name: string): Tool | undefined {
  const mapped = TOOL_ALIASES[name] ?? name;
  return (TOOLS as readonly string[]).includes(mapped) ? (mapped as Tool) : undefined;
}

/**
 * Parses `.tool-versions` lines (`name version`).
 *
 * @param text - File contents.
 * @returns Detected versions.
 */
function parseToolVersions(text: string): Versions {
  const found: Versions = {};
  for (const line of text.split("\n")) {
    const [name, version] = line.replace(/#.*/, "").trim().split(/\s+/);
    const tool = name ? toTool(name) : undefined;
    if (tool && version) found[tool] ??= version;
  }
  return found;
}

/**
 * Parses the `[tools]` section of `mise.toml` (`name = "version"`).
 *
 * @param text - File contents.
 * @returns Detected versions.
 */
function parseMise(text: string): Versions {
  const found: Versions = {};
  let inTools = false;
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line.startsWith("[")) inTools = line === "[tools]";
    const match = inTools ? /^"?([\w.-]+)"?\s*=\s*["']([^"']+)["']/.exec(line) : null;
    const tool = match?.[1] ? toTool(match[1]) : undefined;
    if (tool && match?.[2]) found[tool] ??= match[2];
  }
  return found;
}

/**
 * Parses `.nvmrc`.
 *
 * @param text - File contents.
 * @returns The node version, if any.
 */
function parseNvmrc(text: string): Versions {
  const version = text.trim().replace(/^v/, "");
  return version ? { node: version } : {};
}

/**
 * Parses `package.json#packageManager` (`name@version+hash`).
 *
 * @param text - File contents.
 * @returns Detected versions.
 */
function parsePackageManager(text: string): Versions {
  try {
    const value: unknown = (JSON.parse(text) as { packageManager?: unknown }).packageManager;
    const match = typeof value === "string" ? /^([^@]+)@([^+]+)/.exec(value) : null;
    const tool = match?.[1] ? toTool(match[1]) : undefined;
    return tool && match?.[2] ? { [tool]: match[2] } : {};
  } catch {
    return {};
  }
}

/**
 * Reads pinned tool versions; the first source that defines a tool wins.
 *
 * @param repo - Path of the repo root.
 * @returns Versions by tool; unsupported tools are ignored.
 * @example
 * readToolVersions("/home/user/repo"); // { node: "24.14.1", bun: "1.4.2" }
 */
export function readToolVersions(repo: string): Versions {
  const sources: Array<[string, (text: string) => Versions]> = [
    [".tool-versions", parseToolVersions],
    ["mise.toml", parseMise],
    [".nvmrc", parseNvmrc],
    ["package.json", parsePackageManager],
  ];
  const result: Versions = {};
  for (const [file, parse] of sources) {
    const text = readText(join(repo, file));
    if (text !== undefined) Object.assign(result, { ...parse(text), ...result });
  }
  return result;
}

/**
 * Extracts `image:` values from compose files in the repo root.
 *
 * @param repo - Path of the repo root.
 * @returns Image references, unfiltered.
 */
function composeImages(repo: string): string[] {
  const images: string[] = [];
  for (const entry of readdirSync(repo)) {
    if (!COMPOSE_FILE.test(entry)) continue;
    for (const line of (readText(join(repo, entry)) ?? "").split("\n")) {
      const match = IMAGE_LINE.exec(line);
      if (match?.[1]) images.push(match[1].replace(/^["']|["']$/g, ""));
    }
  }
  return images;
}

/**
 * Extracts digest-pinned `FROM` images from Dockerfiles up to a depth.
 *
 * @param dir - Directory to walk.
 * @param depth - Depth of `dir` (root is 0).
 * @returns Image references, unfiltered.
 */
function dockerfileImages(dir: string, depth: number): string[] {
  const images: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      const deeper = depth < DOCKERFILE_MAX_DEPTH && !SKIPPED_DIRS.includes(entry.name);
      if (deeper) images.push(...dockerfileImages(join(dir, entry.name), depth + 1));
    } else if (entry.name === "Dockerfile" || entry.name.startsWith("Dockerfile.")) {
      for (const line of (readText(join(dir, entry.name)) ?? "").split("\n")) {
        const match = FROM_LINE.exec(line.trim());
        if (match?.[1]) images.push(match[1]);
      }
    }
  }
  return images;
}

/**
 * Finds Docker images referenced by compose files and pinned in Dockerfiles.
 *
 * @param repo - Path of the repo root.
 * @returns Sorted, unique image references without variables (`$`).
 * @example
 * detectImages("/home/user/repo"); // ["oven/bun:1@sha256:abc", "postgres:16"]
 */
export function detectImages(repo: string): string[] {
  try {
    const all = [...composeImages(repo), ...dockerfileImages(repo, 0)];
    return [...new Set(all.filter((image) => !image.includes("$")))].sort();
  } catch {
    return [];
  }
}

/**
 * Runs git synchronously and returns trimmed stdout.
 *
 * @param repo - Working directory.
 * @param args - Git arguments.
 * @returns Output, or undefined when git fails.
 */
function gitOutput(repo: string, args: string[]): string | undefined {
  try {
    return execFileSync("git", args, { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return undefined;
  }
}

/**
 * Finds the repo's default branch; never throws.
 *
 * @param repo - Path of the repo root.
 * @returns The branch from `origin/HEAD`, else from `git remote show origin`, else `main`.
 * @example
 * defaultBranch("/home/user/repo"); // "main"
 */
export function defaultBranch(repo: string): string {
  const ref = gitOutput(repo, ["symbolic-ref", "refs/remotes/origin/HEAD"]);
  const fromRef = ref?.replace(/^refs\/remotes\/origin\//, "");
  if (fromRef) return fromRef;
  const fromRemote = HEAD_BRANCH_LINE.exec(gitOutput(repo, ["remote", "show", "origin"]) ?? "")?.[1];
  return fromRemote && fromRemote !== "(unknown)" ? fromRemote : FALLBACK_BRANCH;
}
