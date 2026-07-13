/**
 * C3 build-path schedule detection: the deterministic parser drives the proposal, and the
 * MODEL's proposal is untrusted — accepted only after re-validation (validateCron / interval
 * floor). Digest cadences default onMissed to runOnce, everything else to skip.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { scheduleFromIntent, validatedModelSchedule } from "./server.js";

test("scheduleFromIntent: a digest intent yields a valid cron with runOnce", () => {
  const s = scheduleFromIntent("email me a competitor digest every weekday at 8am");
  assert.ok(s);
  assert.equal(s!.kind, "cron");
  assert.equal(s!.spec, "0 8 * * 1-5");
  assert.equal(s!.onMissed, "runOnce", "daily/weekly digests catch up once");
});

test("scheduleFromIntent: a sub-daily interval defaults to skip", () => {
  const s = scheduleFromIntent("check the page every 15 minutes");
  assert.ok(s);
  assert.equal(s!.kind, "interval");
  assert.equal(s!.spec, "900000");
  assert.equal(s!.onMissed, "skip");
});

test("scheduleFromIntent: no cadence → null (build path falls back to the model)", () => {
  assert.equal(scheduleFromIntent("research the topic and write a brief"), null);
});

test("validatedModelSchedule: accepts a valid cron, rejects a malformed one", () => {
  assert.deepEqual(validatedModelSchedule({ kind: "cron", expr: "0 9 * * 1" }), { kind: "cron", spec: "0 9 * * 1", label: "0 9 * * 1", onMissed: "skip" });
  assert.equal(validatedModelSchedule({ kind: "cron", expr: "not a cron" }), null, "malformed cron is dropped");
  assert.equal(validatedModelSchedule({ kind: "cron", expr: "99 99 * * *" }), null, "out-of-range cron is dropped");
});

test("validatedModelSchedule: enforces the 60s interval floor", () => {
  assert.ok(validatedModelSchedule({ kind: "interval", ms: 60_000 }), "exactly 60s is allowed");
  assert.equal(validatedModelSchedule({ kind: "interval", ms: 5_000 }), null, "sub-minute interval is dropped");
  assert.equal(validatedModelSchedule({ kind: "interval", ms: 1.5 }), null, "non-integer ms is dropped");
});
