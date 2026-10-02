const { evaluate, readPath, isFilled } = require("./conditions");

/*
 * Periods and due dates, as calendar dates.
 *
 * Everything here works on "YYYY-MM-DD" strings and plain year/month/day
 * numbers. Nothing builds a local-time Date: the portal this replaces built
 * due dates with new Date(y, m, d).toISOString(), which in IST lands on the
 * previous day (FIX-08). A due date is a date, not an instant.
 *
 * A financial year starting in April is labelled "2025-26" and runs
 * 2025-04-01 to 2026-03-31; one starting in January is labelled "2025".
 * Inside a period, months are keyed "2025-04" and quarters "2025-26:Q1".
 */

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const pad = (value, size = 2) => String(value).padStart(size, "0");

function toDate(year, month, day) {
  return `${pad(year, 4)}-${pad(month)}-${pad(day)}`;
}

function parseDate(text) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(text));

  if (!match) {
    return null;
  }

  const [year, month, day] = match.slice(1).map(Number);

  if (month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) {
    return null;
  }

  return { year, month, day };
}

function isDate(text) {
  return parseDate(text) !== null;
}

function daysInMonth(year, month) {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

// Months counted from year 0, so adding months is plain arithmetic.
function monthIndex(year, month) {
  return year * 12 + (month - 1);
}

function fromMonthIndex(index) {
  return { year: Math.floor(index / 12), month: (index % 12) + 1 };
}

function addMonths(year, month, count) {
  return fromMonthIndex(monthIndex(year, month) + count);
}

function addDays(text, days) {
  const { year, month, day } = parseDate(text);
  const moved = new Date(Date.UTC(year, month - 1, day + days));

  return toDate(moved.getUTCFullYear(), moved.getUTCMonth() + 1, moved.getUTCDate());
}

function lastDayOf(year, month) {
  return toDate(year, month, daysInMonth(year, month));
}

/*
 * Today's date where the organization is — not where the server is. At
 * 01:00 IST it is still yesterday in UTC.
 */
function todayIn(timeZone = "UTC", now = new Date()) {
  // en-CA formats as YYYY-MM-DD.
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

function periodOptions({ periodKind = "financial_year", periodStartMonth } = {}) {
  if (periodKind === "calendar_year") {
    return { periodKind, startMonth: 1 };
  }

  return { periodKind, startMonth: periodStartMonth || 4 };
}

function periodLabel(startYear, startMonth) {
  if (startMonth === 1) {
    return String(startYear);
  }

  return `${startYear}-${pad((startYear + 1) % 100)}`;
}

function periodStarting(startYear, startMonth) {
  const end = addMonths(startYear, startMonth, 11);

  return {
    label: periodLabel(startYear, startMonth),
    start: toDate(startYear, startMonth, 1),
    end: lastDayOf(end.year, end.month),
    startYear,
    startMonth,
  };
}

// The period a date falls in.
function periodFor(date, options = {}) {
  const { startMonth } = periodOptions(options);
  const { year, month } = parseDate(date);
  const startYear = month >= startMonth ? year : year - 1;

  return periodStarting(startYear, startMonth);
}

// "2025-26" (or "2025" for calendar years) back to its dates.
function periodFromLabel(label, options = {}) {
  const { startMonth } = periodOptions(options);
  const match = /^(\d{4})(?:-(\d{2}))?$/.exec(String(label));

  if (!match) {
    throw new Error(`Invalid period label: ${label}`);
  }

  const startYear = Number(match[1]);
  const period = periodStarting(startYear, startMonth);

  if (period.label !== label) {
    throw new Error(`Invalid period label for this period kind: ${label}`);
  }

  return period;
}

/*
 * The periods to offer around today, oldest first — generated rather than
 * hard-coded, so the list never runs out (FIX-21).
 */
function listPeriods(today, options = {}, { back = 3, forward = 1 } = {}) {
  const { startMonth } = periodOptions(options);
  const current = periodFor(today, options);
  const periods = [];

  for (let offset = -back; offset <= forward; offset += 1) {
    periods.push(periodStarting(current.startYear + offset, startMonth));
  }

  return periods;
}

// The months, quarters or whole period a rule generates one item for.
function subPeriods(period, frequency) {
  if (frequency === "monthly") {
    return Array.from({ length: 12 }, (_, offset) => {
      const { year, month } = addMonths(period.startYear, period.startMonth, offset);

      return {
        key: `${year}-${pad(month)}`,
        name: `${MONTHS[month - 1]} ${year}`,
        start: toDate(year, month, 1),
        end: lastDayOf(year, month),
      };
    });
  }

  if (frequency === "quarterly") {
    return [1, 2, 3, 4].map((quarter) => {
      const first = addMonths(period.startYear, period.startMonth, (quarter - 1) * 3);
      const last = addMonths(first.year, first.month, 2);

      return {
        key: `${period.label}:Q${quarter}`,
        name: `Q${quarter} ${period.label}`,
        quarter: `Q${quarter}`,
        start: toDate(first.year, first.month, 1),
        end: lastDayOf(last.year, last.month),
      };
    });
  }

  return [
    {
      key: period.label,
      name: period.startMonth === 1 ? period.label : `FY ${period.label}`,
      start: period.start,
      end: period.end,
    },
  ];
}

// The first occurrence of a month-day strictly after `after`.
function nextMonthDay(monthDay, after) {
  const [month, day] = monthDay.split("-").map(Number);
  const { year } = parseDate(after);

  for (const candidateYear of [year, year + 1]) {
    const clamped = Math.min(day, daysInMonth(candidateYear, month));
    const candidate = toDate(candidateYear, month, clamped);

    if (candidate > after) {
      return candidate;
    }
  }

  return null;
}

/*
 * One sub-period's due date under a schedule:
 *   { day: 11, offsetMonths: 1 }   the 11th of the month after the sub-period ends
 *   { date: "09-30" }              the next 30 Sep after the sub-period ends
 *   { dates: { Q1: "07-31", … } }  per quarter, the next such date after it ends
 * A day past the month's end is clamped (day 31 in February is the 28th/29th).
 */
function dueDate(sub, schedule) {
  if (schedule.dates) {
    const monthDay = schedule.dates[sub.quarter];

    return monthDay ? nextMonthDay(monthDay, sub.end) : null;
  }

  if (schedule.date) {
    return nextMonthDay(schedule.date, sub.end);
  }

  const end = parseDate(sub.end);
  const { year, month } = addMonths(end.year, end.month, schedule.offsetMonths || 0);

  return toDate(year, month, Math.min(schedule.day, daysInMonth(year, month)));
}

/*
 * The items one rule produces for one client in one period.
 *
 * `data` is what conditions read: client, engagement and `engaged` (the
 * catalog keys engaged this period). Rules for services that are not engaged
 * produce nothing — the caller filters by `rule.service` before calling.
 */
function generate(rule, period, data = {}) {
  if (rule.kind === "manual") {
    return [];
  }

  let schedule = rule.schedule;

  if (rule.condition !== undefined && !evaluate(rule.condition, data)) {
    if (!rule.else) {
      return [];
    }

    schedule = rule.else;
  }

  if (rule.kind === "relative") {
    const anchor = readPath(data, rule.relativeTo);

    if (!isFilled(anchor) || !isDate(anchor)) {
      return [];
    }

    return [
      {
        rule: rule.key,
        periodKey: period ? period.label : "once",
        dueOn: addDays(anchor, rule.offsetDays || 0),
        title: rule.name,
      },
    ];
  }

  return subPeriods(period, rule.frequency)
    .map((sub) => ({
      rule: rule.key,
      periodKey: sub.key,
      dueOn: dueDate(sub, schedule),
      title: `${rule.name} · ${sub.name}`,
      periodStart: sub.start,
      periodEnd: sub.end,
    }))
    .filter((item) => item.dueOn);
}

module.exports = {
  todayIn,
  parseDate,
  isDate,
  addDays,
  periodFor,
  periodFromLabel,
  listPeriods,
  subPeriods,
  dueDate,
  generate,
};
