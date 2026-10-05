const crypto = require("crypto");
const Ajv2020 = require("ajv/dist/2020");
const addFormats = require("ajv-formats");

/*
 * Validates a record's bundle fields (`attributes`) against its profile
 * schema — the same Ajv set-up bundle-lint compiles those schemas with, so a
 * schema that lints is a schema that validates.
 *
 * Unknown fields are refused rather than silently stored: attributes are
 * shown and searched from the schema, so a field it does not describe would
 * be data nobody can see.
 */

const ajv = new Ajv2020({ strict: true, strictRequired: false, allErrors: true, useDefaults: true });
addFormats(ajv, ["date", "email"]);

const compiled = new Map();

function compile(schema) {
  const key = crypto.createHash("sha256").update(JSON.stringify(schema)).digest("hex");

  if (!compiled.has(key)) {
    compiled.set(key, ajv.compile({ ...schema, additionalProperties: false }));
  }

  return compiled.get(key);
}

const fieldOf = (error) =>
  error.keyword === "required"
    ? error.params.missingProperty
    : error.keyword === "additionalProperties"
      ? error.params.additionalProperty
      : error.instancePath.replace(/^\//, "").split("/")[0] || "attributes";

/*
 * Returns { valid, value, errors }: `value` is a copy with schema defaults
 * applied; `errors` maps field → message (the first problem per field).
 */
function validate(schema, attributes = {}) {
  const value = JSON.parse(JSON.stringify(attributes || {}));
  const check = compile(schema);

  if (check(value)) {
    return { valid: true, value, errors: {} };
  }

  const errors = {};

  for (const error of check.errors) {
    // if/then failures repeat the real cause; report the cause.
    if (error.keyword === "if") {
      continue;
    }

    const field = fieldOf(error);
    const title = schema.properties?.[field]?.title || field;

    errors[field] ??=
      error.keyword === "required"
        ? `${title} is required`
        : error.keyword === "additionalProperties"
          ? `${field} is not a field of this profile`
          : `${title} ${error.message}`;
  }

  return { valid: false, value, errors };
}

module.exports = { validate };
