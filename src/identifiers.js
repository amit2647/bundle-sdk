const { evaluate } = require("./conditions");

/*
 * A bundle's identifiers (PAN, CIN, GSTIN…) as they apply to one client.
 *
 * Shared by customer-service, which enforces them, and the client wizard,
 * which shows and requires the same ones as the client's fields change —
 * so the form and the server cannot disagree about whether a CIN is needed.
 *
 * `client` is what conditions read: { attributes, … }.
 */

const normalise = (value) => (typeof value === "string" ? value.trim().toUpperCase() : value);

function forClient(identifiers = [], client = {}) {
  const data = { client };

  return identifiers
    .filter((identifier) => (identifier.appliesTo || "client") === "client")
    .map((identifier) => ({
      ...identifier,
      shown: identifier.shownWhen === undefined ? true : Boolean(evaluate(identifier.shownWhen, data)),
      required: identifier.requiredWhen === undefined ? false : Boolean(evaluate(identifier.requiredWhen, data)),
    }));
}

/*
 * Checks a client's identifier values ({ pan: "…", cin: "…" }) against the
 * bundle. Returns { values, errors }: values normalised (upper-case, blanks
 * dropped), errors as field → message. Uniqueness is the database's job.
 */
function check(identifiers = [], client = {}, values = {}) {
  const errors = {};
  const normalised = {};
  const rules = forClient(identifiers, client);
  const known = new Set(rules.map((rule) => rule.type));

  for (const type of Object.keys(values || {})) {
    if (!known.has(type)) {
      errors[type] = `${type} is not an identifier of this bundle`;
    }
  }

  for (const rule of rules) {
    const value = normalise(values?.[rule.type]);

    if (value === undefined || value === null || value === "") {
      if (rule.required) {
        errors[rule.type] = `${rule.label} is required`;
      }

      continue;
    }

    if (!rule.shown) {
      // A value for an identifier this client does not take is dropped
      // rather than stored where nothing shows it.
      continue;
    }

    if (rule.pattern && !new RegExp(rule.pattern).test(value)) {
      errors[rule.type] = `${rule.label} is not in the expected format`;
      continue;
    }

    normalised[rule.type] = value;
  }

  return { values: normalised, errors };
}

module.exports = { forClient, check, normalise };
