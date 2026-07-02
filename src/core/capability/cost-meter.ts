/**
 * Cost meter — supervisor-side, independent measurement of what a capability
 * invocation actually spent, so budget settlement does not have to trust the
 * plugin's self-reported cost.
 *
 * How it works: the Supervisor opens a meter scope around `plugin.invoke()`
 * (meterRun). Trusted infrastructure that performs billable work — today the
 * shared LLM client, which knows the provider-reported token usage of every
 * completion — records cost into the CURRENT scope (recordMeteredCost). The
 * scope rides Node's AsyncLocalStorage, so it follows the plugin's async work
 * (including parallel awaits) without any plumbing through plugin code, and a
 * plugin cannot "forget" to report what the client measured.
 *
 * Trust boundary, stated honestly:
 *  - LLM calls made through the shared client are METERED — a plugin that
 *    under-claims is settled at the metered amount anyway (settle = max(claim, meter)).
 *  - Work a plugin does through its OWN I/O stack (raw fetch to a paid API) is
 *    not visible to this meter; those claims remain self-reported until the
 *    production supervisor (sandboxed egress proxy) lands. That gap is recorded,
 *    not hidden: ObservedEffect keeps claim and meter as separate fields.
 */

import { AsyncLocalStorage } from "node:async_hooks";

interface MeterScope {
  cents: number;
  calls: number;
}

const als = new AsyncLocalStorage<MeterScope>();

/** Run `fn` inside a fresh meter scope; returns its result plus what was metered. */
export async function meterRun<T>(fn: () => Promise<T>): Promise<{ result: T; meteredCents: number; meteredCalls: number }> {
  const scope: MeterScope = { cents: 0, calls: 0 };
  const result = await als.run(scope, fn);
  return { result, meteredCents: Math.max(0, Math.round(scope.cents)), meteredCalls: scope.calls };
}

/**
 * Record independently-measured cost into the current meter scope. Called by trusted
 * infrastructure (the shared LLM client), never by plugins. Outside a scope it is a
 * no-op — direct client use (the compiler, the distiller) is not capability spend.
 */
export function recordMeteredCost(cents: number): void {
  const scope = als.getStore();
  if (!scope) return;
  if (Number.isFinite(cents) && cents > 0) scope.cents += cents;
  scope.calls += 1;
}
