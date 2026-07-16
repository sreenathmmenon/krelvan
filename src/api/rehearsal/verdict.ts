/**
 * The verdict layer — objective facts first, model nuance second.
 *
 * A rehearsal's headline verdict and its "look at this" findings are computed by RULES over facts
 * the ledger already knows: did the run finish, park for approval, loop to its visit cap, or fail;
 * which consequential effects WOULD have fired; how close the budget got. The LLM judge only adds
 * a soft read on top — it never decides the facts. This split keeps the report trustworthy even
 * when the judge is wrong.
 */
import type { RunStatus } from "../runtime.js";
import type { SuppressedEffect } from "./synthetic-supervisor.js";

/** The compact, objective input the rule layer reasons over — assembled by the driver. */
export interface RehearsalOutcome {
  status: RunStatus;
  reason?: string;
  /** consequential effects the synthetic layer recorded instead of performing. */
  suppressed: SuppressedEffect[];
  /** did the run park for a human approval (an open await)? */
  parkedForApproval: boolean;
  /** any node that reached the manifest's maxNodeVisits (a runaway loop). */
  cappedNodes: string[];
  /** cents the run would have reserved/spent (from the budget projection). */
  spentCents: number;
  /** the run's hard budget ceiling, for the "nearly blown" check. */
  budgetCents: number;
}

/** The one-word headline for a persona's rehearsal. */
export type Verdict = "completed" | "parked" | "looped" | "failed";

export type FindingLevel = "ok" | "warn" | "stop";

export interface Finding {
  level: FindingLevel;
  /** stable machine tag so the UI/regression-diff can compare findings across runs. */
  code: string;
  message: string;
}

export interface RehearsalJudgement {
  verdict: Verdict;
  findings: Finding[];
}

/** The headline verdict, from status + objective signals (parking beats a bare "completed"). */
export function verdictOf(o: RehearsalOutcome): Verdict {
  if (o.status === "failed") return o.cappedNodes.length > 0 ? "looped" : "failed";
  if (o.parkedForApproval || o.status === "halted") return "parked";
  return "completed";
}

/**
 * The rule layer: turn an outcome into findings a human should look at before going live. Pure and
 * deterministic — no model. Ordered most-severe first.
 */
export function judgeRehearsal(o: RehearsalOutcome): RehearsalJudgement {
  const findings: Finding[] = [];

  // STOP — a runaway loop that blew the visit cap.
  if (o.cappedNodes.length > 0) {
    findings.push({
      level: "stop",
      code: "visit_cap_loop",
      message: `${o.cappedNodes.length === 1 ? "A step" : `${o.cappedNodes.length} steps`} re-entered until the visit limit and then stopped (${o.cappedNodes.join(", ")}). Add a guard or an early exit.`,
    });
  } else if (o.status === "failed") {
    findings.push({
      level: "stop",
      code: "run_failed",
      message: o.reason ? `The run failed: ${o.reason}` : "The run failed before finishing.",
    });
  }

  // WARN — consequential effects that WOULD have fired in production.
  if (o.suppressed.length > 0) {
    const byKind = new Map<string, number>();
    for (const s of o.suppressed) byKind.set(s.capability, (byKind.get(s.capability) ?? 0) + 1);
    const summary = [...byKind.entries()].map(([cap, n]) => `${n}× ${cap}`).join(", ");
    findings.push({
      level: "warn",
      code: "would_send",
      message: `In production this would have performed ${o.suppressed.length} real action${o.suppressed.length === 1 ? "" : "s"} (${summary}). Confirm that's intended.`,
    });
  }

  // WARN — parked for a human. Right for high-stakes steps, but worth confirming the flow.
  if (o.parkedForApproval || o.status === "halted") {
    findings.push({
      level: "warn",
      code: "parked_for_approval",
      message: "This stopped to ask a human before acting. That's the gate working — confirm it's the flow you want.",
    });
  }

  // WARN — budget nearly blown (≥ 80% of the ceiling).
  if (o.budgetCents > 0 && o.spentCents >= o.budgetCents * 0.8) {
    findings.push({
      level: "warn",
      code: "budget_near_limit",
      message: "This run used most of its budget ceiling. A heavier real input could tip it over.",
    });
  }

  // OK — clean completion with nothing consequential.
  if (findings.length === 0 && o.status === "completed") {
    findings.push({ level: "ok", code: "clean", message: "Finished cleanly. No real actions, no loops, budget comfortable." });
  }

  // Always reassure: a rehearsal ships nothing.
  findings.push({ level: "ok", code: "nothing_delivered", message: "Nothing was sent, charged, or written — this was a rehearsal." });

  // Most-severe first: stop, then warn, then ok.
  const rank: Record<FindingLevel, number> = { stop: 0, warn: 1, ok: 2 };
  findings.sort((a, b) => rank[a.level] - rank[b.level]);

  return { verdict: verdictOf(o), findings };
}
