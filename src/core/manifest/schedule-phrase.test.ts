import { test } from "node:test";
import assert from "node:assert/strict";
import { parseSchedulePhrase, isDigestCadence } from "./schedule-phrase.js";

// Table-driven: [input phrase, expected {kind, spec, label} or null].
const CASES: Array<[string, { kind: "cron" | "interval"; spec: string } | null]> = [
  // daily
  ["email me a summary every day at 8am", { kind: "cron", spec: "0 8 * * *" }],
  ["every day at 8", { kind: "cron", spec: "0 8 * * *" }],
  ["daily at 8:30am", { kind: "cron", spec: "30 8 * * *" }],
  ["send a daily digest at 6:45pm", { kind: "cron", spec: "45 18 * * *" }],
  ["daily", { kind: "cron", spec: "0 8 * * *" }],           // default 08:00
  ["every day at 12am", { kind: "cron", spec: "0 0 * * *" }], // midnight
  ["every day at 12pm", { kind: "cron", spec: "0 12 * * *" }], // noon
  // weekdays
  ["every weekday at 8am", { kind: "cron", spec: "0 8 * * 1-5" }],
  ["on business days at 9:15", { kind: "cron", spec: "15 9 * * 1-5" }],
  // day-of-week
  ["every monday at 9am", { kind: "cron", spec: "0 9 * * 1" }],
  ["every Friday at 5pm", { kind: "cron", spec: "0 17 * * 5" }],
  ["post on sundays at 7", { kind: "cron", spec: "0 7 * * 0" }],
  // weekly (no day → Monday)
  ["weekly at 10am", { kind: "cron", spec: "0 10 * * 1" }],
  ["every week at 10", { kind: "cron", spec: "0 10 * * 1" }],
  // hourly
  ["every hour", { kind: "cron", spec: "0 * * * *" }],
  ["hourly", { kind: "cron", spec: "0 * * * *" }],
  // intervals
  ["every 15 minutes", { kind: "interval", spec: "900000" }],
  ["every 30 mins", { kind: "interval", spec: "1800000" }],
  ["every 2 hours", { kind: "interval", spec: "7200000" }],
  ["every 1 minute", { kind: "interval", spec: "60000" }],
  ["every minute", { kind: "interval", spec: "60000" }],
  // interval floor: "every 0 minutes" clamps to 60s (never sub-minute)
  ["every 0 minutes", { kind: "interval", spec: "60000" }],
  // no schedule → null (falls back to the model)
  ["just research the topic and write a brief", null],
  ["", null],
  ["remind me sometime", null],
];

test("parseSchedulePhrase: table of high-frequency phrasings", () => {
  for (const [input, expected] of CASES) {
    const got = parseSchedulePhrase(input);
    if (expected === null) {
      assert.equal(got, null, `"${input}" should not parse to a schedule`);
    } else {
      assert.ok(got, `"${input}" should parse`);
      assert.equal(got!.kind, expected.kind, `"${input}" kind`);
      assert.equal(got!.spec, expected.spec, `"${input}" spec`);
      assert.ok(got!.label.length > 0, `"${input}" has a label`);
    }
  }
});

test("parseSchedulePhrase: every cron output is a well-formed 5-field expression", () => {
  for (const [input] of CASES) {
    const got = parseSchedulePhrase(input);
    if (got?.kind === "cron") {
      const fields = got.spec.trim().split(/\s+/);
      assert.equal(fields.length, 5, `"${input}" → "${got.spec}" must have 5 fields`);
    }
    if (got?.kind === "interval") {
      assert.ok(Number(got.spec) >= 60_000, `"${input}" interval >= 60s`);
    }
  }
});

test("parseSchedulePhrase: labels are human-readable", () => {
  assert.match(parseSchedulePhrase("every weekday at 8am")!.label, /weekday at 08:00/);
  assert.match(parseSchedulePhrase("every monday at 9am")!.label, /Monday at 09:00/);
  assert.match(parseSchedulePhrase("every 15 minutes")!.label, /15 minutes/);
});

test("isDigestCadence: daily/weekly are digests (runOnce); sub-daily are not (skip)", () => {
  assert.equal(isDigestCadence(parseSchedulePhrase("every day at 8am")!), true);
  assert.equal(isDigestCadence(parseSchedulePhrase("every weekday at 8am")!), true);
  assert.equal(isDigestCadence(parseSchedulePhrase("every monday at 9am")!), true);
  assert.equal(isDigestCadence(parseSchedulePhrase("weekly at 10am")!), true);
  assert.equal(isDigestCadence(parseSchedulePhrase("every hour")!), false);
  assert.equal(isDigestCadence(parseSchedulePhrase("every 15 minutes")!), false);
});
