const { describe, test } = require("node:test");
const assert = require("node:assert/strict");

const { evaluate, validate } = require("../src/conditions");

const data = {
  client: { name: "Acme", attributes: { constitution: "pvt_ltd", turnover: 120, blank: "  " }, people: [] },
  engagement: { attributes: { agm_on: "2026-09-28", previous_auditor: { firm: "Old & Co" } } },
  engaged: ["statutory_audit", "tax_audit"],
};

describe("evaluate", () => {
  test("reads values by dotted path, with a default for missing ones", () => {
    assert.equal(evaluate({ var: "client.attributes.constitution" }, data), "pvt_ltd");
    assert.equal(evaluate({ var: "client.attributes.nope" }, data), null);
    assert.equal(evaluate({ var: ["client.attributes.nope", "fallback"] }, data), "fallback");
  });

  test("compares strictly: a string is never equal to a number", () => {
    assert.equal(evaluate({ "==": [{ var: "client.attributes.turnover" }, 120] }, data), true);
    assert.equal(evaluate({ "==": [{ var: "client.attributes.turnover" }, "120"] }, data), false);
    assert.equal(evaluate({ "!=": ["a", "b"] }, data), true);
  });

  test("orders numbers and ISO dates, and nothing else", () => {
    assert.equal(evaluate({ ">": [{ var: "client.attributes.turnover" }, 100] }, data), true);
    assert.equal(evaluate({ "<": [{ var: "engagement.attributes.agm_on" }, "2026-10-01"] }, data), true);
    assert.equal(evaluate({ "<": [1, "2"] }, data), false);
    assert.equal(evaluate({ ">=": [null, 0] }, data), false);
  });

  test("in: membership of a list or a substring", () => {
    assert.equal(evaluate({ in: [{ var: "client.attributes.constitution" }, ["pvt_ltd", "public_ltd"]] }, data), true);
    assert.equal(evaluate({ in: ["Ac", { var: "client.name" }] }, data), true);
    assert.equal(evaluate({ in: ["x", 5] }, data), false);
  });

  test("and / or / ! combine", () => {
    assert.equal(evaluate({ and: [true, { engaged: "tax_audit" }] }, data), true);
    assert.equal(evaluate({ or: [false, { engaged: "gst_returns" }] }, data), false);
    assert.equal(evaluate({ "!": { engaged: "gst_returns" } }, data), true);
  });

  test("engaged reads the caller's list of engaged services", () => {
    assert.equal(evaluate({ engaged: "statutory_audit" }, data), true);
    assert.equal(evaluate({ engaged: "itr" }, data), false);
    assert.equal(evaluate({ engaged: "itr" }, {}), false);
  });

  test("filled: present, non-blank, non-empty", () => {
    assert.equal(evaluate({ filled: { var: "engagement.attributes.previous_auditor.firm" } }, data), true);
    assert.equal(evaluate({ filled: { var: "client.attributes.blank" } }, data), false);
    assert.equal(evaluate({ filled: { var: "client.people" } }, data), false);
    assert.equal(evaluate({ filled: { var: "client.nothing" } }, data), false);
  });

  test("throws on an operator it does not know, rather than guessing", () => {
    assert.throws(() => evaluate({ eval: "process.exit()" }, data), /Invalid condition/);
    assert.throws(() => evaluate({ "==": [1, 1], "!=": [1, 2] }, data), /Invalid condition/);
  });
});

describe("validate", () => {
  test("reports the paths and services an expression reads", () => {
    const result = validate({
      and: [{ engaged: "tax_audit" }, { "==": [{ var: "client.attributes.constitution" }, "llp"] }],
    });

    assert.deepEqual(result.errors, []);
    assert.deepEqual(result.vars, ["client.attributes.constitution"]);
    assert.deepEqual(result.services, ["tax_audit"]);
  });

  test("rejects unknown operators, wrong arity and multi-key objects", () => {
    const { errors } = validate({
      or: [{ regex: ["a", "b"] }, { "==": [1] }, { var: 5 }, { a: 1, b: 2 }, { engaged: { var: "x" } }],
    });

    assert.equal(errors.length, 5);
    assert.match(errors[0], /unknown operator "regex"/);
    assert.match(errors[1], /exactly two arguments/);
    assert.match(errors[2], /path string/);
    assert.match(errors[3], /exactly one key/);
    assert.match(errors[4], /service key/);
  });
});
