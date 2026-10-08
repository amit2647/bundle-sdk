const { isDeepStrictEqual } = require("util");
const Ajv2020 = require("ajv/dist/2020");
const addFormats = require("ajv-formats");
const semver = require("semver");

const contractSchema = require("../contract/v1/manifest.schema.json");
const conditions = require("./conditions");
const schedules = require("./schedules");
const templates = require("./templates");
const { CORE, CAPABILITY, NEVER_IN_ROLE_TEMPLATES, RESERVED_NAMESPACES } = require("./permissions");

/*
 * bundle-lint: everything that can be known about a bundle without installing
 * it. Run in each bundle repo's CI, and again by bundle-service before an
 * install, so a bundle that would half-apply is refused before step one.
 *
 * Returns { errors, warnings } — errors block, warnings are advice.
 */

// Union types are deliberate in the contract (a condition is an object or a literal true/false).
// strictRequired is off because it misreads if/then blocks requiring properties
// defined on the parent schema — the pattern conditional forms are built on.
const ajv = new Ajv2020({ allErrors: true, strict: true, strictRequired: false, allowUnionTypes: true });
addFormats(ajv);
const validateContract = ajv.compile(contractSchema);

// The keywords a bundle's field schemas may use. Anything else — custom
// keywords, remote $refs — is refused: the same schema runs in Ajv on the
// server and in the form renderer in the browser, and both must agree.
const FIELD_KEYWORDS = new Set([
  "type", "properties", "required", "enum", "const", "pattern", "format",
  "minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "minLength", "maxLength",
  "items", "minItems", "maxItems", "uniqueItems", "additionalProperties",
  "if", "then", "else", "allOf", "not",
  "title", "description", "default", "examples", "$comment", "$ref", "$defs",
]);

// Generic columns a condition or template may read besides attributes.
// What a document (or a condition) can read on a client and an engagement.
// document-service builds its render context with exactly these: `signatory`
// is the client's authorised signatory (WIZ-05); `portals` lists the portals
// it has credentials for (FIX-22); `fee_total` and `expenses_total` sum the
// period's lines (DOC-11); `services` names them.
const CLIENT_FIELDS = new Set(["name", "company", "email", "phone", "address", "notes", "attributes", "identifiers", "people", "signatory", "portals"]);
const ENGAGEMENT_FIELDS = new Set(["period_label", "period_start", "period_end", "stage", "status", "appointment_on", "attributes", "lines", "type", "fee_total", "expenses_total", "services"]);

const EMAIL_ROOTS = {
  "lead.created": ["lead", "organization"],
  "lead.converted": ["lead", "customer", "organization"],
  "customer.created": ["customer", "organization"],
  "engagement.created": ["engagement", "client", "organization"],
  "obligation.due_soon": ["obligation", "client", "organization"],
  "obligation.overdue": ["obligation", "client", "organization"],
};

const KEYED_SECTIONS = [
  ["identifiers", (m) => m.identifiers, "type"],
  ["peopleRoles", (m) => m.peopleRoles, "key"],
  ["pipeline", (m) => m.pipeline, "key"],
  ["engagementTypes", (m) => m.engagementTypes, "key"],
  ["catalog.groups", (m) => m.catalog && m.catalog.groups, "key"],
  ["catalog.services", (m) => m.catalog && m.catalog.services, "key"],
  ["catalog.packages", (m) => m.catalog && m.catalog.packages, "key"],
  ["obligations", (m) => m.obligations, "key"],
  ["documents", (m) => m.documents, "key"],
  ["vault.portals", (m) => m.vault && m.vault.portals, "key"],
  ["permissions", (m) => m.permissions, "code"],
  ["roles", (m) => m.roles, "key"],
  ["email", (m) => m.email, "key"],
  ["dashboard", (m) => m.dashboard, "key"],
];

const list = (value) => (Array.isArray(value) ? value : []);

function propertiesOf(schema) {
  return new Set(Object.keys((schema && schema.properties) || {}));
}

function checkFieldSchema(schema, where, errors, warnings = []) {
  function walk(node, at) {
    // An `if` testing a property it does not require also matches when the
    // field is empty, so its `then` fires for everyone who left it blank.
    if (node && typeof node === "object" && node.if && typeof node.if === "object" && node.if.properties) {
      const required = new Set(node.if.required || []);
      const unguarded = Object.keys(node.if.properties).filter((field) => !required.has(field));

      if (unguarded.length > 0) {
        warnings.push(`${at}.if: tests ${unguarded.join(", ")} without requiring it, so it also matches when that field is empty — add "required": ${JSON.stringify(unguarded)}`);
      }
    }

    if (Array.isArray(node)) {
      node.forEach((item, index) => walk(item, `${at}[${index}]`));
      return;
    }

    if (!node || typeof node !== "object") {
      return;
    }

    for (const [keyword, value] of Object.entries(node)) {
      if (!FIELD_KEYWORDS.has(keyword)) {
        errors.push(`${at}: keyword "${keyword}" is not allowed in a field schema`);
        continue;
      }

      if (keyword === "$ref" && !String(value).startsWith("#/")) {
        errors.push(`${at}: only local $refs ("#/…") are allowed`);
      }

      if (["properties", "$defs"].includes(keyword) && value && typeof value === "object") {
        for (const [name, child] of Object.entries(value)) {
          walk(child, `${at}.${keyword}.${name}`);
        }
      } else if (["items", "if", "then", "else", "not", "allOf", "additionalProperties"].includes(keyword)) {
        walk(value, `${at}.${keyword}`);
      }
    }
  }

  walk(schema, where);

  try {
    new Ajv2020({ strict: true, strictRequired: false, allErrors: true }).addFormat("date", true).addFormat("email", true).compile(schema);
  } catch (error) {
    errors.push(`${where}: does not compile: ${error.message}`);
  }
}

function checkUi(ui, schema, where, errors) {
  if (!ui) {
    return;
  }

  const fields = propertiesOf(schema);

  for (const key of Object.keys(ui)) {
    if (!key.startsWith("ui:") && !fields.has(key)) {
      errors.push(`${where}: "${key}" is not a field of the schema`);
    }
  }
}

/*
 * Checks a condition's operators and that what it reads exists: client and
 * engagement attributes against their schemas, engaged services against the
 * catalog.
 */
function checkCondition(expression, where, context, errors) {
  if (expression === undefined || typeof expression === "boolean") {
    return;
  }

  const result = conditions.validate(expression, where);

  errors.push(...result.errors);

  for (const service of result.services) {
    if (!context.services.has(service)) {
      errors.push(`${where}: engaged service "${service}" is not in the catalog`);
    }
  }

  for (const variable of result.vars) {
    checkPath(variable, where, context, errors, context.conditionRoots);
  }
}

function checkPath(variable, where, context, errors, roots) {
  const [root, field, attribute] = variable.split(".");

  if (!roots.includes(root)) {
    errors.push(`${where}: "${variable}" — "${root}" is not something this can read (${roots.join(", ")})`);
    return;
  }

  if (root === "client") {
    if (field && !CLIENT_FIELDS.has(field)) {
      errors.push(`${where}: "${variable}" — clients have no field "${field}"`);
    } else if (field === "attributes" && attribute && context.clientFields.size > 0 && !context.clientFields.has(attribute)) {
      errors.push(`${where}: "${variable}" — "${attribute}" is not in the client profile schema`);
    } else if (field === "identifiers" && attribute && !context.identifierTypes.has(attribute)) {
      errors.push(`${where}: "${variable}" — "${attribute}" is not a declared identifier`);
    }
  }

  if (root === "engagement") {
    if (field && !ENGAGEMENT_FIELDS.has(field)) {
      errors.push(`${where}: "${variable}" — engagements have no field "${field}"`);
    } else if (field === "attributes" && attribute && context.engagementFields.size > 0 && !context.engagementFields.has(attribute)) {
      errors.push(`${where}: "${variable}" — "${attribute}" is not in any engagement profile schema`);
    }
  }
}

function checkUniqueKeys(manifest, errors) {
  for (const [name, get, field] of KEYED_SECTIONS) {
    const seen = new Set();

    for (const item of list(get(manifest))) {
      const key = item && item[field];

      if (seen.has(key)) {
        errors.push(`${name}: "${key}" is declared more than once`);
      }

      seen.add(key);
    }
  }
}

function dryRun(manifest, fixtures, errors, warnings) {
  const rules = list(manifest.obligations);

  if (rules.length === 0) {
    return;
  }

  if (fixtures.length === 0) {
    warnings.push("obligations: no fixtures/clients/*.json — the one-year dry run was skipped");
    return;
  }

  const types = new Map(list(manifest.engagementTypes).map((type) => [type.key, type]));

  for (const { file, data } of fixtures) {
    const engagement = data.engagement || {};
    const type = types.get(engagement.type) || list(manifest.engagementTypes)[0];

    if (!type || type.periodKind === "none") {
      continue;
    }

    const options = { periodKind: type.periodKind, periodStartMonth: type.periodStartMonth };
    let period;

    try {
      period = engagement.period
        ? schedules.periodFromLabel(engagement.period, options)
        : schedules.periodFor(schedules.todayIn("UTC"), options);
    } catch (error) {
      errors.push(`${file}: ${error.message}`);
      continue;
    }

    const context = { client: data, engagement, engaged: list(data.engaged) };

    for (const rule of rules.filter((item) => context.engaged.includes(item.service))) {
      const where = `${file}: rule ${rule.key}`;
      let first;

      try {
        first = schedules.generate(rule, period, context);
      } catch (error) {
        errors.push(`${where}: ${error.message}`);
        continue;
      }

      if (!isDeepStrictEqual(first, schedules.generate(rule, period, context))) {
        errors.push(`${where}: generates different items on a second run`);
      }

      const keys = new Set();

      for (const item of first) {
        if (keys.has(item.periodKey)) {
          errors.push(`${where}: two items for ${item.periodKey}`);
        }

        keys.add(item.periodKey);

        if (!schedules.isDate(item.dueOn)) {
          errors.push(`${where}: ${item.periodKey} has an invalid due date "${item.dueOn}"`);
        } else if (item.periodStart && item.dueOn < item.periodStart) {
          errors.push(`${where}: ${item.periodKey} is due (${item.dueOn}) before its period starts`);
        }
      }
    }
  }
}

function lintManifest(manifest, { fixtures = [], previous = null } = {}) {
  const errors = [];
  const warnings = [];

  if (!validateContract(manifest)) {
    for (const error of validateContract.errors) {
      errors.push(`contract: ${error.instancePath || "/"} ${error.message}${error.params && error.params.additionalProperty ? ` ("${error.params.additionalProperty}")` : ""}`);
    }

    // Cross-checks assume the shape is right.
    return { errors, warnings };
  }

  checkUniqueKeys(manifest, errors);

  const services = new Set(list(manifest.catalog && manifest.catalog.services).map((service) => service.key));
  const bundlePermissions = new Set(list(manifest.permissions).map((permission) => permission.code));
  const knownPermissions = new Set([...CORE, ...CAPABILITY, ...bundlePermissions]);
  const engagementProfiles = (manifest.profiles && manifest.profiles.engagement) || {};

  const context = {
    services,
    clientFields: propertiesOf(manifest.profiles.client.schema),
    engagementFields: new Set(Object.values(engagementProfiles).flatMap((profile) => [...propertiesOf(profile.schema)])),
    identifierTypes: new Set(list(manifest.identifiers).map((identifier) => identifier.type)),
    conditionRoots: ["client", "engagement"],
  };

  // requires ↔ what the bundle actually uses
  const requires = new Set(manifest.requires.capabilities);
  const needs = [
    ["engagements", list(manifest.engagementTypes).length > 0],
    ["obligations", list(manifest.obligations).length > 0],
    ["documents", list(manifest.documents).length > 0],
    ["vault", list(manifest.vault && manifest.vault.portals).length > 0],
  ];

  for (const [capability, used] of needs) {
    if (used && !requires.has(capability)) {
      errors.push(`requires: the bundle uses ${capability} but does not list it`);
    }
  }

  if (list(manifest.obligations).length > 0 && list(manifest.engagementTypes).length === 0) {
    errors.push("obligations: rules need at least one engagement type to define their periods");
  }

  // profiles
  for (const [entity, profile] of Object.entries(manifest.profiles)) {
    if (entity === "engagement") {
      const typeKeys = new Set(list(manifest.engagementTypes).map((type) => type.key));

      for (const [type, item] of Object.entries(profile)) {
        if (!typeKeys.has(type)) {
          errors.push(`profiles.engagement.${type}: there is no engagement type "${type}"`);
        }

        checkFieldSchema(item.schema, `profiles.engagement.${type}.schema`, errors, warnings);
        checkUi(item.ui, item.schema, `profiles.engagement.${type}.ui`, errors);
      }

      continue;
    }

    checkFieldSchema(profile.schema, `profiles.${entity}.schema`, errors, warnings);
    checkUi(profile.ui, profile.schema, `profiles.${entity}.ui`, errors);
  }

  // identifiers
  for (const identifier of list(manifest.identifiers)) {
    for (const part of ["shownWhen", "requiredWhen"]) {
      checkCondition(identifier[part], `identifiers.${identifier.type}.${part}`, { ...context, conditionRoots: ["client"] }, errors);
    }

    if (identifier.requiredWhen !== undefined && identifier.appliesTo === "person") {
      errors.push(`identifiers.${identifier.type}: requiredWhen applies to client identifiers only`);
    }

    if (identifier.pattern) {
      try {
        new RegExp(identifier.pattern);
      } catch {
        errors.push(`identifiers.${identifier.type}: pattern does not compile`);
      }
    }
  }

  // people roles
  for (const role of list(manifest.peopleRoles)) {
    for (const [index, variant] of list(role.labelWhen).entries()) {
      checkCondition(variant.when, `peopleRoles.${role.key}.labelWhen[${index}]`, { ...context, conditionRoots: ["client"] }, errors);
    }
  }

  // pipeline
  const statuses = new Set();

  for (const column of list(manifest.pipeline)) {
    if (column.status === "Converted") {
      errors.push(`pipeline.${column.key}: "Converted" is reserved for converted leads`);
    }

    if (statuses.has(column.status)) {
      errors.push(`pipeline.${column.key}: status "${column.status}" is used by two columns`);
    }

    statuses.add(column.status);
  }

  // catalog
  const groups = new Set(list(manifest.catalog && manifest.catalog.groups).map((group) => group.key));
  const serviceNames = new Set();

  for (const service of list(manifest.catalog && manifest.catalog.services)) {
    if (service.group && !groups.has(service.group)) {
      errors.push(`catalog.services.${service.key}: group "${service.group}" is not declared`);
    }

    // services are UNIQUE (organization_id, name) in the database.
    if (serviceNames.has(service.name)) {
      errors.push(`catalog.services.${service.key}: name "${service.name}" is used twice`);
    }

    serviceNames.add(service.name);
  }

  for (const pack of list(manifest.catalog && manifest.catalog.packages)) {
    for (const key of pack.services) {
      if (!services.has(key)) {
        errors.push(`catalog.packages.${pack.key}: service "${key}" is not in the catalog`);
      }
    }
  }

  // obligations
  for (const rule of list(manifest.obligations)) {
    const where = `obligations.${rule.key}`;

    if (!services.has(rule.service)) {
      errors.push(`${where}: service "${rule.service}" is not in the catalog`);
    }

    if (rule.schedule && rule.schedule.dates && rule.frequency !== "quarterly") {
      errors.push(`${where}: per-quarter dates need frequency "quarterly"`);
    }

    checkCondition(rule.condition, `${where}.condition`, context, errors);

    if (rule.relativeTo) {
      checkPath(rule.relativeTo, `${where}.relativeTo`, context, errors, ["client", "engagement"]);
    }
  }

  // documents
  for (const document of list(manifest.documents)) {
    const where = `documents.${document.key}`;
    const checked = templates.check(document.body, document.fields);

    errors.push(...checked.errors.map((error) => `${where}: ${error}`));
    checkFieldSchema(document.fields, `${where}.fields`, errors, warnings);
    checkUi(document.ui, document.fields, `${where}.ui`, errors);
    checkCondition(document.enabledWhen, `${where}.enabledWhen`, { ...context, conditionRoots: ["client", "engagement", "firm"] }, errors);

    // Pre-filled fields (DOC-11) read a binding root, never another field.
    for (const [field, options] of Object.entries(document.ui || {})) {
      const path = options && typeof options === "object" ? options["ui:prefill"] : undefined;

      if (path === undefined) continue;

      const root = typeof path === "string" ? path.split(".")[0] : "";

      if (!templates.BINDING_ROOTS.includes(root) || root === "fields") {
        errors.push(`${where}.ui.${field}: ui:prefill "${path}" must read one of ${templates.BINDING_ROOTS.filter((name) => name !== "fields").join(", ")}`);
      } else if (["client", "engagement"].includes(root)) {
        checkPath(path, `${where}.ui.${field}`, context, errors, templates.BINDING_ROOTS);
      }
    }

    // Roots and fields are checked above; client.* and engagement.* paths
    // also have to exist in the bundle's profile schemas.
    for (const placeholder of checked.paths) {
      if (["client", "engagement"].includes(placeholder.split(".")[0])) {
        checkPath(placeholder, where, context, errors, templates.BINDING_ROOTS);
      }
    }
  }

  // vault
  const portals = list(manifest.vault && manifest.vault.portals);

  if (portals.some((portal) => portal.fields.some((field) => field.secret)) && !manifest.vault.consentFileCategory) {
    errors.push("vault: portals hold secrets, so consentFileCategory (the signed authority on file before any is saved) is required");
  }

  for (const portal of portals) {
    checkCondition(portal.enabledWhen, `vault.portals.${portal.key}.enabledWhen`, context, errors);
  }

  // permissions and roles
  if (RESERVED_NAMESPACES.includes(manifest.namespace)) {
    errors.push(`namespace: "${manifest.namespace}" is a platform permission group`);
  }

  for (const permission of list(manifest.permissions)) {
    if (!permission.code.startsWith(`${manifest.namespace}.`)) {
      errors.push(`permissions.${permission.code}: must start with the bundle namespace "${manifest.namespace}."`);
    }
  }

  for (const role of list(manifest.roles)) {
    for (const code of role.permissions) {
      if (!knownPermissions.has(code)) {
        errors.push(`roles.${role.key}: permission "${code}" does not exist`);
      } else if (NEVER_IN_ROLE_TEMPLATES(code)) {
        errors.push(`roles.${role.key}: "${code}" cannot be granted by a bundle role template`);
      }
    }
  }

  // email
  for (const email of list(manifest.email)) {
    const roots = EMAIL_ROOTS[email.trigger] || [];

    for (const text of [email.subject, email.body]) {
      for (const [, placeholder] of text.matchAll(/\{\{\s*([a-zA-Z0-9_.]+)\s*\}\}/g)) {
        if (!roots.includes(placeholder.split(".")[0])) {
          errors.push(`email.${email.key}: "{{${placeholder}}}" is not in the ${email.trigger} event (${roots.join(", ")})`);
        }
      }
    }
  }

  // dashboard and help
  for (const card of list(manifest.dashboard)) {
    if (!knownPermissions.has(card.permission)) {
      errors.push(`dashboard.${card.key}: permission "${card.permission}" does not exist`);
    }
  }

  for (const doc of list(manifest.help)) {
    if (!knownPermissions.has(doc.permission)) {
      errors.push(`help ${doc.path}: permission "${doc.permission}" does not exist`);
    }
  }

  dryRun(manifest, fixtures, errors, warnings);

  if (previous) {
    checkVersion(previous, manifest, errors);
  }

  return { errors, warnings };
}

const RANK = { none: 0, patch: 1, minor: 2, major: 3 };

/*
 * What kind of release the difference between two versions of a bundle needs:
 *   major — something an installed firm depends on went away or got stricter
 *   minor — something was added, or an item's content changed (a new revision)
 *   patch — only wording, labels and help changed
 */
function classifyChange(previous, next) {
  const reasons = [];
  const errors = [];
  let required = "none";

  const need = (level, reason) => {
    reasons.push(`${level}: ${reason}`);

    if (RANK[level] > RANK[required]) {
      required = level;
    }
  };

  for (const [name, get, field] of KEYED_SECTIONS) {
    const before = new Map(list(get(previous)).map((item) => [item[field], item]));
    const after = new Map(list(get(next)).map((item) => [item[field], item]));

    for (const [key, item] of before) {
      if (!after.has(key)) {
        need("major", `${name} "${key}" was removed`);
        continue;
      }

      const updated = after.get(key);

      if (isDeepStrictEqual(item, updated)) {
        continue;
      }

      if ("revision" in item && item.revision === updated.revision) {
        errors.push(`${name} "${key}" changed without a new revision`);
      }

      if (name === "identifiers" && !item.unique && updated.unique) {
        need("major", `identifier "${key}" became unique`);
      } else {
        need("minor", `${name} "${key}" changed`);
      }
    }

    for (const key of after.keys()) {
      if (!before.has(key)) {
        need("minor", `${name} "${key}" was added`);
      }
    }
  }

  const profilePairs = [];

  for (const entity of new Set([...Object.keys(previous.profiles || {}), ...Object.keys(next.profiles || {})])) {
    if (entity === "engagement") {
      const before = (previous.profiles && previous.profiles.engagement) || {};
      const after = (next.profiles && next.profiles.engagement) || {};

      for (const type of new Set([...Object.keys(before), ...Object.keys(after)])) {
        profilePairs.push([`engagement.${type}`, before[type], after[type]]);
      }
    } else {
      profilePairs.push([entity, previous.profiles && previous.profiles[entity], next.profiles && next.profiles[entity]]);
    }
  }

  for (const [entity, before, after] of profilePairs) {
    if (!before || !after) {
      if (before) need("major", `profile "${entity}" was removed`);
      if (after) need("minor", `profile "${entity}" was added`);
      continue;
    }

    if (isDeepStrictEqual(before.schema, after.schema)) {
      continue;
    }

    if (after.version <= before.version) {
      errors.push(`profile "${entity}" schema changed without a new version`);
    }

    const oldProps = before.schema.properties || {};
    const newProps = after.schema.properties || {};
    const oldRequired = new Set(before.schema.required || []);

    for (const field of after.schema.required || []) {
      if (!oldRequired.has(field)) {
        need("major", `profile "${entity}" now requires "${field}"`);
      }
    }

    for (const [field, definition] of Object.entries(oldProps)) {
      if (!newProps[field]) {
        need("major", `profile "${entity}" field "${field}" was removed`);
      } else if (Array.isArray(definition.enum)) {
        const kept = new Set(newProps[field].enum || []);

        if (definition.enum.some((value) => !kept.has(value))) {
          need("major", `profile "${entity}" field "${field}" lost enum values`);
        }
      }
    }

    need("minor", `profile "${entity}" schema changed`);
  }

  if (required === "none") {
    const strip = ({ version, upgrades, ...rest }) => rest;

    if (!isDeepStrictEqual(strip(previous), strip(next))) {
      need("patch", "wording, labels or help changed");
    }
  }

  return { required, reasons, errors };
}

function checkVersion(previous, next, errors) {
  if (!semver.valid(previous.version) || !semver.gt(next.version, previous.version)) {
    errors.push(`version: ${next.version} must be greater than the previous ${previous.version}`);
    return;
  }

  const change = classifyChange(previous, next);

  errors.push(...change.errors.map((error) => `version: ${error}`));

  const bump = semver.diff(previous.version, next.version);
  const bumpRank = bump === "major" ? 3 : bump === "minor" ? 2 : 1;

  if (bumpRank < RANK[change.required]) {
    errors.push(
      `version: ${previous.version} → ${next.version} is a ${bump} release, but the changes need ${change.required} (${change.reasons.filter((reason) => reason.startsWith(change.required)).join("; ")})`,
    );
  }

  if (change.required === "major" && !list(next.upgrades).some((upgrade) => upgrade.to === next.version)) {
    errors.push(`upgrades: a major release needs upgrade steps to ${next.version}`);
  }
}

// One deadline rule on its own: the checks lintManifest runs on a bundle's
// rules, for a rule a firm writes in the app (obligation-service). The same
// contract, the same condition check and the same one-year dry run, so a rule
// saved in the app is as sound as one a bundle ships.
//   services          the organization's service keys (a rule's own and any
//                     its condition names must be among them)
//   periodKind, periodStartMonth   the engagement type the dry run uses
const validateRule = ajv.compile({ $defs: contractSchema.$defs, $ref: "#/$defs/rule" });

function checkRule(rule, { services = [], periodKind = "financial_year", periodStartMonth = 4 } = {}) {
  const errors = [];

  if (!validateRule(rule)) {
    for (const error of validateRule.errors) {
      errors.push(`${error.instancePath || "rule"} ${error.message}${error.params && error.params.additionalProperty ? ` ("${error.params.additionalProperty}")` : ""}`);
    }

    return { errors };
  }

  const known = new Set(services);

  if (!known.has(rule.service)) {
    errors.push(`service "${rule.service}" is not in the catalog`);
  }

  if (rule.schedule && rule.schedule.dates && rule.frequency !== "quarterly") {
    errors.push('per-quarter dates need frequency "quarterly"');
  }

  checkCondition(rule.condition, "condition", {
    services: known,
    clientFields: new Set(),
    engagementFields: new Set(),
    identifierTypes: new Set(),
    conditionRoots: ["client", "engagement"],
  }, errors);

  if (errors.length > 0 || rule.kind !== "periodic") {
    return { errors };
  }

  // Dry run for this year, with the condition both met and not met.
  const period = schedules.periodFor(schedules.todayIn("UTC"), { periodKind, periodStartMonth });

  for (const engaged of [[rule.service], [...known]]) {
    let items;

    try {
      items = schedules.generate(rule, period, { client: {}, engagement: {}, engaged });
    } catch (error) {
      errors.push(error.message);
      continue;
    }

    const keys = new Set();

    for (const item of items) {
      if (keys.has(item.periodKey)) errors.push(`two deadlines for ${item.periodKey}`);
      keys.add(item.periodKey);

      if (!schedules.isDate(item.dueOn)) {
        errors.push(`${item.periodKey} has an invalid due date "${item.dueOn}"`);
      } else if (item.periodStart && item.dueOn < item.periodStart) {
        errors.push(`${item.periodKey} would be due (${item.dueOn}) before its period starts`);
      }
    }
  }

  return { errors: [...new Set(errors)] };
}

module.exports = { lintManifest, classifyChange, checkRule };
