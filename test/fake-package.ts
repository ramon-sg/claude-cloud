/**
 * @file Test helper: builds a fake copy of this package (manifest plus `dist/cli.js`) for the
 * self install to copy, so tests never depend on a build.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** Contents of the fake CLI entry point. */
export const FAKE_CLI = "#!/usr/bin/env node\nconsole.log('fake');\n";

/**
 * Creates a fake package root.
 *
 * @param dir - Folder to create it in.
 * @param version - Version written to its manifest.
 * @returns The package root.
 * @example
 * const root = fakePackage("/tmp/x", "1.0.0");
 */
export function fakePackage(dir: string, version: string): string {
  const root = join(dir, `fake-package-${version}`);
  mkdirSync(join(root, "dist"), { recursive: true });
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "@ramon-sg/claude-cloud", version }));
  writeFileSync(join(root, "dist", "cli.js"), FAKE_CLI, { mode: 0o644 });
  writeFileSync(join(root, "dist", "setup.js"), "export {};\n");
  return root;
}
