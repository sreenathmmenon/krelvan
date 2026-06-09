/**
 * Channels & the Interaction Resolver — how humans talk to agents and approve.
 *
 * A channel adapter (Telegram/Slack/web/voice) is STATELESS and untrusted: it only
 * (a) emits inbound messages as DATA, and (b) renders outbound messages. It holds no
 * conversational state, no secrets, no manifest access. Conversation lives in the
 * ledger, keyed by (principalId, threadId).
 *
 * The TRUSTED in-core Interaction Resolver is the single enforcement point:
 *  - it verifies a reply's single-use, branch-scoped correlation token,
 *  - checks the channel's identity-assurance level is sufficient for the effect class,
 *  - and on approval, APPROVAL *IS* AUTHORIZATION: it doesn't just say "yes", it
 *    resolves the parked await AND would mint the matching capability grant atomically.
 *
 * Guards:
 *  - CHAN: adapter never approves; only the resolver does.
 *  - CHAN: a correlation token is single-use + branch-scoped (replay-proof).
 *  - CHAN: low-assurance channels (recycled SMS/voice) can't authorize high-risk
 *    effects without step-up.
 */

import type { SideEffectClass } from "../manifest/manifest.js";

/** Identity assurance of a channel/principal binding. Higher = stronger proof. */
export type AssuranceLevel = "low" | "medium" | "high";

const ASSURANCE_RANK: Record<AssuranceLevel, number> = { low: 0, medium: 1, high: 2 };

/** Minimum assurance required to authorize a given effect class. */
const REQUIRED_ASSURANCE: Record<SideEffectClass, AssuranceLevel> = {
  read: "low",
  "write-reversible": "low",
  "message-human": "low",
  "write-irreversible": "medium",
  spend: "high",
  "identity-mutation": "high",
};

/** An inbound message from a channel adapter — pure DATA. */
export interface InboundMessage {
  channel: string; // "telegram", "slack", …
  principalId: string; // resolved external identity → internal principal
  threadId: string;
  text: string;
  /** the assurance the adapter attests for this principal binding. */
  assurance: AssuranceLevel;
  ts: number;
}

/** A reply to a parked approval — also pure DATA, NOT a decision. */
export interface ReplyMessage {
  channel: string;
  principalId: string;
  /** the correlation token the bot included in the approval request. */
  correlationId: string;
  /** the human's answer. */
  decision: "approve" | "deny";
  assurance: AssuranceLevel;
  ts: number;
}

/** A parked await waiting for a human reply. */
export interface ParkedAwait {
  correlationId: string;
  branchId: string;
  /** the effect class being approved — drives the assurance requirement. */
  effect: SideEffectClass;
  principalId: string;
  /** false once resolved — single-use. */
  open: boolean;
}

export type ResolveOutcome =
  | { kind: "authorized"; correlationId: string } // approval IS authorization
  | { kind: "denied"; correlationId: string }
  | { kind: "rejected"; reason: ResolveReject };

export type ResolveReject =
  | "UNKNOWN_CORRELATION"
  | "ALREADY_RESOLVED" // single-use
  | "WRONG_PRINCIPAL"
  | "BRANCH_MISMATCH"
  | "INSUFFICIENT_ASSURANCE"; // needs step-up

/**
 * The trusted in-core resolver. It owns the set of open awaits (in a real system
 * these are folded from the ledger; here we keep them explicit for testability).
 */
export class InteractionResolver {
  private readonly awaits = new Map<string, ParkedAwait>();

  /** Register a parked await (the engine does this when a node gates for approval). */
  park(a: ParkedAwait): void {
    this.awaits.set(a.correlationId, { ...a, open: true });
  }

  /**
   * Resolve a reply. Enforces single-use, principal match, branch match, and the
   * assurance requirement for the effect class. On approve → "authorized" (which the
   * engine treats as: resolve the await AND mint the grant). On deny → "denied".
   */
  resolve(reply: ReplyMessage, branchId: string): ResolveOutcome {
    const a = this.awaits.get(reply.correlationId);
    if (!a) return { kind: "rejected", reason: "UNKNOWN_CORRELATION" };
    if (!a.open) return { kind: "rejected", reason: "ALREADY_RESOLVED" }; // single-use (replay-proof)
    if (a.principalId !== reply.principalId) return { kind: "rejected", reason: "WRONG_PRINCIPAL" };
    if (a.branchId !== branchId) return { kind: "rejected", reason: "BRANCH_MISMATCH" };

    if (reply.decision === "deny") {
      a.open = false;
      return { kind: "denied", correlationId: reply.correlationId };
    }

    // approval requires sufficient assurance for the effect class
    if (ASSURANCE_RANK[reply.assurance] < ASSURANCE_RANK[REQUIRED_ASSURANCE[a.effect]]) {
      // do NOT consume the await — a step-up can still satisfy it
      return { kind: "rejected", reason: "INSUFFICIENT_ASSURANCE" };
    }

    a.open = false; // consume — single-use
    return { kind: "authorized", correlationId: reply.correlationId };
  }

  isOpen(correlationId: string): boolean {
    return this.awaits.get(correlationId)?.open ?? false;
  }
}

/** A channel adapter contract — stateless transport. */
export interface ChannelAdapter {
  readonly name: string;
  /** render an outbound message (e.g. send to Telegram). Returns a delivery id. */
  send(threadId: string, text: string): Promise<string>;
}
