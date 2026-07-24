/**
 * Deterministic natural-language → schedule parser.
 *
 * The codebase treats the LLM as untrusted, so scheduling is parsed deterministically FIRST:
 * this pure module recognizes the high-frequency phrasings ("every weekday at 8am", "every
 * 15 minutes", "daily") and turns them into a validated cron or interval. The API may consider
 * a re-validated model proposal for the long tail only when the customer's own words explicitly
 * request recurrence. No LLM, no eval, no clock, no I/O — just string → structured data — so it
 * lives in core and is exhaustively testable.
 *
 * By construction it only ever emits well-formed 5-field cron strings and interval millis
 * with a 60s floor, so its output is safe without a separate validator.
 */

export interface SchedulePhrase {
  kind: "cron" | "interval";
  /** cron: a 5-field expression. interval: milliseconds as a string. */
  spec: string;
  /** human-readable summary, e.g. "every weekday at 08:00". */
  label: string;
}

const DOW: Record<string, number> = {
  sunday: 0, sun: 0, monday: 1, mon: 1, tuesday: 2, tue: 2, tues: 2,
  wednesday: 3, wed: 3, thursday: 4, thu: 4, thurs: 4, friday: 5, fri: 5, saturday: 6, sat: 6,
};
const DOW_NAME = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/** Parse an "at 8", "at 8:30", "at 8am", "at 8:30 pm" clause → { hour, minute } in 24h, or null. */
function parseTime(text: string): { hour: number; minute: number } | null {
  const m = /\bat\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b/.exec(text);
  if (!m) return null;
  let hour = parseInt(m[1]!, 10);
  const minute = m[2] ? parseInt(m[2], 10) : 0;
  const mer = m[3];
  if (hour > 23 || minute > 59) return null;
  if (mer === "pm" && hour < 12) hour += 12;
  if (mer === "am" && hour === 12) hour = 0;
  return { hour, minute };
}

function hhmm(hour: number, minute: number): string {
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

/**
 * Parse a scheduling phrase. Returns the schedule, or null when nothing recognizable is
 * present.
 */
export function parseSchedulePhrase(text: string): SchedulePhrase | null {
  const t = text.toLowerCase();

  // ── intervals: "every N minutes/hours", "every minute/hour" ────────────────────
  const everyN = /\bevery\s+(\d+)\s*(minute|minutes|min|mins|hour|hours|hr|hrs)\b/.exec(t);
  if (everyN) {
    const n = parseInt(everyN[1]!, 10);
    const unit = everyN[2]!;
    const isHour = unit.startsWith("h");
    const ms = Math.max(60_000, n * (isHour ? 3_600_000 : 60_000)); // 60s floor
    const label = `every ${n} ${isHour ? (n === 1 ? "hour" : "hours") : (n === 1 ? "minute" : "minutes")}`;
    return { kind: "interval", spec: String(ms), label };
  }
  if (/\bevery\s+(minute)\b/.test(t)) return { kind: "interval", spec: "60000", label: "every minute" };
  if (/\bevery\s+(hour)\b/.test(t) || /\bhourly\b/.test(t)) return { kind: "cron", spec: "0 * * * *", label: "every hour" };

  const time = parseTime(t);
  const tm = time ?? { hour: 8, minute: 0 }; // sensible default when a cadence is named but no time is

  // ── weekdays: "every weekday at 8", "on weekdays" ──────────────────────────────
  if (/\b(weekday|weekdays|business day|business days)\b/.test(t)) {
    return { kind: "cron", spec: `${tm.minute} ${tm.hour} * * 1-5`, label: `every weekday at ${hhmm(tm.hour, tm.minute)}` };
  }

  // ── a specific day of week: "every monday at 9", "on fridays" ──────────────────
  for (const [word, dow] of Object.entries(DOW)) {
    // match "monday"/"mondays"; guard word boundaries so "sun" doesn't hit "sunday" twice etc.
    if (new RegExp(`\\b${word}s?\\b`).test(t)) {
      return { kind: "cron", spec: `${tm.minute} ${tm.hour} * * ${dow}`, label: `every ${DOW_NAME[dow]} at ${hhmm(tm.hour, tm.minute)}` };
    }
  }

  // ── weekly (no specific day) → Monday ──────────────────────────────────────────
  if (/\bweekly\b/.test(t) || /\bevery\s+week\b/.test(t)) {
    return { kind: "cron", spec: `${tm.minute} ${tm.hour} * * 1`, label: `every week on Monday at ${hhmm(tm.hour, tm.minute)}` };
  }

  // ── daily: "every day at 8", "daily at 8:30am", "daily" ────────────────────────
  if (/\bevery\s+day\b/.test(t) || /\bdaily\b/.test(t) || (time && /\bevery\b/.test(t))) {
    return { kind: "cron", spec: `${tm.minute} ${tm.hour} * * *`, label: `every day at ${hhmm(tm.hour, tm.minute)}` };
  }

  return null;
}

/**
 * True when a phrase describes a daily-or-less cadence (a digest) — those default onMissed to
 * "runOnce" (you still want yesterday's digest, exactly once). Anything that can fire multiple
 * times a day (every hour / every N minutes) stays "skip". A digest is a cron whose hour field
 * is a concrete value, not the every-hour "*".
 */
export function isDigestCadence(phrase: SchedulePhrase): boolean {
  if (phrase.kind !== "cron") return false;
  const hour = phrase.spec.trim().split(/\s+/)[1] ?? "*";
  return hour !== "*";
}
