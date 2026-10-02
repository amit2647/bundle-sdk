const path = require("path");

const { loadBundle } = require("./load");
const { lintManifest, classifyChange } = require("./lint");
const conditions = require("./conditions");
const schedules = require("./schedules");
const templates = require("./templates");
const permissions = require("./permissions");

/*
 * Loads and lints a bundle directory in one step: what bundle-lint runs, and
 * what bundle-service runs before an install.
 */
function lintBundle(dir, { previousDir } = {}) {
  const loaded = loadBundle(dir);

  if (loaded.errors.length > 0 || !loaded.manifest) {
    return { manifest: loaded.manifest, errors: loaded.errors, warnings: [] };
  }

  let previous = null;

  if (previousDir) {
    const before = loadBundle(previousDir);

    if (before.errors.length > 0 || !before.manifest) {
      return {
        manifest: loaded.manifest,
        errors: before.errors.map((error) => `previous version: ${error}`),
        warnings: [],
      };
    }

    previous = before.manifest;
  }

  const { errors, warnings } = lintManifest(loaded.manifest, { fixtures: loaded.fixtures, previous });

  return { manifest: loaded.manifest, errors, warnings };
}

module.exports = {
  CONTRACT_VERSION: 1,
  contractSchemaPath: path.join(__dirname, "..", "contract", "v1", "manifest.schema.json"),
  loadBundle,
  lintBundle,
  lintManifest,
  classifyChange,
  conditions,
  schedules,
  templates,
  permissions,
};
