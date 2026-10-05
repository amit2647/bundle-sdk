const { test } = require("node:test");
const assert = require("node:assert/strict");

const { forClient, check } = require("../src/identifiers");
const { validate } = require("../src/profiles");

/*
 * Identifiers and profile fields as they apply to one client — shared by
 * customer-service and the client wizard, so both decide the same way.
 */

const COMPANIES = { in: [{ var: "client.attributes.constitution" }, ["pvt_ltd", "public_ltd"]] };

const IDENTIFIERS = [
  { type: "pan", label: "PAN", pattern: "^[A-Z]{5}[0-9]{4}[A-Z]$", unique: true },
  { type: "cin", label: "CIN", unique: true, shownWhen: { in: [{ var: "client.attributes.constitution" }, ["pvt_ltd", "public_ltd", "llp"]] }, requiredWhen: COMPANIES },
  { type: "din", label: "DIN", unique: false, appliesTo: "person" },
];

const company = { attributes: { constitution: "pvt_ltd" } };
const proprietor = { attributes: { constitution: "proprietorship" } };

test("which identifiers a client is asked for, and which it must give (WIZ-02)", () => {
  const rules = (client) => forClient(IDENTIFIERS, client).map((rule) => `${rule.type}:${rule.shown ? "shown" : "hidden"}:${rule.required ? "required" : "optional"}`);

  assert.deepEqual(rules(company), ["pan:shown:optional", "cin:shown:required"]);
  assert.deepEqual(rules({ attributes: { constitution: "llp" } }), ["pan:shown:optional", "cin:shown:optional"]);
  assert.deepEqual(rules(proprietor), ["pan:shown:optional", "cin:hidden:optional"]);
});

test("a company without a CIN is refused (WIZ-03)", () => {
  assert.equal(check(IDENTIFIERS, company, { pan: "aaaca1234a" }).errors.cin, "CIN is required");
});

test("values are normalised to upper case, and checked against the pattern", () => {
  const ok = check(IDENTIFIERS, company, { pan: " aaaca1234a ", cin: "u72200mh2015ptc123456" });

  assert.deepEqual(ok.errors, {});
  assert.deepEqual(ok.values, { pan: "AAACA1234A", cin: "U72200MH2015PTC123456" });
  assert.equal(check(IDENTIFIERS, proprietor, { pan: "12345" }).errors.pan, "PAN is not in the expected format");
});

test("an identifier the client does not take is dropped; an unknown one refused", () => {
  assert.deepEqual(check(IDENTIFIERS, proprietor, { cin: "U1" }).values, {});
  assert.match(check(IDENTIFIERS, proprietor, { aadhaar: "1" }).errors.aadhaar, /not an identifier/);
});

const SCHEMA = {
  type: "object",
  properties: {
    constitution: { type: "string", title: "Constitution", enum: ["trust", "huf"] },
    client_type: { type: "string", enum: ["regular", "one_time"], default: "regular" },
    trust_reg_no: { type: "string", title: "Trust registration number" },
  },
  required: ["constitution"],
  allOf: [{ if: { required: ["constitution"], properties: { constitution: { const: "trust" } } }, then: { required: ["trust_reg_no"] } }],
};

test("profile fields validate against the bundle's schema, with defaults applied", () => {
  const ok = validate(SCHEMA, { constitution: "huf" });

  assert.equal(ok.valid, true);
  assert.deepEqual(ok.value, { constitution: "huf", client_type: "regular" });
});

test("profile errors are reported per field, readably", () => {
  assert.deepEqual(validate(SCHEMA, {}).errors, { constitution: "Constitution is required" });
  assert.deepEqual(validate(SCHEMA, { constitution: "trust" }).errors, { trust_reg_no: "Trust registration number is required" });
  assert.match(validate(SCHEMA, { constitution: "llc" }).errors.constitution, /Constitution must be equal to one of/);
  assert.deepEqual(validate(SCHEMA, { constitution: "huf", turnover: 5 }).errors, { turnover: "turnover is not a field of this profile" });
});
