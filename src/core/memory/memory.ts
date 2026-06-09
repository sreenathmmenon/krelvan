/**
 * Memory — four planes, all folded from the same signed ledger.
 *
 * Memory is NOT a separate database; it is a PROJECTION of memory events on the one
 * ledger, so what an agent "knows" is always replayable and provably equals what
 * happened. Four planes share one event vocabulary but differ in lifetime/scope:
 *
 *  - WORKING  : run-scoped scratch; folded per run, never persisted beyond it.
 *  - EPISODIC : per-run summaries — what happened, owned by the agent.
 *  - SEMANTIC : durable distilled facts with provenance back to the episodes that
 *               justified them. Distillation is a CAPTURED non-deterministic effect
 *               (an LLM produced it), tagged so observability never tries to
 *               hash-reconcile it.
 *  - SOUL     : the agent's signed identity (name/values/standing instructions),
 *               versioned; edits require owner authority (identity-mutation).
 *
 * Security guards:
 *  - MEM untrusted-inbound: any fact whose provenance includes channel/agent/memory
 *    (untrusted) origin is QUARANTINED — it may inform reads, but it may NOT
 *    influence a spend / write-irreversible / identity-mutation decision unless an
 *    owner re-passes it through the autonomy gate. This closes the "laundering
 *    instructions across runs" hole.
 *  - MEM SOUL: identity edits are an identity-mutation effect, owner-authority only.
 */

import type { LedgerEvent } from "../ledger/event.js";
import { asObj } from "../ledger/payload.js";

/** Where a memory fact ultimately came from — drives the trust gate. */
export type Provenance = "owner" | "tool-observed" | "channel" | "agent" | "memory";

/** An untrusted provenance may not influence consequential decisions. */
const TRUSTED_PROVENANCE: ReadonlySet<Provenance> = new Set<Provenance>(["owner", "tool-observed"]);

export function isTrusted(p: Provenance): boolean {
  return TRUSTED_PROVENANCE.has(p);
}

/** A distilled semantic fact. */
export interface SemanticFact {
  key: string;
  value: string | number | boolean;
  /** which episodes justified this fact (content addresses). */
  derivedFrom: string[];
  provenance: Provenance;
  /** distillation is non-deterministic; this records the model + version that made it. */
  distilledBy: string;
  /** version — re-distillation appends a new version, never mutates in place. */
  version: number;
  ts: number;
}

/** An episodic memory: a summarized run trace. */
export interface Episode {
  runId: string;
  summary: string;
  provenance: Provenance;
  ts: number;
}

/** SOUL: the agent's signed identity. */
export interface Soul {
  name: string;
  values: string[];
  standingInstructions: string[];
  version: number;
}

export interface MemoryProjection {
  episodic: Episode[];
  /** latest version per semantic key. */
  semantic: Map<string, SemanticFact>;
  soul: Soul | null;
}

/**
 * Fold the ledger into the durable memory planes (episodic/semantic/SOUL). Working
 * memory is run-scoped and folded separately by the engine, not here.
 *
 * Memory events live in the ledger payload under these conventional types:
 *  - EffectResult with payload.memory = { plane:"episodic", episode }
 *  - EffectResult with payload.memory = { plane:"semantic", fact }
 *  - EffectResult with payload.memory = { plane:"soul", soul } (must be owner-signed)
 */
export function projectMemory(events: readonly LedgerEvent[]): MemoryProjection {
  const episodic: Episode[] = [];
  const semantic = new Map<string, SemanticFact>();
  let soul: Soul | null = null;

  for (const e of events) {
    if (e.type !== "EffectResult") continue;
    const mem = asObj(e.payload)["memory"] as MemoryEventPayload | undefined;
    if (!mem) continue;

    switch (mem.plane) {
      case "episodic":
        episodic.push(mem.episode);
        break;
      case "semantic": {
        const f = mem.fact;
        const existing = semantic.get(f.key);
        // keep the highest version (re-distillation supersedes)
        if (!existing || f.version > existing.version) semantic.set(f.key, f);
        break;
      }
      case "soul":
        // SOUL only updates if the event was signed by the owner authority.
        // (We record the author on the event; the caller must have enforced
        // owner-authority at append time — see assertSoulAuthority.)
        if (mem.authorityOk) soul = mem.soul;
        break;
    }
  }

  return { episodic, semantic, soul };
}

export type MemoryEventPayload =
  | { plane: "episodic"; episode: Episode }
  | { plane: "semantic"; fact: SemanticFact }
  | { plane: "soul"; soul: Soul; authorityOk: boolean };

/**
 * Retrieval: select semantic facts relevant to a query. The KEY guard: facts are
 * returned WITH their trust status, and a caller making a consequential decision
 * must filter to trusted facts only (see consequentialFacts).
 *
 * Retrieval results are deterministic given the projection + query, and the engine
 * captures the returned set BY HASH as a signed input event so replay re-feeds the
 * exact same set (never re-queries) — keeping time-travel honest.
 */
export function retrieve(mem: MemoryProjection, keys: readonly string[]): SemanticFact[] {
  const out: SemanticFact[] = [];
  for (const k of keys) {
    const f = mem.semantic.get(k);
    if (f) out.push(f);
  }
  // stable order (by key) so the captured set is deterministic
  return out.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

/**
 * The untrusted-inbound gate. Given a set of facts, return ONLY those that may
 * influence a consequential decision (spend / write-irreversible / identity).
 * Untrusted-provenance facts are filtered out. This is what stops a fact laundered
 * in from a channel message from authorizing a spend.
 */
export function consequentialFacts(facts: readonly SemanticFact[]): {
  usable: SemanticFact[];
  quarantined: SemanticFact[];
} {
  const usable: SemanticFact[] = [];
  const quarantined: SemanticFact[] = [];
  for (const f of facts) {
    if (isTrusted(f.provenance)) usable.push(f);
    else quarantined.push(f);
  }
  return { usable, quarantined };
}

/**
 * Distillation provenance rule: a fact distilled from a set of episodes inherits the
 * LEAST-trusted provenance among its sources. If ANY source episode was untrusted,
 * the resulting fact is untrusted — untrustedness propagates, it never washes out.
 */
export function distilledProvenance(sources: readonly Provenance[]): Provenance {
  // order of trust, most→least
  for (const p of ["channel", "agent", "memory"] as Provenance[]) {
    if (sources.includes(p)) return p; // any untrusted source → untrusted result
  }
  if (sources.includes("owner")) return "owner";
  return "tool-observed";
}
