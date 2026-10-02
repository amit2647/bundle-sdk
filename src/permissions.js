/*
 * The permission codes the platform itself defines, so bundle-lint can check
 * a bundle's role templates and help docs without a database.
 *
 * CORE mirrors migrations/sql/001_identity.sql; CAPABILITY mirrors
 * migrations/sql/014_bundle_hooks.sql. Keep them in step: a code missing here
 * makes lint reject a valid role, and a code missing there makes an install
 * fail when it grants a permission that does not exist.
 */

const CORE = [
  "leads.read", "leads.create", "leads.update", "leads.delete", "leads.assign",
  "customers.read", "customers.create", "customers.update", "customers.delete", "customers.assign",
  "services.read", "services.create", "services.update", "services.delete",
  "users.read", "users.create", "users.update", "users.delete",
  "organization.read", "organization.update",
  "reports.read", "reports.all",
  "system.billing", "system.settings", "system.integrations", "system.custom_fields",
  "communications.read", "communications.create", "communications.update", "communications.delete",
  "email.send",
  "email.templates.read", "email.templates.create", "email.templates.update", "email.templates.delete",
  "email.automations.read", "email.automations.create", "email.automations.update", "email.automations.delete",
];

const CAPABILITY = [
  "bundles.manage",
  "customers.purge",
  "profiles.read", "profiles.update", "profiles.lock",
  "engagements.read", "engagements.update",
  "fees.read", "fees.update",
  "obligations.read", "obligations.update", "obligations.rules",
  "documents.read", "documents.generate",
  "vault.read", "vault.reveal", "vault.update",
  "files.read", "files.upload", "files.delete",
];

// Never grantable through a bundle's role template: installing a bundle must
// not be a way to mint an administrator.
const NEVER_IN_ROLE_TEMPLATES = (code) => code.startsWith("system.") || code === "bundles.manage";

// A bundle namespace may not shadow a platform permission group.
const RESERVED_NAMESPACES = [
  ...new Set([...CORE, ...CAPABILITY].map((code) => code.split(".")[0])),
];

module.exports = { CORE, CAPABILITY, NEVER_IN_ROLE_TEMPLATES, RESERVED_NAMESPACES };
