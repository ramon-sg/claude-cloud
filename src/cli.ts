#!/usr/bin/env node
/**
 * @file Command line entry point of claude-cloud (stub: later tasks add the commands).
 */
import { readFileSync } from "node:fs";

/** Prefix of every line the CLI prints. */
const OUTPUT_PREFIX = "claude-cloud: ";

/** Help text shown by `--help`. */
const HELP = `${OUTPUT_PREFIX}prepares Claude Code cloud sessions.

Usage: claude-cloud [--help] [--version]
`;

/**
 * Reads the package version from the package.json next to `src/` or `dist/`.
 *
 * @returns The version string.
 * @throws When package.json cannot be read or parsed.
 */
function readVersion(): string {
  const file = new URL("../package.json", import.meta.url);
  const pkg = JSON.parse(readFileSync(file, "utf8")) as { version: string };
  return pkg.version;
}

/**
 * Runs the CLI.
 *
 * @param argv - Arguments after the executable name.
 * @returns The process exit code.
 */
function main(argv: string[]): number {
  if (argv.includes("--version")) {
    console.log(readVersion());
    return 0;
  }
  console.log(HELP);
  return argv.includes("--help") || argv.length === 0 ? 0 : 1;
}

process.exitCode = main(process.argv.slice(2));
