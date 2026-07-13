// Krelvan Scheduler — runs agents on a time-based schedule.
//
// Supports cron expressions and simple interval schedules.
// Zero third-party dependencies — uses Node's built-in setInterval/setTimeout.
//
// Cron format: "minute hour day-of-month month day-of-week"
// Examples:
//   "0 8 * * *"      — every day at 08:00
//   "0 * * * *"      — every hour
//   "star/15 * * * *" — every 15 minutes (use actual asterisk in real use)
//   "0 9 * * 1"      — every Monday at 09:00
//
// Schedules persist in schedules.json alongside agents.json.
// On restart, active schedules are re-armed automatically.

import { join } from "node:path";
import { readFileSync, writeFileSync, renameSync, existsSync } from "node:fs";
import { getLogger } from "../core/observability/logger.js";

const log = getLogger("scheduler");

// ── Types ─────────────────────────────────────────────────────────────────────

export type ScheduleKind = "cron" | "interval";

/**
 * What to do with a schedule whose next-run time elapsed while the process was down.
 *  - "skip":    advance silently to the next future occurrence (the default — a missed
 *               hourly poll doesn't need to fire ten times at boot).
 *  - "runOnce": fire exactly ONE catch-up run, then re-arm (right for a daily/weekly
 *               digest — you still want yesterday's digest, but only once).
 */
export type OnMissed = "skip" | "runOnce";

export interface ScheduleRecord {
  id: string;
  agentId: string;
  agentName: string;
  kind: ScheduleKind;
  /** Cron expression (kind=cron) or interval in milliseconds (kind=interval) */
  spec: string;
  /** Human-readable description */
  label: string;
  enabled: boolean;
  createdAt: number;
  lastRunAt?: number;
  lastRunId?: string;
  nextRunAt?: number;
  /** Missed-run policy across downtime. Default "skip". */
  onMissed?: OnMissed;
  /** Outcome of the most recent scheduled run (set when the run finishes — see C2). */
  lastStatus?: "completed" | "failed" | "halted";
  /** Consecutive failures. Reset to 0 on a completed run; a warning surfaces at >= 3. */
  failStreak?: number;
}

export type ScheduleRunCallback = (agentId: string, scheduleId: string) => Promise<string>;

/**
 * Injectable time + timer facade so the scheduler is testable with a fake clock and
 * deterministic timers. Defaults to the real Node primitives.
 */
export interface SchedulerClock {
  now(): number;
  setTimer(fn: () => void, ms: number): ReturnType<typeof setTimeout>;
  clearTimer(t: ReturnType<typeof setTimeout>): void;
}

const REAL_CLOCK: SchedulerClock = {
  now: () => Date.now(),
  setTimer: (fn, ms) => setTimeout(fn, ms),
  clearTimer: (t) => clearTimeout(t),
};

/**
 * setTimeout with a delay above 2^31-1 ms (~24.8 days) fires IMMEDIATELY — a monthly or
 * yearly cron would misfire on arm. Cap each timer at 6h and sleep-chain (re-arm on wake)
 * until the real due time.
 */
export const MAX_ARM_MS = 6 * 60 * 60 * 1000;

// ── Cron parser ───────────────────────────────────────────────────────────────

interface CronFields {
  minutes: number[];
  hours: number[];
  daysOfMonth: number[];
  months: number[];
  daysOfWeek: number[];
}

function parseField(field: string, min: number, max: number): number[] {
  if (field === "*") {
    const all: number[] = [];
    for (let i = min; i <= max; i++) all.push(i);
    return all;
  }
  if (field.startsWith("*/")) {
    const step = parseInt(field.slice(2));
    if (isNaN(step) || step <= 0) throw new Error(`invalid step in cron field: ${field}`);
    const result: number[] = [];
    for (let i = min; i <= max; i += step) result.push(i);
    return result;
  }
  if (field.includes(",")) {
    return field.split(",").flatMap(f => parseField(f.trim(), min, max));
  }
  if (field.includes("-")) {
    const [startStr, endStr] = field.split("-");
    const start = parseInt(startStr ?? "");
    const end = parseInt(endStr ?? "");
    if (isNaN(start) || isNaN(end)) throw new Error(`invalid range in cron field: ${field}`);
    const result: number[] = [];
    for (let i = start; i <= end; i++) result.push(i);
    return result;
  }
  const n = parseInt(field);
  if (isNaN(n) || n < min || n > max) throw new Error(`cron field value ${field} out of range [${min}-${max}]`);
  return [n];
}

export function parseCron(expr: string): CronFields {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) throw new Error(`cron expression must have 5 fields, got: "${expr}"`);
  return {
    minutes:     parseField(parts[0]!, 0, 59),
    hours:       parseField(parts[1]!, 0, 23),
    daysOfMonth: parseField(parts[2]!, 1, 31),
    months:      parseField(parts[3]!, 1, 12),
    daysOfWeek:  parseField(parts[4]!, 0, 6),
  };
}

export function validateCron(expr: string): string | null {
  try {
    parseCron(expr);
    return null;
  } catch (e) {
    return (e as Error).message;
  }
}

/** Get the next Date after `from` that matches the cron fields. */
export function nextCronDate(fields: CronFields, from: Date): Date {
  const d = new Date(from.getTime());
  // Round up to the next whole minute
  d.setSeconds(0, 0);
  d.setMinutes(d.getMinutes() + 1);

  // Search up to 1 year ahead to prevent infinite loops on impossible expressions
  const limit = new Date(from.getTime() + 366 * 24 * 60 * 60 * 1000);

  while (d < limit) {
    // month is 0-indexed in JS Date
    if (!fields.months.includes(d.getMonth() + 1)) {
      d.setMonth(d.getMonth() + 1, 1);
      d.setHours(0, 0, 0, 0);
      continue;
    }
    if (!fields.daysOfMonth.includes(d.getDate()) || !fields.daysOfWeek.includes(d.getDay())) {
      d.setDate(d.getDate() + 1);
      d.setHours(0, 0, 0, 0);
      continue;
    }
    if (!fields.hours.includes(d.getHours())) {
      d.setHours(d.getHours() + 1, 0, 0, 0);
      continue;
    }
    if (!fields.minutes.includes(d.getMinutes())) {
      d.setMinutes(d.getMinutes() + 1, 0, 0);
      continue;
    }
    return d;
  }
  throw new Error(`no next occurrence found for cron "${JSON.stringify(fields)}" within 1 year`);
}

// ── Schedule registry ─────────────────────────────────────────────────────────

export class ScheduleRegistry {
  private schedules = new Map<string, ScheduleRecord>();
  private readonly path: string;

  constructor(dataDir: string) {
    this.path = join(dataDir, "schedules.json");
    this.load();
  }

  private load(): void {
    if (!existsSync(this.path)) return;
    try {
      const raw = JSON.parse(readFileSync(this.path, "utf8")) as ScheduleRecord[];
      for (const s of raw) this.schedules.set(s.id, s);
      log.info({ count: this.schedules.size }, "loaded schedules from disk");
    } catch (err) {
      log.warn({ err: (err as Error).message }, "failed to load schedules.json — starting fresh");
    }
  }

  private persist(): void {
    // atomic (temp+rename) so a crash mid-write can't truncate the file and silently drop every
    // armed schedule on next boot. Same durability guarantee as the agent/run/secret stores.
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, JSON.stringify([...this.schedules.values()], null, 2), "utf8");
    renameSync(tmp, this.path);
  }

  create(record: ScheduleRecord): void {
    this.schedules.set(record.id, record);
    this.persist();
  }

  get(id: string): ScheduleRecord | undefined {
    return this.schedules.get(id);
  }

  list(): ScheduleRecord[] {
    return [...this.schedules.values()].sort((a, b) => b.createdAt - a.createdAt);
  }

  update(id: string, patch: Partial<ScheduleRecord>): void {
    const s = this.schedules.get(id);
    if (s) { Object.assign(s, patch); this.persist(); }
  }

  delete(id: string): boolean {
    const existed = this.schedules.has(id);
    this.schedules.delete(id);
    if (existed) this.persist();
    return existed;
  }

  listForAgent(agentId: string): ScheduleRecord[] {
    return [...this.schedules.values()].filter(s => s.agentId === agentId);
  }
}

// ── Scheduler ─────────────────────────────────────────────────────────────────

/** Called when a schedule crosses the failure-streak threshold, to deliver a one-line notice. */
export type ScheduleFailureNotifier = (schedule: ScheduleRecord, latestReason: string) => void;

/** After this many consecutive failures, the schedule stays armed but surfaces a warning. */
export const FAIL_STREAK_WARN = 3;

export class Scheduler {
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly clock: SchedulerClock;
  private readonly notifyFailure?: ScheduleFailureNotifier;

  constructor(
    private readonly registry: ScheduleRegistry,
    private readonly onRun: ScheduleRunCallback,
    opts: { clock?: SchedulerClock; notifyFailure?: ScheduleFailureNotifier } = {},
  ) {
    this.clock = opts.clock ?? REAL_CLOCK;
    if (opts.notifyFailure) this.notifyFailure = opts.notifyFailure;
  }

  /**
   * Start all enabled schedules. Called at startup. For each enabled schedule whose stored
   * nextRunAt already elapsed while the process was down, apply its onMissed policy: "skip"
   * advances silently to the next future occurrence; "runOnce" fires exactly one catch-up.
   */
  start(): void {
    const now = this.clock.now();
    for (const schedule of this.registry.list()) {
      if (!schedule.enabled) continue;
      const missed = schedule.nextRunAt !== undefined && schedule.nextRunAt < now;
      if (missed && (schedule.onMissed ?? "skip") === "runOnce") {
        // Fire exactly one catch-up, then arm() (called inside fire) re-arms for the future.
        void this.fire(schedule.id);
      } else {
        // "skip" (or nothing missed): arm computes the next FUTURE occurrence, so a past
        // nextRunAt is naturally skipped.
        this.arm(schedule);
      }
    }
    log.info({ armed: this.timers.size }, "scheduler started");
  }

  /** Stop all timers. */
  stop(): void {
    for (const [id, timer] of this.timers) {
      this.clock.clearTimer(timer);
      log.info({ id }, "schedule disarmed");
    }
    this.timers.clear();
  }

  /** Arm a single schedule for its next occurrence (sleep-chained past the 6h timer cap). */
  arm(schedule: ScheduleRecord): void {
    this.disarm(schedule.id);

    const delayMs = this.msUntilNext(schedule);
    if (delayMs === null) {
      log.warn({ id: schedule.id, spec: schedule.spec }, "cannot compute next run time — schedule not armed");
      return;
    }

    const dueAt = this.clock.now() + delayMs;
    this.registry.update(schedule.id, { nextRunAt: dueAt });

    log.info({
      id: schedule.id,
      agent: schedule.agentName,
      spec: schedule.spec,
      nextIn: `${Math.round(delayMs / 1000)}s`,
    }, "schedule armed");

    this.armUntil(schedule.id, dueAt);
  }

  /**
   * Sleep-chain a timer toward an absolute `dueAt`. Node's setTimeout fires immediately for
   * delays over ~24.8 days, so we cap each hop at MAX_ARM_MS and re-check on wake. When the
   * remaining time is within one hop, we set the final timer that actually fires.
   */
  private armUntil(id: string, dueAt: number): void {
    const remaining = dueAt - this.clock.now();
    const hop = Math.min(Math.max(remaining, 0), MAX_ARM_MS);
    const timer = this.clock.setTimer(() => {
      // Re-check against the live clock: if we've reached the due time, fire; else keep chaining.
      if (this.clock.now() >= dueAt) {
        void this.fire(id);
      } else {
        this.armUntil(id, dueAt);
      }
    }, hop);
    this.timers.set(id, timer);
  }

  /** Disarm a schedule (cancel pending timer). */
  disarm(id: string): void {
    const existing = this.timers.get(id);
    if (existing) {
      this.clock.clearTimer(existing);
      this.timers.delete(id);
    }
  }

  /** Enable a schedule and arm it. */
  enable(id: string): boolean {
    const schedule = this.registry.get(id);
    if (!schedule) return false;
    this.registry.update(id, { enabled: true });
    this.arm({ ...schedule, enabled: true });
    return true;
  }

  /** Disable a schedule and disarm it. */
  disable(id: string): boolean {
    if (!this.registry.get(id)) return false;
    this.registry.update(id, { enabled: false });
    this.disarm(id);
    return true;
  }

  /** Fire a schedule immediately (and re-arm for next). */
  private async fire(scheduleId: string): Promise<void> {
    const schedule = this.registry.get(scheduleId);
    if (!schedule || !schedule.enabled) return;

    log.info({ id: scheduleId, agent: schedule.agentName }, "schedule firing");

    try {
      const runId = await this.onRun(schedule.agentId, scheduleId);
      this.registry.update(scheduleId, { lastRunAt: this.clock.now(), lastRunId: runId });
      log.info({ id: scheduleId, runId }, "scheduled run started");
    } catch (err) {
      // Failing to even START the run is itself a failure — count it toward the streak so a
      // broken schedule (deleted agent, bad config) can't silently fail forever.
      this.recordRunOutcome(scheduleId, "failed", (err as Error).message);
      log.error({ id: scheduleId, err: (err as Error).message }, "scheduled run failed to start");
    }

    // Re-arm for the next occurrence (a disabled schedule is left disarmed).
    const updated = this.registry.get(scheduleId);
    if (updated?.enabled) {
      this.arm(updated);
    }
  }

  /**
   * Record how a scheduled run finished (called from the runtime once the run completes/fails/
   * halts — see C2 attribution). Tracks a consecutive-failure streak: a "completed" run resets
   * it, anything else increments it. At the warning threshold the schedule STAYS ARMED (we don't
   * disable it — the next occurrence might succeed) but a one-line notice is delivered through the
   * agent's existing deliverTo targets so the owner learns their schedule is broken.
   */
  recordRunOutcome(scheduleId: string, status: "completed" | "failed" | "halted", reason = ""): void {
    const schedule = this.registry.get(scheduleId);
    if (!schedule) return;
    const prevStreak = schedule.failStreak ?? 0;
    const nextStreak = status === "completed" ? 0 : prevStreak + 1;
    this.registry.update(scheduleId, { lastStatus: status, failStreak: nextStreak });
    // Notify exactly ONCE, when the streak first reaches the threshold (not on every later fail).
    if (nextStreak === FAIL_STREAK_WARN && this.notifyFailure) {
      const updated = this.registry.get(scheduleId);
      if (updated) this.notifyFailure(updated, reason);
    }
  }

  /** Compute milliseconds until the next fire time (relative to the injected clock). */
  private msUntilNext(schedule: ScheduleRecord): number | null {
    const now = new Date(this.clock.now());
    try {
      if (schedule.kind === "interval") {
        const ms = parseInt(schedule.spec);
        if (isNaN(ms) || ms <= 0) return null;
        return ms;
      }
      if (schedule.kind === "cron") {
        const fields = parseCron(schedule.spec);
        const next = nextCronDate(fields, now);
        return Math.max(0, next.getTime() - now.getTime());
      }
    } catch (err) {
      log.warn({ id: schedule.id, spec: schedule.spec, err: (err as Error).message }, "invalid schedule spec");
    }
    return null;
  }

  isArmed(id: string): boolean {
    return this.timers.has(id);
  }
}
