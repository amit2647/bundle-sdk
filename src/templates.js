const Handlebars = require("handlebars");

const { evaluate } = require("./conditions");
const schedules = require("./schedules");

/*
 * Document templates: Handlebars, locked down.
 *
 * - Output is always HTML-escaped. {{{triple}}} and {{& unescaped}} are
 *   refused, so client data typed into a form can never become markup (FIX-03).
 * - Only the helpers below exist. No partials, no decorators, no lookup into
 *   prototypes — a template is data a bundle ships, not code it runs.
 * - A value that is missing renders as a visible, highlighted [Label] rather
 *   than an empty space, so a letter printed with a gap is impossible to miss
 *   (DOC-12) — the same rule email-service follows for its placeholders.
 *
 * Email templates do NOT use this: they keep email-service's logic-free
 * {{path}} placeholders.
 */

const BUILT_IN = ["if", "unless", "each", "with"];

// The roots a document's top-level placeholders may read from.
const BINDING_ROOTS = ["client", "engagement", "firm", "signatory", "fields", "today", "period"];

const env = Handlebars.create();

// Builtins a bundle has no business using.
for (const name of ["lookup", "log", "blockHelperMissing"]) {
  env.unregisterHelper(name);
}

const label = (path, labels) => (labels && labels[path]) || path.split(".").pop().replace(/_/g, " ");

function placeholder(text) {
  return new Handlebars.SafeString(
    `<mark class="doc-placeholder">[${Handlebars.escapeExpression(text)}]</mark>`,
  );
}

function rootOf(options) {
  return (options && options.data && options.data.root) || {};
}

const formatDate = (value) => {
  const parsed = schedules.parseDate(value);

  if (!parsed) {
    return value;
  }

  // Formatted in UTC from a date-only value: the date shown is the date stored.
  return new Intl.DateTimeFormat("en-IN", {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(Date.UTC(parsed.year, parsed.month - 1, parsed.day)));
};

const HELPERS = {
  // {{v path "path"}} — inserted by compile() around every plain placeholder.
  v(value, path, options) {
    if (value === undefined || value === null || value === "") {
      return placeholder(label(path, rootOf(options).__labels));
    }

    return value;
  },

  eq: (a, b) => a === b,

  // {{#if (inList client.attributes.constitution "pvt_ltd" "public_ltd")}}
  inList(value, ...rest) {
    rest.pop(); // Handlebars' options object
    const list = rest.length === 1 && Array.isArray(rest[0]) ? rest[0] : rest;

    return list.includes(value);
  },

  date(value) {
    return value ? formatDate(value) : value;
  },

  money(value, options) {
    if (value === undefined || value === null || value === "" || Number.isNaN(Number(value))) {
      return value;
    }

    const currency = (rootOf(options).firm && rootOf(options).firm.currency) || "INR";

    return new Intl.NumberFormat("en-IN", { style: "currency", currency }).format(Number(value));
  },

  // {{date (fyEnd engagement.period_label)}} → "31 March 2026"
  fyStart(label, options) {
    return safePeriod(label, options, "start");
  },

  fyEnd(label, options) {
    return safePeriod(label, options, "end");
  },

  upper: (value) => (typeof value === "string" ? value.toUpperCase() : value),

  // {{#if (engaged "tax_audit")}}
  engaged(service, options) {
    return evaluate({ engaged: service }, rootOf(options));
  },
};

function safePeriod(label, options, edge) {
  try {
    const root = rootOf(options);

    return schedules.periodFromLabel(label, { periodStartMonth: root.periodStartMonth })[edge];
  } catch {
    return undefined;
  }
}

for (const [name, helper] of Object.entries(HELPERS)) {
  env.registerHelper(name, helper);
}

const KNOWN = Object.fromEntries([...BUILT_IN, ...Object.keys(HELPERS)].map((name) => [name, true]));

/*
 * Parses a template and reports every problem at once, plus the placeholder
 * paths it reads (for binding checks). Does not compile.
 */
function inspect(body) {
  const errors = [];
  const paths = [];
  let ast;

  try {
    ast = Handlebars.parse(String(body));
  } catch (error) {
    return { errors: [`does not parse: ${error.message.split("\n")[0]}`], paths, ast: null };
  }

  function visitExpression(node, scoped) {
    if (!node) {
      return;
    }

    if (node.type === "PathExpression") {
      if (!node.data && node.original !== "this" && !scoped && node.depth === 0) {
        paths.push(node.original);
      }

      return;
    }

    if (node.type === "SubExpression") {
      checkHelper(node.path);
      (node.params || []).forEach((param) => visitExpression(param, scoped));
    }
  }

  function checkHelper(path) {
    const name = path && path.original;

    if (name && !KNOWN[name]) {
      errors.push(`unknown helper "${name}"`);
    }
  }

  function walk(program, scoped) {
    for (const node of program.body) {
      switch (node.type) {
        case "MustacheStatement":
          if (!node.escaped) {
            errors.push(`unescaped output is not allowed: {{{${node.path.original}}}}`);
          }

          if (node.params.length > 0 || node.hash) {
            checkHelper(node.path);
            node.params.forEach((param) => visitExpression(param, scoped));
          } else {
            visitExpression(node.path, scoped);
          }

          break;

        case "BlockStatement": {
          checkHelper(node.path);
          node.params.forEach((param) => visitExpression(param, scoped));

          // Inside each/with the context changes, so paths are relative.
          const inner = scoped || ["each", "with"].includes(node.path.original);

          if (node.program) {
            walk(node.program, inner);
          }

          if (node.inverse) {
            walk(node.inverse, scoped);
          }

          break;
        }

        case "PartialStatement":
        case "PartialBlockStatement":
          errors.push("partials are not allowed");
          break;

        case "Decorator":
        case "DecoratorBlock":
          errors.push("decorators are not allowed");
          break;

        default:
          break;
      }
    }
  }

  walk(ast, false);

  return { errors, paths: [...new Set(paths)], ast };
}

// Wraps every plain {{path}} in the `v` helper so a missing value shows up.
function wrapPlaceholders(program) {
  for (const node of program.body) {
    if (node.type === "MustacheStatement" && node.params.length === 0 && !node.hash) {
      const { path } = node;

      if (path.type === "PathExpression" && !KNOWN[path.original] && !path.data) {
        node.params = [path, { type: "StringLiteral", value: path.original, original: path.original, loc: path.loc }];
        node.path = { type: "PathExpression", data: false, depth: 0, parts: ["v"], original: "v", loc: path.loc };
      }
    }

    if (node.type === "BlockStatement") {
      if (node.program) wrapPlaceholders(node.program);
      if (node.inverse) wrapPlaceholders(node.inverse);
    }
  }

  return program;
}

/*
 * Compiles a template for rendering. Throws on anything inspect() rejects, so
 * a template that slipped past lint still cannot render unsafely.
 */
function compile(body) {
  const { errors, ast } = inspect(body);

  for (const [pattern, message] of FORBIDDEN_MARKUP) {
    const match = String(body).match(pattern);
    if (match) errors.push(message(match));
  }

  if (errors.length > 0) {
    throw new Error(`Invalid template: ${errors.join("; ")}`);
  }

  const template = env.compile(wrapPlaceholders(ast), {
    knownHelpers: KNOWN,
    knownHelpersOnly: true,
    noEscape: false,
    strict: false,
  });

  // `labels` maps a placeholder path to the label a missing value shows.
  return (context, { labels } = {}) =>
    template({ ...context, __labels: labels || {} }, {
      allowProtoPropertiesByDefault: false,
      allowProtoMethodsByDefault: false,
    });
}

function render(body, context, options) {
  return compile(body)(context, options);
}

/*
 * Markup a template may never contain. Values are escaped anyway; this keeps
 * the bundle's (or a firm's) own HTML inert too, before it ever reaches a
 * browser — the preview also renders in a sandboxed frame.
 */
const FORBIDDEN_MARKUP = [
  [/<\s*(script|iframe|object|embed|link|meta|base|form|frame|frameset)\b/i, (match) => `<${match[1].toLowerCase()}> is not allowed`],
  [/\son[a-z]+\s*=/i, () => "event-handler attributes (on…=) are not allowed"],
  [/(?:javascript|vbscript)\s*:/i, () => "script URLs (javascript:) are not allowed"],
  [/\bsrcdoc\s*=/i, () => "srcdoc attributes are not allowed"],
];

/*
 * Everything that can be checked about a template from the template and its
 * own field schema alone: it parses, uses only known helpers, escapes all
 * output, contains no active markup, reads only the binding roots and only
 * its own fields. bundle-lint runs it on every bundle document, and
 * document-service on a firm's edited template — the same rules, from one
 * place. (Lint additionally checks client.* and engagement.* paths against
 * the bundle's profile schemas.)
 */
function check(body, fieldsSchema) {
  const inspected = inspect(body);
  const errors = [...inspected.errors];
  const fields = new Set(Object.keys((fieldsSchema && fieldsSchema.properties) || {}));

  for (const [pattern, message] of FORBIDDEN_MARKUP) {
    const match = String(body).match(pattern);

    if (match) {
      errors.push(message(match));
    }
  }

  for (const placeholder of inspected.paths) {
    const [root, field] = placeholder.split(".");

    if (!BINDING_ROOTS.includes(root)) {
      errors.push(`"${placeholder}" — templates can read ${BINDING_ROOTS.join(", ")}`);
    } else if (root === "fields" && field && !fields.has(field)) {
      errors.push(`"${placeholder}" is not a field of this document`);
    }
  }

  return { errors, paths: inspected.paths };
}

module.exports = { inspect, check, compile, render, BINDING_ROOTS, HELPERS: Object.keys(KNOWN) };
