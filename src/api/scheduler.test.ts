/**
 * C1 scheduler correctness — driven by a FAKE CLOCK so timing is deterministic:
 *  - timer overflow: a far-future cron sleep-chains (each hop <= MAX_ARM_MS) and fires once
 *    at the real due time, never immediately (the 2^31ms setTimeout bug);
 *  - onMissed: "skip" advances silently past a due time across a restart; "runOnce" fires
 *    exactly one catch-up;
 *  - failure streaks: N consecutive failures flip lastStatus/failStreak and notify ONCE.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  Scheduler, ScheduleRegistry, MAX_ARM_MS, FAIL_STREAK_WARN,
  type SchedulerClock, type ScheduleRecord,
} from "./scheduler.js";

/** A controllable clock + timer wheel. `advance(ms)` moves time and fires anything now due. */
function fakeClock(startMs = 1_700_000_000_000) {
  let now = startMs;
  let seq = 0;
  const timers = new Map<number, { at: number; fn: () => void }>();
  const clock: SchedulerClock = {
    now: () => now,
    setTimer: (fn, ms) => { const id = ++seq; timers.set(id, { at: now + ms, fn }); return id as unknown as ReturnType<typeof setTimeout>; },
    clearTimer: (t) => { timers.delete(t as unknown as number); },
  };
  const flush = () => new Promise<void>((r) => setImmediate(r)); // let async fire()/onRun settle
  async function advance(ms: number) {
    const target = now + ms;
    // Fire timers in due order, allowing re-armed (sleep-chained) timers to schedule again.
    // Flush microtasks after each fire so an async fire() that re-arms lands its next timer.
    for (;;) {
      await flush();
      let next: { id: number; at: number; fn: () => void } | null = null;
      for (const [id, t] of timers) if (t.at <= target && (next === null || t.at < next.at)) next = { id, ...t };
      if (!next) break;
      timers.delete(next.id);
      now = next.at;
      next.fn();
    }
    await flush();
    now = target;
  }
  return { clock, advance, flush, setNow: (t: number) => { now = t; }, nowRef: () => now };
}

function freshRegistry(): { registry: ScheduleRegistry; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "krelvan-sched-"));
  const dataDir = join(dir, "data");
  mkdirSync(dataDir, { recursive: true });
  return { registry: new ScheduleRegistry(dataDir), dir };
}

function baseSchedule(over: Partial<ScheduleRecord> = {}): ScheduleRecord {
  return {
    id: "s1", agentId: "a1", agentName: "Digest", kind: "interval", spec: "3600000",
    label: "hourly", enabled: true, createdAt: 0, ...over,
  };
}

test("scheduler: a far-future timer sleep-chains and fires once at the due time, not immediately", async () => {
  const { registry, dir } = freshRegistry();
  try {
    const { clock, advance } = fakeClock();
    let fires = 0;
    const sched = new Scheduler(registry, async () => { fires++; return "run-1"; }, { clock });
    // 40-day interval — far past setTimeout's ~24.8-day immediate-fire threshold.
    const fortyDaysMs = 40 * 24 * 60 * 60 * 1000;
    registry.create(baseSchedule({ spec: String(fortyDaysMs) }));
    sched.arm(registry.get("s1")!);

    // Immediately after arming: nothing fired (the bug would fire right away).
    await advance(1000);
    assert.equal(fires, 0, "must NOT fire on arm for a far-future schedule");

    // Halfway there: still nothing (proves it's chained, not one giant timer).
    await advance(fortyDaysMs / 2);
    assert.equal(fires, 0, "must not fire before the due time");

    // Cross the due time: fires exactly once.
    await advance(fortyDaysMs / 2 + 1000);
    assert.equal(fires, 1, "fires exactly once at the due time");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("scheduler: each sleep-chain hop is capped at MAX_ARM_MS", async () => {
  const { registry, dir } = freshRegistry();
  try {
    let maxHop = 0;
    const base = fakeClock();
    // Wrap setTimer to observe the requested delays.
    const clock: SchedulerClock = {
      now: base.clock.now,
      setTimer: (fn, ms) => { maxHop = Math.max(maxHop, ms); return base.clock.setTimer(fn, ms); },
      clearTimer: base.clock.clearTimer,
    };
    const sched = new Scheduler(registry, async () => "r", { clock });
    registry.create(baseSchedule({ spec: String(30 * 24 * 60 * 60 * 1000) })); // 30 days
    sched.arm(registry.get("s1")!);
    await base.advance(MAX_ARM_MS * 2); // let a couple hops elapse
    assert.ok(maxHop <= MAX_ARM_MS, `no hop may exceed MAX_ARM_MS (saw ${maxHop})`);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("scheduler onMissed 'skip': a due-in-the-past schedule advances silently at start()", async () => {
  const { registry, dir } = freshRegistry();
  try {
    const { clock, advance, flush } = fakeClock();
    let fires = 0;
    const sched = new Scheduler(registry, async () => { fires++; return "r"; }, { clock });
    // nextRunAt is already in the past (process was "down" through it).
    registry.create(baseSchedule({ onMissed: "skip", nextRunAt: clock.now() - 10_000 }));
    sched.start();
    await flush();
    // No catch-up fire; it just re-armed for the future.
    assert.equal(fires, 0, "skip must NOT fire a catch-up");
    // The next arming is one full interval out (1h) — nothing until then.
    await advance(60 * 60 * 1000 + 1000);
    assert.equal(fires, 1, "after skip it fires on the next real occurrence");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("scheduler onMissed 'runOnce': fires exactly one catch-up at start(), then re-arms", async () => {
  const { registry, dir } = freshRegistry();
  try {
    const { clock, advance, flush } = fakeClock();
    let fires = 0;
    const sched = new Scheduler(registry, async () => { fires++; return "r"; }, { clock });
    registry.create(baseSchedule({ onMissed: "runOnce", nextRunAt: clock.now() - 10_000 }));
    sched.start();
    await flush();
    assert.equal(fires, 1, "runOnce fires exactly one catch-up at boot");
    // And it re-armed — the NEXT occurrence still comes an interval later, only once more.
    await advance(60 * 60 * 1000 + 1000);
    assert.equal(fires, 2, "then it resumes normal cadence (one more fire)");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("scheduler failure streak: 3 consecutive failures warn once and keep the schedule armed", () => {
  const { registry, dir } = freshRegistry();
  try {
    const { clock } = fakeClock();
    const notices: { label: string; reason: string }[] = [];
    const sched = new Scheduler(registry, async () => "r", {
      clock,
      notifyFailure: (s, reason) => notices.push({ label: s.label, reason }),
    });
    registry.create(baseSchedule({ label: "nightly digest" }));

    sched.recordRunOutcome("s1", "failed", "boom-1");
    assert.equal(registry.get("s1")!.failStreak, 1);
    assert.equal(notices.length, 0, "no notice below the threshold");
    sched.recordRunOutcome("s1", "failed", "boom-2");
    sched.recordRunOutcome("s1", "failed", "boom-3");
    assert.equal(registry.get("s1")!.failStreak, FAIL_STREAK_WARN);
    assert.equal(registry.get("s1")!.lastStatus, "failed");
    assert.equal(notices.length, 1, "notify EXACTLY once, when the streak hits the threshold");
    assert.match(notices[0]!.reason, /boom-3/);
    assert.equal(registry.get("s1")!.enabled, true, "the schedule stays armed (not disabled)");

    // A 4th failure must NOT re-notify (already warned).
    sched.recordRunOutcome("s1", "failed", "boom-4");
    assert.equal(notices.length, 1, "no repeat notice on further failures");

    // A success resets the streak.
    sched.recordRunOutcome("s1", "completed");
    assert.equal(registry.get("s1")!.failStreak, 0);
    assert.equal(registry.get("s1")!.lastStatus, "completed");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("scheduler: recordRunOutcome on a missing schedule is a safe no-op", () => {
  const { registry, dir } = freshRegistry();
  try {
    const { clock } = fakeClock();
    const sched = new Scheduler(registry, async () => "r", { clock });
    sched.recordRunOutcome("does-not-exist", "failed", "x"); // must not throw
    assert.ok(true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
