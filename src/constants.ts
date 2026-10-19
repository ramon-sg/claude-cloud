/**
 * @file Fixed values shared by the claude-cloud modules, each in a documented constant.
 */

/** Prefix of every line the CLI prints. */
export const OUTPUT_PREFIX = "claude-cloud: ";

/** Path of the repo config file, relative to the repo root. */
export const CONFIG_FILE = ".claude/cloud.json";

/** Name of this package on npm. */
export const PACKAGE = "@ramon-sg/claude-cloud";

/** Default root directory that holds the installed tools and the state files. */
export const TOOLS_DIR = "/opt/claude-cloud";

/** Environment variable that overrides `TOOLS_DIR` (used by tests). */
export const TOOLS_DIR_ENV = "CLAUDE_CLOUD_DIR";

/** Log file of the detached Docker daemon. */
export const DOCKERD_LOG = "/var/log/claude-cloud-dockerd.log";

/** Seconds to wait for the Docker daemon to answer. */
export const DOCKER_WAIT_SECONDS = 60;

/** Total step time, in milliseconds, above which setup is reported as slow. */
export const SETUP_SLOW_MS = 240_000;

/** Default location of the cloud proxy CA bundle. */
export const PROXY_CA_DEFAULT = "/root/.ccr/ca-bundle.crt";

/**
 * Resolves the tools directory, honoring the `CLAUDE_CLOUD_DIR` override.
 *
 * @param env - Process environment.
 * @returns The override when set and non-empty, otherwise `TOOLS_DIR`.
 * @example
 * toolsDir({ CLAUDE_CLOUD_DIR: "/tmp/x" }); // "/tmp/x"
 */
export function toolsDir(env: NodeJS.ProcessEnv): string {
  return env[TOOLS_DIR_ENV] || TOOLS_DIR;
}
