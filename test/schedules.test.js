const { describe, test } = require("node:test");
const assert = require("node:assert/strict");

const s = require("../src/schedules");

const FY = s.periodFromLabel("2025-26", { periodStartMonth: 4 });
const dues = (rule, data = {}) => s.generate(rule, FY, data).map((item) => `${item.periodKey}=${item.dueOn}`);

describe("periods", () => {
  test("an April financial year", () => {
    assert.deepEqual(
      { label: FY.label, start: FY.start, end: FY.end },
      { label: "2025-26", start: "2025-04-01", end: "2026-03-31" },
    );
    assert.equal(s.periodFor("2026-03-31", { periodStartMonth: 4 }).label, "2025-26");
    assert.equal(s.periodFor("2026-04-01", { periodStartMonth: 4 }).label, "2026-27");
  });

  test("a calendar year is labelled by its year", () => {
    const year = s.periodFor("2026-07-15", { periodKind: "calendar_year" });

    assert.deepEqual([year.label, year.start, year.end], ["2026", "2026-01-01", "2026-12-31"]);
  });

  test("labels that do not match the period kind are refused", () => {
    assert.throws(() => s.periodFromLabel("2025-27", { periodStartMonth: 4 }), /Invalid period label/);
    assert.throws(() => s.periodFromLabel("FY25", { periodStartMonth: 4 }), /Invalid period label/);
  });

  test("the period list is generated around today, never hard-coded (FIX-21)", () => {
    const labels = s.listPeriods("2031-05-10", { periodStartMonth: 4 }).map((period) => period.label);

    assert.deepEqual(labels, ["2028-29", "2029-30", "2030-31", "2031-32", "2032-33"]);
  });

  test("the century boundary keeps two digits", () => {
    assert.equal(s.periodFromLabel("2099-00", { periodStartMonth: 4 }).end, "2100-03-31");
  });
});

describe("today in the organization's time zone (FIX-08)", () => {
  // 01:30 on 1 April in India is still 31 March in UTC.
  const instant = new Date("2026-03-31T20:00:00Z");

  test("is the local date, not the UTC one", () => {
    assert.equal(s.todayIn("Asia/Kolkata", instant), "2026-04-01");
    assert.equal(s.todayIn("UTC", instant), "2026-03-31");
  });
});

describe("due dates — the CA table from the Feature Task List", () => {
  test("GSTR-1 on the 11th and GSTR-3B on the 20th of the next month — never a day early", () => {
    const gstr1 = dues({ key: "g1", name: "GSTR-1", kind: "periodic", frequency: "monthly", schedule: { day: 11, offsetMonths: 1 } });

    assert.equal(gstr1.length, 12);
    assert.equal(gstr1[0], "2025-04=2025-05-11");
    assert.equal(gstr1[11], "2026-03=2026-04-11");

    const gstr3b = dues({ key: "g3", name: "GSTR-3B", kind: "periodic", frequency: "monthly", schedule: { day: 20, offsetMonths: 1 } });

    assert.equal(gstr3b[9], "2026-01=2026-02-20");
  });

  test("TDS quarterly returns: 31 Jul, 31 Oct, 31 Jan, 31 May", () => {
    assert.deepEqual(
      dues({
        key: "tds", name: "TDS", kind: "periodic", frequency: "quarterly",
        schedule: { dates: { Q1: "07-31", Q2: "10-31", Q3: "01-31", Q4: "05-31" } },
      }),
      ["2025-26:Q1=2025-07-31", "2025-26:Q2=2025-10-31", "2025-26:Q3=2026-01-31", "2025-26:Q4=2026-05-31"],
    );
  });

  test("Internal audit: the 15th after each quarter", () => {
    assert.deepEqual(
      dues({ key: "ia", name: "Internal audit", kind: "periodic", frequency: "quarterly", schedule: { day: 15, offsetMonths: 1 } }),
      ["2025-26:Q1=2025-07-15", "2025-26:Q2=2025-10-15", "2025-26:Q3=2026-01-15", "2025-26:Q4=2026-04-15"],
    );
  });

  test("Yearly after the FY: statutory audit 30 Sep, GSTR-9 31 Dec, AOC-4 29 Oct", () => {
    const yearly = (date) => dues({ key: "y", name: "Y", kind: "periodic", frequency: "yearly", schedule: { date } });

    assert.deepEqual(yearly("09-30"), ["2025-26=2026-09-30"]);
    assert.deepEqual(yearly("12-31"), ["2025-26=2026-12-31"]);
    assert.deepEqual(yearly("10-29"), ["2025-26=2026-10-29"]);
  });

  test("ITR: 31 Oct when a tax audit is engaged, otherwise 31 Jul", () => {
    const itr = {
      key: "itr", name: "ITR", kind: "periodic", frequency: "yearly",
      condition: { engaged: "tax_audit" }, schedule: { date: "10-31" }, else: { date: "07-31" },
    };

    assert.deepEqual(dues(itr, { engaged: ["tax_audit", "itr"] }), ["2025-26=2026-10-31"]);
    assert.deepEqual(dues(itr, { engaged: ["itr"] }), ["2025-26=2026-07-31"]);
  });

  test("a condition with no else generates nothing when false", () => {
    const rule = { key: "c", name: "C", kind: "periodic", frequency: "yearly", condition: false, schedule: { date: "06-30" } };

    assert.deepEqual(dues(rule), []);
  });

  test("a day past the month's end is clamped", () => {
    const rule = { key: "e", name: "E", kind: "periodic", frequency: "monthly", schedule: { day: 31, offsetMonths: 1 } };
    const items = dues(rule);

    assert.equal(items[9], "2026-01=2026-02-28");
    assert.equal(items[0], "2025-04=2025-05-31");
  });

  test("relative to a date on the engagement", () => {
    const rule = { key: "r", name: "Lease renewal", kind: "relative", relativeTo: "engagement.attributes.lease_end", offsetDays: -60 };

    assert.deepEqual(dues(rule, { engagement: { attributes: { lease_end: "2026-03-01" } } }), ["2025-26=2025-12-31"]);
    assert.deepEqual(dues(rule, { engagement: { attributes: {} } }), []);
    assert.deepEqual(dues(rule, { engagement: { attributes: { lease_end: "not a date" } } }), []);
  });

  test("manual rules generate nothing", () => {
    assert.deepEqual(dues({ key: "m", name: "Hearing", kind: "manual" }), []);
  });

  test("titles name the sub-period", () => {
    const [first] = s.generate({ key: "g1", name: "GSTR-1", kind: "periodic", frequency: "monthly", schedule: { day: 11, offsetMonths: 1 } }, FY);

    assert.equal(first.title, "GSTR-1 · Apr 2025");
  });

  test("generation is deterministic", () => {
    const rule = { key: "tds", name: "TDS", kind: "periodic", frequency: "quarterly", schedule: { day: 7, offsetMonths: 1 } };

    assert.deepEqual(s.generate(rule, FY), s.generate(rule, FY));
  });
});

describe("date helpers", () => {
  test("parseDate rejects impossible dates", () => {
    assert.equal(s.parseDate("2026-02-29"), null);
    assert.deepEqual(s.parseDate("2028-02-29"), { year: 2028, month: 2, day: 29 });
    assert.equal(s.parseDate("2026-13-01"), null);
    assert.equal(s.parseDate("26-01-01"), null);
  });

  test("addDays crosses months and years in calendar days", () => {
    assert.equal(s.addDays("2025-12-31", 1), "2026-01-01");
    assert.equal(s.addDays("2026-03-01", -1), "2026-02-28");
  });
});
