const { describe, test, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const yaml = require("js-yaml");

const { lintBundle, loadBundle, classifyChange } = require("../src");

/*
 * The fixture bundle must lint clean; every test below breaks one thing in a
 * copy of it and expects lint to name exactly that problem.
 */

const FIXTURE = path.join(__dirname, "fixtures", "valid-bundle");
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "bundle-sdk-"));
let copies = 0;

after(() => fs.rmSync(scratch, { recursive: true, force: true }));

function variant(change) {
  const dir = path.join(scratch, `copy-${(copies += 1)}`);

  fs.cpSync(FIXTURE, dir, { recursive: true });

  const edit = {
    dir,
    yaml(file, mutate) {
      const full = path.join(dir, file);
      const data = yaml.load(fs.readFileSync(full, "utf8"), { schema: yaml.CORE_SCHEMA });
      fs.writeFileSync(full, yaml.dump(mutate(data) ?? data));
    },
    json(file, mutate) {
      const full = path.join(dir, file);
      const data = JSON.parse(fs.readFileSync(full, "utf8"));
      fs.writeFileSync(full, JSON.stringify(mutate(data) ?? data));
    },
    write(file, text) {
      fs.writeFileSync(path.join(dir, file), text);
    },
    remove(file) {
      fs.rmSync(path.join(dir, file), { recursive: true, force: true });
    },
  };

  change(edit);

  return dir;
}

function errorsOf(change) {
  return lintBundle(variant(change)).errors;
}

function assertError(change, pattern) {
  const errors = errorsOf(change);

  assert.ok(
    errors.some((error) => pattern.test(error)),
    `expected an error matching ${pattern}, got:\n  ${errors.join("\n  ") || "(none)"}`,
  );
}

describe("the fixture bundle", () => {
  test("lints clean, with no warnings", () => {
    const result = lintBundle(FIXTURE);

    assert.deepEqual(result.errors, []);
    assert.deepEqual(result.warnings, []);
  });

  test("loads into one resolved manifest", () => {
    const { manifest, fixtures } = loadBundle(FIXTURE);

    assert.equal(manifest.catalog.services.length, 5);
    assert.equal(manifest.obligations.length, 6);
    assert.equal(manifest.documents[0].key, "engagement_letter");
    assert.match(manifest.documents[0].body, /client\.name/);
    assert.equal(manifest.profiles.client.schema.type, "object");
    assert.equal(manifest.help[0].permission, "profiles.read");
    assert.equal(fixtures.length, 2);
  });
});

describe("contract shape", () => {
  test("a missing required field", () => {
    assertError((b) => b.yaml("bundle.yaml", (m) => { delete m.namespace; }), /contract: \/ must have required property 'namespace'/);
  });

  test("an unknown top-level section", () => {
    assertError((b) => b.yaml("bundle.yaml", (m) => { m.plugins = ["x"]; }), /additional properties.*"plugins"/);
  });

  test("a periodic rule without a schedule", () => {
    assertError((b) => b.yaml("rules/gst.yaml", (f) => { delete f.rules[0].schedule; }), /contract: \/obligations\/\d+ must have required property 'schedule'/);
  });

  test("a portal with more than four fields", () => {
    assertError(
      (b) => b.yaml("portals.yaml", (f) => {
        f.portals[0].fields = ["a", "b", "c", "d", "e"].map((key) => ({ key: `f_${key}`, label: key, secret: false }));
      }),
      /must NOT have more than 4 items/,
    );
  });

  test("a bad key", () => {
    assertError((b) => b.yaml("catalog.yaml", (c) => { c.services[0].key = "Statutory Audit"; }), /contract: \/catalog\/services\/0\/key must match pattern/);
  });
});

describe("references", () => {
  test("a file outside the bundle", () => {
    assertError((b) => b.yaml("bundle.yaml", (m) => { m.catalog = "../../catalog.yaml"; }), /points outside the bundle/);
  });

  test("a missing file", () => {
    assertError((b) => b.remove("portals.yaml"), /"portals.yaml" does not exist/);
  });

  test("a rule for a service not in the catalog", () => {
    assertError((b) => b.yaml("rules/gst.yaml", (f) => { f.rules[0].service = "gst_annual"; }), /obligations.gstr1: service "gst_annual" is not in the catalog/);
  });

  test("a package with an unknown service", () => {
    assertError((b) => b.yaml("catalog.yaml", (c) => { c.packages[0].services.push("payroll"); }), /packages.company_annual: service "payroll"/);
  });

  test("a duplicate key", () => {
    assertError((b) => b.yaml("rules/tds.yaml", (f) => { f.rules[0].key = "gstr1"; }), /obligations: "gstr1" is declared more than once/);
  });

  test("two services with the same name (the database's unique key)", () => {
    assertError((b) => b.yaml("catalog.yaml", (c) => { c.services[1].name = c.services[0].name; }), /name "Statutory Audit" is used twice/);
  });

  test("using a capability without requiring it", () => {
    assertError((b) => b.yaml("bundle.yaml", (m) => { m.requires.capabilities = ["engagements", "obligations", "documents"]; }), /uses vault but does not list it/);
  });
});

describe("conditions", () => {
  test("an unknown operator", () => {
    assertError((b) => b.yaml("rules/income-tax.yaml", (f) => { f.rules[0].condition = { regex: ["a", "b"] }; }), /unknown operator "regex"/);
  });

  test("an attribute the client schema does not have", () => {
    assertError(
      (b) => b.yaml("documents/engagement-letter/document.yaml", (d) => { d.enabledWhen = { filled: { var: "client.attributes.turnover" } }; }),
      /"turnover" is not in the client profile schema/,
    );
  });

  test("an engaged service not in the catalog", () => {
    assertError((b) => b.yaml("portals.yaml", (f) => { f.portals[0].enabledWhen = { engaged: "gst" }; }), /engaged service "gst" is not in the catalog/);
  });

  test("relativeTo an engagement field that does not exist", () => {
    assertError((b) => b.yaml("rules/income-tax.yaml", (f) => { f.rules[2].relativeTo = "engagement.attributes.lease_end"; }), /"lease_end" is not in any engagement profile schema/);
  });
});

describe("identifier conditions", () => {
  test("an identifier condition reading an unknown client field", () => {
    assertError(
      (b) => b.yaml("bundle.yaml", (m) => { m.identifiers[1].requiredWhen = { filled: { var: "client.attributes.turnover" } }; }),
      /identifiers.cin.requiredWhen: "client.attributes.turnover" — "turnover" is not in the client profile schema/,
    );
  });

  test("a person identifier cannot be required on the client", () => {
    assertError(
      (b) => b.yaml("bundle.yaml", (m) => { m.identifiers.push({ type: "din", label: "DIN", unique: false, appliesTo: "person", requiredWhen: true }); }),
      /requiredWhen applies to client identifiers only/,
    );
  });
});

describe("field schemas and forms", () => {
  test("a custom keyword", () => {
    assertError((b) => b.json("schemas/client.json", (s) => { s.properties.constitution.widget = "select"; }), /keyword "widget" is not allowed/);
  });

  test("a remote $ref", () => {
    assertError((b) => b.json("schemas/client.json", (s) => { s.properties.extra = { $ref: "https://example.com/schema.json" }; }), /only local \$refs/);
  });

  test("an if that does not require what it tests is a warning", () => {
    const result = lintBundle(variant((b) => b.json("schemas/client.json", (s) => { delete s.allOf[0].if.required; })));

    assert.deepEqual(result.errors, []);
    assert.match(result.warnings[0], /tests constitution without requiring it/);
  });

  test("a ui entry for a field that does not exist", () => {
    assertError((b) => b.json("ui/client.ui.json", (u) => { u.turnover = { "ui:widget": "text" }; }), /profiles.client.ui: "turnover" is not a field/);
  });

  test("a person profile is accepted and its schema checked", () => {
    const ok = lintBundle(variant((b) => b.yaml("bundle.yaml", (m) => {
      m.profiles.person = { version: 1, schema: { type: "object", properties: { din: { type: "string" } } } };
    })));

    assert.deepEqual(ok.errors, []);
    assertError(
      (b) => b.yaml("bundle.yaml", (m) => { m.profiles.person = { version: 1, schema: { type: "object", properties: { din: { type: "string", mask: true } } } }; }),
      /profiles.person.schema.properties.din: keyword "mask" is not allowed/,
    );
  });

  test("an engagement profile for an undeclared type", () => {
    assertError((b) => b.yaml("bundle.yaml", (m) => { m.profiles.engagement.monthly = m.profiles.engagement.annual; }), /there is no engagement type "monthly"/);
  });
});

describe("documents", () => {
  test("unescaped output (FIX-03)", () => {
    assertError((b) => b.write("documents/engagement-letter/template.hbs", "<p>{{{client.notes}}}</p>"), /unescaped output is not allowed/);
  });

  test("a field the document does not declare", () => {
    assertError((b) => b.write("documents/engagement-letter/template.hbs", "{{fields.discount}}"), /"fields.discount" is not a field of this document/);
  });

  test("active markup in a template", () => {
    assertError((b) => b.write("documents/engagement-letter/template.hbs", "<p>{{client.name}}</p><script>alert(1)</script>"), /<script> is not allowed/);
  });

  test("a pre-filled field reading another field, or a client field that does not exist", () => {
    assertError((b) => b.write("documents/engagement-letter/fields.ui.json", JSON.stringify({ fee: { "ui:prefill": "fields.reference" } })), /ui:prefill "fields.reference" must read one of/);
    assertError((b) => b.write("documents/engagement-letter/fields.ui.json", JSON.stringify({ fee: { "ui:prefill": "client.turnover" } })), /clients have no field "turnover"/);
  });

  test("a pre-fill from the period's fees lints clean", () => {
    assert.deepEqual(errorsOf((b) => b.write("documents/engagement-letter/fields.ui.json", JSON.stringify({ fee: { "ui:prefill": "engagement.fee_total" } }))), []);
  });

  test("a binding root templates cannot read", () => {
    assertError((b) => b.write("documents/engagement-letter/template.hbs", "{{process.env.SECRET}}"), /templates can read/);
  });
});

describe("permissions, roles, vault, email", () => {
  test("a role template granting system.*", () => {
    assertError((b) => b.yaml("roles.yaml", (f) => { f.roles[0].permissions.push("system.settings"); }), /"system.settings" cannot be granted by a bundle role template/);
  });

  test("a role template granting bundles.manage", () => {
    assertError((b) => b.yaml("roles.yaml", (f) => { f.roles[0].permissions.push("bundles.manage"); }), /"bundles.manage" cannot be granted/);
  });

  test("a role with a permission that does not exist", () => {
    assertError((b) => b.yaml("roles.yaml", (f) => { f.roles[1].permissions.push("files.share"); }), /permission "files.share" does not exist/);
  });

  test("a bundle permission outside its namespace", () => {
    assertError((b) => b.yaml("bundle.yaml", (m) => { m.permissions[0].code = "ca.udin.manage"; }), /must start with the bundle namespace "tp."/);
  });

  test("a namespace that shadows a platform group", () => {
    assertError((b) => b.yaml("bundle.yaml", (m) => { m.namespace = "vault"; m.permissions = []; }), /"vault" is a platform permission group/);
  });

  test("secrets with no consent document required", () => {
    assertError((b) => b.yaml("bundle.yaml", (m) => { delete m.vault.consentFileCategory; }), /consentFileCategory .* is required/);
  });

  test("an email placeholder the event does not carry", () => {
    assertError((b) => b.yaml("email/obligation-due-soon.yaml", (e) => { e.body += " {{lead.name}}"; }), /"\{\{lead.name\}\}" is not in the obligation.due_soon event/);
  });

  test("the reserved Converted pipeline status", () => {
    assertError((b) => b.yaml("bundle.yaml", (m) => { m.pipeline.push({ key: "won", label: "Won", status: "Converted" }); }), /"Converted" is reserved/);
  });

  test("a help doc with an unknown permission", () => {
    assertError((b) => b.write("knowledge/clients.md", "---\ntitle: Clients\npermission: clients.read\n---\nBody"), /permission "clients.read" does not exist/);
  });
});

describe("dry run", () => {
  test("no fixtures is a warning, not an error", () => {
    const result = lintBundle(variant((b) => b.remove("fixtures")));

    assert.deepEqual(result.errors, []);
    assert.match(result.warnings[0], /dry run was skipped/);
  });

  test("a fixture with a bad period label", () => {
    assertError((b) => b.json("fixtures/clients/company.json", (c) => { c.engagement.period = "2025-27"; }), /Invalid period label/);
  });
});

describe("versioning", () => {
  const base = () => loadBundle(FIXTURE).manifest;
  const clone = (value) => JSON.parse(JSON.stringify(value));

  test("wording only is a patch", () => {
    const next = clone(base());
    next.vocabulary.client.one = "Customer";

    assert.equal(classifyChange(base(), next).required, "patch");
  });

  test("an added service is minor", () => {
    const next = clone(base());
    next.catalog.services.push({ key: "payroll", name: "Payroll", group: "compliance" });

    assert.equal(classifyChange(base(), next).required, "minor");
  });

  test("a removed rule is major", () => {
    const next = clone(base());
    next.obligations.pop();

    assert.equal(classifyChange(base(), next).required, "major");
  });

  test("a newly required client field is major", () => {
    const next = clone(base());
    next.profiles.client.version = 2;
    next.profiles.client.schema.required.push("trust_reg_no");

    assert.equal(classifyChange(base(), next).required, "major");
  });

  test("a narrowed enum is major", () => {
    const next = clone(base());
    next.profiles.client.version = 2;
    next.profiles.client.schema.properties.constitution.enum.pop();

    assert.equal(classifyChange(base(), next).required, "major");
  });

  test("a changed rule without a new revision is an error", () => {
    const next = clone(base());
    next.obligations[0].schedule.day = 12;

    assert.match(classifyChange(base(), next).errors[0], /without a new revision/);
  });

  test("a changed schema without a new profile version is an error", () => {
    const next = clone(base());
    next.profiles.client.schema.properties.extra = { type: "string" };

    assert.match(classifyChange(base(), next).errors[0], /without a new version/);
  });

  test("lint refuses a patch release that removes something, and a major with no upgrade steps", () => {
    const previous = variant(() => {});

    const patch = lintBundle(
      variant((b) => b.yaml("bundle.yaml", (m) => { m.version = "1.0.1"; m.pipeline.pop(); })),
      { previousDir: previous },
    );

    assert.ok(patch.errors.some((error) => /is a patch release, but the changes need major/.test(error)), patch.errors.join("\n"));
    assert.ok(patch.errors.some((error) => /a major release needs upgrade steps/.test(error)), patch.errors.join("\n"));

    const major = lintBundle(
      variant((b) => b.yaml("bundle.yaml", (m) => {
        m.version = "2.0.0";
        m.pipeline.pop();
        m.upgrades = [{ from: "1.0.0", to: "2.0.0", steps: [{ op: "retireItem", section: "pipeline", key: "discussion" }] }];
      })),
      { previousDir: previous },
    );

    assert.deepEqual(major.errors, []);
  });

  test("the version must go up", () => {
    const previous = variant(() => {});
    const same = lintBundle(variant(() => {}), { previousDir: previous });

    assert.match(same.errors[0], /must be greater than the previous 1.0.0/);
  });
});
