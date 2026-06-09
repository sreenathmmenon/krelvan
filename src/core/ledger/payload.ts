/**
 * Runtime-safe payload field extractors for untrusted LedgerEvent payloads.
 *
 * All LedgerEvent payloads are typed as `unknown` at the store boundary.
 * These helpers are the single source of truth for safely reading fields
 * from event payloads — import them wherever event payloads are read
 * (project.ts, incremental-fold.ts, observe.ts, etc.) rather than
 * maintaining separate copies.
 */

export function asObj(v: unknown): Record<string, unknown> {
  return isObj(v) ? (v as Record<string, unknown>) : {};
}

export function isObj(v: unknown): boolean {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function str(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

export function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

export function bool(v: unknown): boolean {
  return v === true;
}
