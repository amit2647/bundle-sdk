#!/usr/bin/env node

/*
 * bundle-lint [bundle-dir] [--previous <dir-of-previous-release>] [--json]
 *
 * Exits 1 when the bundle has errors. With --previous, also checks that the
 * version bump matches what changed (a breaking change needs a major release
 * and upgrade steps). In CI, check the previous tag out into a directory:
 *
 *   git worktree add ../previous v1.2.0 && npx bundle-lint . --previous ../previous
 */

const path = require("path");

const { lintBundle } = require("../src");

const argv = process.argv.slice(2);
const json = argv.includes("--json");
const previousIndex = argv.indexOf("--previous");
const previousDir = previousIndex >= 0 ? argv[previousIndex + 1] : undefined;
const positional = argv.filter(
  (arg, index) => !arg.startsWith("--") && !(previousIndex >= 0 && index === previousIndex + 1),
);
const dir = path.resolve(positional[0] || ".");

const { manifest, errors, warnings } = lintBundle(dir, {
  previousDir: previousDir ? path.resolve(previousDir) : undefined,
});

if (json) {
  console.log(JSON.stringify({ errors, warnings }, null, 2));
} else {
  const name = manifest ? `${manifest.key}@${manifest.version}` : dir;

  for (const warning of warnings) {
    console.log(`warning  ${warning}`);
  }

  for (const error of errors) {
    console.log(`error    ${error}`);
  }

  console.log(
    errors.length === 0
      ? `✓ ${name}: valid (${warnings.length} warning${warnings.length === 1 ? "" : "s"})`
      : `✗ ${name}: ${errors.length} error${errors.length === 1 ? "" : "s"}`,
  );
}

process.exitCode = errors.length === 0 ? 0 : 1;
