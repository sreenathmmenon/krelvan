/**
 * In-browser Krelvan proof verifier — the REAL check, running client-side.
 *
 * This is a faithful TypeScript port of bin/krelvan-verify.mjs: it recomputes every event's
 * SHA-256 content address from the canonical preimage and verifies every Ed25519 signature
 * against the public keys, using only the Web Crypto API (crypto.subtle) — no dependencies,
 * no network. It powers the homepage "tamper toggle": flip a byte and watch the real verifier
 * reject it, live, in your own browser (open devtools — it's genuinely computing the hashes).
 *
 * It MUST stay byte-compatible with src/core/ledger/canonical.ts + event.ts + the CLI verifier.
 */

export interface ProofEvent {
  type: string;
  scope: { tenantId: string; runId: string; nodeId?: string; branchId: string };
  parents?: string[];
  prev?: string | null;
  offset: number;
  payload: unknown;
  determinism: string;
  ts: number;
  author: string;
  id: string;
  sig?: { keyId: string; epoch: number; signedAt: number; value: string };
}

export interface ProofBundle {
  krelvanProofBundle: number;
  runId: string;
  exportedAt: number;
  algorithm: string;
  publicKeys: { keyId: string; epoch: number; publicKeyPem: string }[];
  events: ProofEvent[];
  [k: string]: unknown;
}

export interface VerifyResult {
  ok: boolean;
  algorithm: string;
  eventCount: number;
  hashes: { checked: number; failed: number };
  signatures: { checked: number; failed: number; allSigned: boolean };
  ordering: { ok: boolean };
  boundaries: { startsAtRunStarted: boolean; endsTerminal: boolean };
  verdict: "VERIFIED" | "CONSISTENT" | "REJECTED" | "NOT_VERIFIABLE";
  detail: string;
  failures: string[];
}

const TERMINAL = new Set(["RunCompleted", "RunFailed", "AwaitRequested"]);

// ── canonicalize — MUST byte-match src/core/ledger/canonical.ts ──────────────────
function canonicalize(value: unknown): string {
  if (value === null) return "null";
  const t = typeof value;
  if (t === "boolean") return value ? "true" : "false";
  if (t === "number") {
    const n = value as number;
    if (!Number.isFinite(n) || !Number.isInteger(n) || !Number.isSafeInteger(n)) {
      throw new Error("non-canonical number");
    }
    return String(n);
  }
  if (t === "string") return JSON.stringify(value);
  if (t === "undefined") throw new Error("undefined not allowed");
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  if (t === "object") {
    const o = value as Record<string, unknown>;
    const keys = Object.keys(o).sort();
    const parts: string[] = [];
    for (const k of keys) {
      if (o[k] === undefined) continue;
      parts.push(`${JSON.stringify(k)}:${canonicalize(o[k])}`);
    }
    return `{${parts.join(",")}}`;
  }
  throw new Error(`unsupported type ${t}`);
}

function preimageBytes(e: ProofEvent): string {
  const scope = {
    tenantId: e.scope.tenantId,
    runId: e.scope.runId,
    ...(e.scope.nodeId !== undefined ? { nodeId: e.scope.nodeId } : {}),
    branchId: e.scope.branchId,
  };
  return canonicalize({
    type: e.type,
    scope,
    parents: [...(e.parents ?? [])],
    prev: e.prev ?? null,
    offset: e.offset,
    payload: e.payload,
    determinism: e.determinism,
    ts: e.ts,
    author: e.author,
  });
}

async function contentAddress(canonicalBytes: string): Promise<string> {
  const buf = new TextEncoder().encode(canonicalBytes);
  const digest = await crypto.subtle.digest("SHA-256", buf);
  const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `sha256:${hex}`;
}

// Parse an SPKI PEM into a CryptoKey for Ed25519 verification.
function pemToDer(pem: string): Uint8Array {
  const b64 = pem.replace(/-----BEGIN [^-]+-----/, "").replace(/-----END [^-]+-----/, "").replace(/\s+/g, "");
  const raw = atob(b64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/** Verify a proof bundle entirely in the browser. Mirrors bin/krelvan-verify.mjs (unpinned). */
export async function verifyBundle(bundle: ProofBundle): Promise<VerifyResult> {
  const failures: string[] = [];
  const isEd25519 = bundle.algorithm === "ed25519";
  const events = bundle.events ?? [];

  // import public keys
  const keys = new Map<string, CryptoKey>();
  if (isEd25519) {
    for (const k of bundle.publicKeys ?? []) {
      try {
        const key = await crypto.subtle.importKey("spki", pemToDer(k.publicKeyPem) as BufferSource, { name: "Ed25519" }, false, ["verify"]);
        keys.set(`${k.keyId}#${k.epoch}`, key);
      } catch {
        failures.push(`bad public key ${k.keyId}#${k.epoch}`);
      }
    }
  }

  let hashChecked = 0, hashFailed = 0, sigChecked = 0, sigFailed = 0;
  let prevOffset: number | null = null;
  let orderingOk = true;

  for (const e of events) {
    // 1) content address
    hashChecked++;
    let computed = "";
    try { computed = await contentAddress(preimageBytes(e)); } catch { computed = "(uncanonicalizable)"; }
    if (computed !== e.id) { hashFailed++; failures.push(`offset ${e.offset} ${e.type}: content address mismatch`); }

    // 2) signature (Ed25519 — every event must be signed and verify)
    if (isEd25519) {
      if (!e.sig) {
        sigFailed++; failures.push(`offset ${e.offset} ${e.type}: no signature`);
      } else {
        const key = keys.get(`${e.sig.keyId}#${e.sig.epoch}`);
        if (!key) { sigFailed++; failures.push(`offset ${e.offset}: no public key for ${e.sig.keyId}#${e.sig.epoch}`); }
        else {
          sigChecked++;
          let valid = false;
          try {
            const sigBytes = hexToBytes(e.sig.value);
            valid = sigBytes.length === 64 && await crypto.subtle.verify("Ed25519", key, sigBytes as BufferSource, new TextEncoder().encode(e.id) as BufferSource);
          } catch { valid = false; }
          if (!valid) { sigFailed++; failures.push(`offset ${e.offset} ${e.type}: signature does not verify`); }
        }
      }
    }

    // 3) ordering — strictly increasing offsets
    if (prevOffset !== null && !(e.offset > prevOffset)) { orderingOk = false; failures.push(`offset ${e.offset}: not strictly after ${prevOffset}`); }
    prevOffset = e.offset;
  }

  // 4) run boundaries
  const first = events[0];
  const last = events[events.length - 1];
  const startsAtRunStarted = first?.type === "RunStarted";
  const endsTerminal = !!last && TERMINAL.has(last.type);
  if (!startsAtRunStarted) failures.push("does not begin with RunStarted");
  if (!endsTerminal) failures.push("does not end at a terminal event");

  const allSigned = isEd25519 && sigChecked === events.length && sigChecked > 0;
  const structureOk = hashFailed === 0 && sigFailed === 0 && orderingOk && startsAtRunStarted && endsTerminal;

  let verdict: VerifyResult["verdict"];
  let detail: string;
  if (!isEd25519) {
    verdict = "NOT_VERIFIABLE";
    detail = `${bundle.algorithm} signatures cannot be checked offline without the instance secret.`;
  } else if (structureOk && allSigned) {
    verdict = "CONSISTENT";
    detail = "Every event is authentic and unaltered. Pin the issuer key to also prove origin.";
  } else {
    verdict = "REJECTED";
    detail = "The bundle does not match its own signed record — it has been altered.";
  }

  return {
    ok: verdict === "CONSISTENT",
    algorithm: bundle.algorithm,
    eventCount: events.length,
    hashes: { checked: hashChecked, failed: hashFailed },
    signatures: { checked: sigChecked, failed: sigFailed, allSigned },
    ordering: { ok: orderingOk },
    boundaries: { startsAtRunStarted, endsTerminal },
    verdict,
    detail,
    failures,
  };
}
