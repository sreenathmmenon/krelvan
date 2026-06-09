/**
 * The Time authority — a monotonic, notarized logical clock.
 *
 * The council mandated Identity/Secrets/Time as a first-class subsystem because four
 * other subsystems silently depend on a trustworthy clock and key custody. Reading
 * `Date.now()` directly anywhere in the core is BANNED: it makes replay
 * non-deterministic and lets an attacker-controlled wall clock break time-based
 * guarantees. Instead, time enters the system ONLY as signed `timer.elapsed`-style
 * ticks from this authority, and every event's `ts` is a notarized tick.
 *
 * Guards:
 *  - TIME: monotonic — never goes backward, even if the wall clock jumps back.
 *  - TIME: notarized — each tick is signed, so a forged time is detectable.
 *  - TIME: the core never reads a raw clock; it calls clock.now() which returns a
 *    monotonic tick. The source of truth is injected (wall clock in prod, a fixed
 *    sequence in tests) so tests are fully deterministic.
 */

import type { Signature, Signer } from "../ledger/crypto.js";

/** A source of raw wall-time, injected so it can be faked in tests. */
export type TimeSource = () => number;

export interface NotarizedTick {
  /** the monotonic logical time. */
  t: number;
  /** signature over the tick value by the time authority. */
  sig: Signature;
}

/**
 * Monotonic clock: wraps a (possibly untrustworthy) wall-time source and guarantees
 * the returned time never decreases. If the source goes backward (clock skew, NTP
 * step, attacker), we hold the last value and advance by 1 — and flag it.
 */
export class MonotonicClock {
  private last = 0;
  private backwardSteps = 0;

  constructor(
    private readonly source: TimeSource,
    private readonly signer: Signer,
  ) {}

  /** Return the next monotonic time (>= previous). */
  now(): number {
    const raw = this.source();
    let t: number;
    if (raw > this.last) {
      t = raw;
    } else {
      // source did not advance (or went backward) — step forward by 1 and record it.
      this.backwardSteps++;
      t = this.last + 1;
    }
    this.last = t;
    return t;
  }

  /** Return a notarized (signed) tick — used when time itself must be auditable. */
  tick(): NotarizedTick {
    const t = this.now();
    return { t, sig: this.signer.sign(`tick:${t}`, t) };
  }

  /** How many times the underlying source failed to advance — surfaced for ops/audit. */
  get observedBackwardSteps(): number {
    return this.backwardSteps;
  }
}

/** A deterministic clock for tests: yields 1,2,3,… regardless of any wall clock. */
export function logicalClockSource(): TimeSource {
  let n = 0;
  return () => ++n;
}
