/**
 * Canonical serialization — the basis of content-addressing.
 *
 * Guards (see docs/PREMORTEM.md):
 *  - LED-01: ONE canonical form. Object keys sorted recursively; arrays in order;
 *    no insignificant whitespace; idempotent (canonical(parse(canonical(x))) === canonical(x)).
 *  - LED-02: NO IEEE-754 floats in the ledger. Money/counts are integers; any
 *    non-integer number is rejected at canonicalization time so two hosts can never
 *    format the same value differently.
 *
 * We use deterministic JSON (sorted keys) rather than a binary codec to keep the
 * self-host story dependency-free and the bytes human-inspectable. Unicode is left
 * as-is in the JSON string (UTF-8); callers must NFC-normalize free text before it
 * enters an event (enforced at the event boundary, not here).
 */

export class CanonicalError extends Error {
  constructor(
    message: string,
    readonly path: string,
  ) {
    super(`${message} (at ${path})`);
    this.name = "CanonicalError";
  }
}

/** A JSON value restricted to what may live in the ledger (no floats, no undefined). */
export type CanonicalValue =
  | null
  | boolean
  | string
  | number // integers only — enforced below
  | CanonicalValue[]
  | { [k: string]: CanonicalValue };

/**
 * Serialize a value to its single canonical string form.
 * Throws CanonicalError for anything that would make hashing unstable.
 */
export function canonicalize(value: unknown): string {
  return encode(value, "$");
}

function encode(value: unknown, path: string): string {
  if (value === null) return "null";

  const t = typeof value;

  if (t === "boolean") return value ? "true" : "false";

  if (t === "number") {
    const n = value as number;
    if (!Number.isFinite(n)) {
      throw new CanonicalError(`non-finite number (${String(n)})`, path);
    }
    if (!Number.isInteger(n)) {
      // LED-02: floats are banned — they format differently across platforms.
      throw new CanonicalError(
        `non-integer number (${String(n)}); store money as integer minor-units or use a string`,
        path,
      );
    }
    if (!Number.isSafeInteger(n)) {
      throw new CanonicalError(
        `integer outside safe range (${String(n)}); use a string for big numbers`,
        path,
      );
    }
    // Integers have one canonical decimal form.
    return String(n);
  }

  if (t === "string") {
    // JSON.stringify gives a stable, escaped form for a single string.
    return JSON.stringify(value);
  }

  if (t === "undefined") {
    throw new CanonicalError("undefined is not allowed; use null or omit the key", path);
  }
  if (t === "bigint") {
    throw new CanonicalError("bigint is not allowed; use a string", path);
  }
  if (t === "function" || t === "symbol") {
    throw new CanonicalError(`${t} is not serializable`, path);
  }

  if (Array.isArray(value)) {
    const parts = value.map((v, i) => encode(v, `${path}[${i}]`));
    return `[${parts.join(",")}]`;
  }

  // Plain object: sort keys for a deterministic order (LED-01).
  if (isPlainObject(value)) {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).sort();
    const parts: string[] = [];
    for (const k of keys) {
      const v = obj[k];
      if (v === undefined) continue; // omit undefined keys rather than emit them
      parts.push(`${JSON.stringify(k)}:${encode(v, `${path}.${k}`)}`);
    }
    return `{${parts.join(",")}}`;
  }

  throw new CanonicalError(`unsupported value of type ${t}`, path);
}

function isPlainObject(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/** Parse canonical (or any valid JSON) back to a value. */
export function parseCanonical(text: string): CanonicalValue {
  return JSON.parse(text) as CanonicalValue;
}
