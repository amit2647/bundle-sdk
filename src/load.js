const fs = require("fs");
const path = require("path");
const yaml = require("js-yaml");

/*
 * Reads a bundle repository into one resolved manifest.
 *
 * bundle.yaml may write a section inline or name a file or directory for it;
 * this reads every reference so the result is a single JSON object — the
 * form bundle-service stores per version and hands to the services. Problems
 * are collected rather than thrown, so lint can report them all at once.
 *
 * References may not leave the bundle's directory.
 */

const MANIFEST = "bundle.yaml";

// Core schema: dates stay strings ("2026-03-31"), as JSON would have them.
const parseYaml = (text) => yaml.load(text, { schema: yaml.CORE_SCHEMA });

function parseFrontMatter(text) {
  const match = text.match(/^---\n([\s\S]*?)\n---\n?/);

  if (!match) {
    return { meta: {}, body: text };
  }

  const meta = {};

  for (const line of match[1].split("\n")) {
    const [key, ...rest] = line.split(":");

    if (key && rest.length > 0) {
      meta[key.trim()] = rest.join(":").trim();
    }
  }

  return { meta, body: text.slice(match[0].length) };
}

function createReader(root, errors) {
  const base = path.resolve(root);

  function resolve(reference, where) {
    const full = path.resolve(base, reference);

    if (full !== base && !full.startsWith(base + path.sep)) {
      errors.push(`${where}: "${reference}" points outside the bundle`);
      return null;
    }

    if (!fs.existsSync(full)) {
      errors.push(`${where}: "${reference}" does not exist`);
      return null;
    }

    return full;
  }

  function readText(reference, where) {
    const full = resolve(reference, where);

    return full ? fs.readFileSync(full, "utf8") : null;
  }

  function readData(reference, where) {
    const text = readText(reference, where);

    if (text === null) {
      return undefined;
    }

    try {
      return reference.endsWith(".json") ? JSON.parse(text) : parseYaml(text);
    } catch (error) {
      errors.push(`${reference}: does not parse: ${error.message.split("\n")[0]}`);
      return undefined;
    }
  }

  function listDir(reference, where, extension) {
    const full = resolve(reference, where);

    if (!full) {
      return [];
    }

    if (!fs.statSync(full).isDirectory()) {
      errors.push(`${where}: "${reference}" should be a directory`);
      return [];
    }

    return fs
      .readdirSync(full)
      .filter((name) => !name.startsWith("."))
      .filter((name) => !extension || name.endsWith(extension))
      .sort()
      .map((name) => path.posix.join(reference.replace(/\/$/, ""), name));
  }

  return { resolve, readText, readData, listDir };
}

// A section file may hold the list itself, or an object wrapping it.
function asList(value, wrapper) {
  if (Array.isArray(value)) {
    return value;
  }

  if (value && Array.isArray(value[wrapper])) {
    return value[wrapper];
  }

  return value === undefined ? undefined : value;
}

function loadBundle(root) {
  const errors = [];
  const read = createReader(root, errors);

  const source = read.readData(MANIFEST, MANIFEST);

  if (!source || typeof source !== "object") {
    if (errors.length === 0) {
      errors.push(`${MANIFEST}: is empty or not a mapping`);
    }

    return { manifest: null, fixtures: [], errors };
  }

  const manifest = { ...source };

  // Inline, or a file holding it.
  const section = (name, wrapper) => {
    if (typeof manifest[name] === "string") {
      manifest[name] = asList(read.readData(manifest[name], name), wrapper);
    }
  };

  for (const [name, wrapper] of [
    ["identifiers", "identifiers"],
    ["peopleRoles", "peopleRoles"],
    ["pipeline", "pipeline"],
    ["engagementTypes", "engagementTypes"],
    ["permissions", "permissions"],
    ["roles", "roles"],
    ["dashboard", "cards"],
    ["upgrades", "upgrades"],
    ["catalog", null],
  ]) {
    section(name, wrapper);
  }

  // Profiles: schema and ui may be file references.
  const loadProfile = (profile, where) => {
    if (!profile || typeof profile !== "object") {
      return profile;
    }

    const loaded = { ...profile };

    for (const part of ["schema", "ui"]) {
      if (typeof loaded[part] === "string") {
        loaded[part] = read.readData(loaded[part], `${where}.${part}`);
      }
    }

    return loaded;
  };

  if (manifest.profiles && typeof manifest.profiles === "object") {
    const profiles = {};

    for (const [entity, profile] of Object.entries(manifest.profiles)) {
      if (entity === "engagement" && profile && typeof profile === "object") {
        profiles.engagement = Object.fromEntries(
          Object.entries(profile).map(([type, item]) => [
            type,
            loadProfile(item, `profiles.engagement.${type}`),
          ]),
        );
      } else {
        profiles[entity] = loadProfile(profile, `profiles.${entity}`);
      }
    }

    manifest.profiles = profiles;
  }

  // Obligations: a directory of rule files, a single file, or inline.
  if (typeof manifest.obligations === "string") {
    const reference = manifest.obligations;
    const full = read.resolve(reference, "obligations");

    if (full && fs.statSync(full).isDirectory()) {
      manifest.obligations = read
        .listDir(reference, "obligations", ".yaml")
        .flatMap((file) => asList(read.readData(file, "obligations"), "rules") || []);
    } else if (full) {
      manifest.obligations = asList(read.readData(reference, "obligations"), "rules");
    }
  }

  // Documents: one directory per template.
  if (typeof manifest.documents === "string") {
    manifest.documents = read.listDir(manifest.documents, "documents").map((dir) => {
      const where = `documents/${path.basename(dir)}`;
      const meta = read.readData(`${dir}/document.yaml`, where) || {};
      const document = { ...meta };

      document.body = read.readText(`${dir}/template.hbs`, where) ?? undefined;
      document.fields = read.readData(`${dir}/fields.json`, where);

      if (fs.existsSync(path.join(root, dir, "fields.ui.json"))) {
        document.ui = read.readData(`${dir}/fields.ui.json`, where);
      }

      return document;
    });
  }

  if (manifest.vault && typeof manifest.vault.portals === "string") {
    manifest.vault = {
      ...manifest.vault,
      portals: asList(read.readData(manifest.vault.portals, "vault.portals"), "portals"),
    };
  }

  // Email: one file per template-and-automation pair.
  if (typeof manifest.email === "string") {
    manifest.email = read
      .listDir(manifest.email, "email", ".yaml")
      .map((file) => read.readData(file, "email"))
      .filter(Boolean);
  }

  // Help: Markdown with title/permission front-matter, as assistant-service reads it.
  if (typeof manifest.help === "string") {
    manifest.help = read.listDir(manifest.help, "help", ".md").map((file) => {
      const { meta, body } = parseFrontMatter(read.readText(file, "help") || "");

      return { path: file, title: meta.title, permission: meta.permission, body };
    });
  }

  // Sample clients for lint's dry run; not part of the manifest.
  const fixtures = fs.existsSync(path.join(root, "fixtures", "clients"))
    ? read
        .listDir("fixtures/clients", "fixtures", ".json")
        .map((file) => ({ file, data: read.readData(file, "fixtures") }))
        .filter((fixture) => fixture.data)
    : [];

  return { manifest, fixtures, errors };
}

module.exports = { loadBundle, parseFrontMatter };
