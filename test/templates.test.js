const { describe, test } = require("node:test");
const assert = require("node:assert/strict");

const { inspect, render, compile } = require("../src/templates");

describe("inspect", () => {
  test("accepts the whitelisted helpers and lists top-level placeholders", () => {
    const { errors, paths } = inspect(
      "{{client.name}} {{money fields.fee}} {{#if (eq client.attributes.constitution \"llp\")}}LLP{{/if}} {{#each client.people}}{{name}}{{/each}}",
    );

    assert.deepEqual(errors, []);
    assert.deepEqual(paths.sort(), ["client.attributes.constitution", "client.name", "client.people", "fields.fee"]);
  });

  test("refuses unescaped output, unknown helpers, partials and decorators (FIX-03)", () => {
    const { errors } = inspect("{{{client.notes}}} {{& client.name}} {{lookup a b}} {{> header}} {{* inline}}");

    assert.equal(errors.length, 5);
    assert.match(errors[0], /unescaped/);
    assert.match(errors[1], /unescaped/);
    assert.match(errors[2], /unknown helper "lookup"/);
    assert.match(errors[3], /partials/);
    assert.match(errors[4], /decorators/);
  });

  test("reports a template that does not parse", () => {
    assert.match(inspect("{{#if x}}never closed").errors[0], /does not parse/);
  });
});

describe("render", () => {
  test("escapes everything a person typed", () => {
    const html = render("<p>{{client.name}}</p>", { client: { name: "<script>alert(1)</script> & Co" } });

    assert.equal(html, "<p>&lt;script&gt;alert(1)&lt;/script&gt; &amp; Co</p>");
  });

  test("a missing value shows as a highlighted [Label], never a blank (DOC-12)", () => {
    const html = render("Fee: {{fields.fee}}; Ref: {{fields.reference}}", { fields: { reference: "R-1" } }, {
      labels: { "fields.fee": "Audit fee" },
    });

    assert.equal(html, 'Fee: <mark class="doc-placeholder">[Audit fee]</mark>; Ref: R-1');
  });

  test("an unlabelled missing value falls back to its field name", () => {
    assert.match(render("{{client.attributes.trust_reg_no}}", {}), /\[trust reg no\]/);
  });

  test("formats dates (en-IN) and money in the firm's currency", () => {
    const html = render("{{date engagement.appointment_on}} {{money fields.fee}}", {
      engagement: { appointment_on: "2026-04-05" },
      fields: { fee: 125000 },
      firm: { currency: "INR" },
    });

    assert.equal(html, "5 April 2026 ₹1,25,000.00");
  });

  test("financial-year edges come from the period label", () => {
    const html = render("{{date (fyStart engagement.period_label)}} – {{date (fyEnd engagement.period_label)}}", {
      engagement: { period_label: "2025-26" },
    });

    assert.equal(html, "1 April 2025 – 31 March 2026");
  });

  test("engaged and inList drive conditional paragraphs", () => {
    const body = "{{#if (engaged \"tax_audit\")}}TA{{else}}none{{/if}}/{{#if (inList client.attributes.constitution \"pvt_ltd\" \"public_ltd\")}}company{{/if}}";

    assert.equal(render(body, { engaged: ["tax_audit"], client: { attributes: { constitution: "pvt_ltd" } } }), "TA/company");
    assert.equal(render(body, { engaged: [], client: { attributes: { constitution: "llp" } } }), "none/");
  });

  test("loops over people, with missing names visible", () => {
    const html = render("{{#each client.people}}[{{name}}]{{/each}}", { client: { people: [{ name: "A" }, { name: "" }] } });

    assert.equal(html, '[A][<mark class="doc-placeholder">[name]</mark>]');
  });

  test("compile refuses what inspect refuses, even if lint was skipped", () => {
    assert.throws(() => compile("{{{client.notes}}}"), /Invalid template/);
  });

  test("prototype properties are not reachable", () => {
    assert.equal(render("{{client.constructor}}", { client: {} }).includes("function"), false);
  });
});
