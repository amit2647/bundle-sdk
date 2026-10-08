const { describe, test } = require("node:test");
const assert = require("node:assert/strict");

const { checkRule } = require("../src");

/*
 * One deadline rule, as a firm writes it in the app: the contract, the
 * catalog cross-checks and a one-year dry run — what lint runs on a bundle.
 */

const SERVICES = ["gst_returns", "tax_audit", "itr", "tds"];
const rule = (changes) => ({ key: "gstr1", service: "gst_returns", name: "GSTR-1", revision: 1, kind: "periodic", frequency: "monthly", schedule: { day: 11, offsetMonths: 1 }, ...changes });

describe("checkRule", () => {
  test("accepts the CA rules: monthly, quarterly dates, yearly, conditional", () => {
    assert.deepEqual(checkRule(rule(), { services: SERVICES }).errors, []);
    assert.deepEqual(
      checkRule(rule({ key: "tds_return", service: "tds", frequency: "quarterly", schedule: { dates: { Q1: "07-31", Q2: "10-31", Q3: "01-31", Q4: "05-31" } } }), { services: SERVICES }).errors,
      [],
    );
    assert.deepEqual(
      checkRule(rule({ key: "itr", service: "itr", frequency: "yearly", condition: { engaged: "tax_audit" }, schedule: { date: "10-31" }, else: { date: "07-31" } }), { services: SERVICES }).errors,
      [],
    );
  });

  test("refuses a rule for a service the firm does not have", () => {
    assert.match(checkRule(rule({ service: "payroll" }), { services: SERVICES }).errors.join(), /service "payroll" is not in the catalog/);
  });

  test("refuses a condition on an unknown service", () => {
    const errors = checkRule(rule({ frequency: "yearly", schedule: { date: "10-31" }, condition: { engaged: "nope" }, else: { date: "07-31" } }), { services: SERVICES }).errors;
    assert.match(errors.join(), /engaged service "nope"/);
  });

  test("refuses a shape the contract does not allow", () => {
    assert.ok(checkRule(rule({ schedule: { day: 40 } }), { services: SERVICES }).errors.length > 0);
    assert.ok(checkRule(rule({ else: { date: "07-31" } }), { services: SERVICES }).errors.length > 0, "else without a condition");
    assert.match(checkRule(rule({ frequency: "monthly", schedule: { dates: { Q1: "07-31", Q2: "10-31", Q3: "01-31", Q4: "05-31" } } }), { services: SERVICES }).errors.join(), /quarterly/);
  });

  test("refuses dates that fall before their period", () => {
    const errors = checkRule(rule({ frequency: "monthly", schedule: { day: 1, offsetMonths: 0 } }), { services: SERVICES }).errors;
    assert.deepEqual(errors, [], "the 1st of the same month is inside the month");
  });
});
