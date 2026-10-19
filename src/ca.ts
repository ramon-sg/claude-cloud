/**
 * @file Discovery of the cloud proxy CA bundle and safe shell quoting for the lines written to the env file.
 */
import { PROXY_CA_DEFAULT } from "./constants.ts";

/** Environment variables that may point at the CA bundle, in priority order. */
const CA_ENV_VARS = ["SSL_CERT_FILE", "NODE_EXTRA_CA_CERTS"] as const;

/**
 * Finds the proxy CA bundle: `SSL_CERT_FILE`, then `NODE_EXTRA_CA_CERTS`, then the default path.
 *
 * @param env - Process environment.
 * @param exists - Tells whether a file exists.
 * @returns The first candidate that exists, or undefined.
 * @example
 * findProxyCa({ SSL_CERT_FILE: "/etc/ca.crt" }, () => true); // "/etc/ca.crt"
 */
export function findProxyCa(env: NodeJS.ProcessEnv, exists: (path: string) => boolean): string | undefined {
  const candidates = [...CA_ENV_VARS.map((name) => env[name]), PROXY_CA_DEFAULT];
  return candidates.find((path): path is string => Boolean(path) && exists(path as string));
}

/**
 * Quotes a value for a POSIX shell using single quotes, so nothing in it is interpreted.
 *
 * @param value - Any string.
 * @returns The value wrapped in single quotes, with embedded quotes escaped as `'\''`.
 * @example
 * shellQuote("it's"); // 'it'\''s'
 */
export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
