const { test } = require("node:test");
const assert = require("node:assert/strict");
const { spawnSync } = require("child_process");
const path = require("path");

const CLI = path.join(__dirname, "..", "bin", "bundle-lint.js");
const FIXTURE = path.join(__dirname, "fixtures", "valid-bundle");

const run = (...args) => spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8" });

test("bundle-lint exits 0 on a valid bundle", () => {
  const result = run(FIXTURE);

  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /✓ test-practice@1\.0\.0: valid/);
});

test("bundle-lint exits 1 and lists errors on an invalid one", () => {
  const result = run(path.join(__dirname, "fixtures"));

  assert.equal(result.status, 1);
  assert.match(result.stdout, /bundle\.yaml" does not exist/);
});

test("--json prints machine-readable results", () => {
  const result = run(FIXTURE, "--json");

  assert.deepEqual(JSON.parse(result.stdout), { errors: [], warnings: [] });
});

test("--previous compares against an earlier release", () => {
  const result = run(FIXTURE, "--previous", FIXTURE);

  assert.equal(result.status, 1);
  assert.match(result.stdout, /must be greater than the previous 1\.0\.0/);
});
