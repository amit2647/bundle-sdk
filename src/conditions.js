/*
 * The condition language a bundle uses wherever something depends on a client:
 * which deadlines a rule generates, which documents are enabled, which portals
 * apply.
 *
 * A subset of JSONLogic (https://jsonlogic.com) — data, never code. Every
 * expression is either a literal, an array of expressions, or an object with
 * exactly one operator key:
 *
 *   { "var": "engagement.attributes.agm_on" }          read a value (dotted path)
 *   { "var": ["client.attributes.x", "fallback"] }     ... with a default
 *   { "==": [a, b] }  { "!=": [a, b] }                  strict comparison
 *   { "<": [a, b] } and <=, >, >=                       numbers or ISO dates
 *   { "in": [needle, ["a", "b"]] }                      membership (array or substring)
 *   { "and": [...] }  { "or": [...] }  { "!": x }       logic
 *   { "engaged": "tax_audit" }                          a service is engaged this period
 *   { "filled": { "var": "..." } }                      a value is present
 *
 * Unlike JSONLogic, == is strict: "1" is not 1. Bundles are written by people
 * reading them later, and loose equality is a place for surprises to hide.
 */

const COMPARISONS = {
  "==": (a, b) => a === b,
  "!=": (a, b) => a !== b,
  "<": (a, b) => comparable(a, b) && a < b,
  "<=": (a, b) => comparable(a, b) && a <= b,
  ">": (a, b) => comparable(a, b) && a > b,
  ">=": (a, b) => comparable(a, b) && a >= b,
};

const OPERATORS = new Set([
  "var",
  ...Object.keys(COMPARISONS),
  "in",
  "and",
  "or",
  "!",
  "engaged",
  "filled",
]);

// Ordering only means something between two numbers or two strings (ISO dates
// sort as strings); anything else is simply false rather than coerced.
function comparable(a, b) {
  return (
    (typeof a === "number" && typeof b === "number") ||
    (typeof a === "string" && typeof b === "string")
  );
}

function readPath(data, path) {
  if (path === "" || path === undefined || path === null) {
    return data;
  }

  return String(path)
    .split(".")
    .reduce((node, key) => (node == null ? undefined : node[key]), data);
}

function isFilled(value) {
  if (value === undefined || value === null) {
    return false;
  }

  if (typeof value === "string") {
    return value.trim() !== "";
  }

  if (Array.isArray(value)) {
    return value.length > 0;
  }

  return true;
}

function args(value) {
  return Array.isArray(value) ? value : [value];
}

/*
 * Evaluates an expression against `data`. The engaged services are read from
 * `data.engaged`, an array of catalog keys, so the caller decides what
 * "engaged this period" means once, not every rule.
 *
 * An invalid expression throws; validate() is how a bundle is checked before
 * anything evaluates it.
 */
function evaluate(expression, data = {}) {
  if (Array.isArray(expression)) {
    return expression.map((item) => evaluate(item, data));
  }

  if (expression === null || typeof expression !== "object") {
    return expression;
  }

  const keys = Object.keys(expression);

  if (keys.length !== 1 || !OPERATORS.has(keys[0])) {
    throw new Error(`Invalid condition: ${JSON.stringify(expression)}`);
  }

  const [operator] = keys;
  const operand = expression[operator];

  switch (operator) {
    case "var": {
      const [path, fallback] = args(operand);
      const value = readPath(data, evaluate(path, data));

      return value === undefined ? (fallback === undefined ? null : evaluate(fallback, data)) : value;
    }

    case "in": {
      const [needle, haystack] = args(operand).map((item) => evaluate(item, data));

      if (Array.isArray(haystack)) {
        return haystack.includes(needle);
      }

      return typeof haystack === "string" && typeof needle === "string"
        ? haystack.includes(needle)
        : false;
    }

    case "and":
      return args(operand).every((item) => Boolean(evaluate(item, data)));

    case "or":
      return args(operand).some((item) => Boolean(evaluate(item, data)));

    case "!":
      return !evaluate(args(operand)[0], data);

    case "engaged": {
      const service = evaluate(args(operand)[0], data);

      return Array.isArray(data.engaged) && data.engaged.includes(service);
    }

    case "filled":
      return isFilled(evaluate(args(operand)[0], data));

    default: {
      const [left, right] = args(operand).map((item) => evaluate(item, data));

      return COMPARISONS[operator](left, right);
    }
  }
}

/*
 * Checks an expression's shape without evaluating it, and reports what it
 * refers to so lint can confirm those exist: every `var` path, and every
 * service named by `engaged`.
 */
function validate(expression, where = "condition") {
  const errors = [];
  const vars = new Set();
  const services = new Set();

  function walk(node, path) {
    if (Array.isArray(node)) {
      node.forEach((item, index) => walk(item, `${path}[${index}]`));
      return;
    }

    if (node === null || typeof node !== "object") {
      return;
    }

    const keys = Object.keys(node);

    if (keys.length !== 1) {
      errors.push(`${path}: an operator object must have exactly one key, found ${keys.length}`);
      return;
    }

    const [operator] = keys;
    const operand = node[operator];

    if (!OPERATORS.has(operator)) {
      errors.push(`${path}: unknown operator "${operator}"`);
      return;
    }

    if (operator === "var") {
      const [target] = args(operand);

      if (typeof target === "string") {
        vars.add(target);
      } else {
        errors.push(`${path}: "var" takes a path string`);
      }

      return;
    }

    if (operator === "engaged") {
      const [service] = args(operand);

      if (typeof service === "string") {
        services.add(service);
      } else {
        errors.push(`${path}: "engaged" takes a service key`);
      }

      return;
    }

    if (operator in COMPARISONS || operator === "in") {
      if (!Array.isArray(operand) || operand.length !== 2) {
        errors.push(`${path}: "${operator}" takes exactly two arguments`);
        return;
      }
    }

    walk(operand, `${path}.${operator}`);
  }

  walk(expression, where);

  return { errors, vars: [...vars], services: [...services] };
}

module.exports = { evaluate, validate, isFilled, readPath, OPERATORS };
