/**
 * The rehearsal report — the deliverable. A cast of synthetic users, each persona's verdict and
 * findings, and a roll-up the UI can headline: how many completed, parked, looped or failed, and
 * the single most important thing to look at before going live. Pure assembly; no I/O.
 */
import type { Persona } from "./personas.js";
import type { RehearsalJudgement, Verdict, Finding, FindingLevel } from "./verdict.js";

export interface PersonaResult {
  persona: Persona;
  /** the rehearsal run's id (empty if the rehearsal itself errored before running). */
  runId: string;
  judgement: RehearsalJudgement;
}

export interface RehearsalReport {
  rehearsalId: string;
  agentId: string;
  agentName: string;
  createdAt: number;
  /** true if the persona cast came from the model; false if the deterministic archetypes were used. */
  personasGenerated: boolean;
  results: PersonaResult[];
  rollup: {
    total: number;
    byVerdict: Record<Verdict, number>;
    /** counts of findings by severity across all personas (deduped by code within a persona). */
    findingCounts: Record<FindingLevel, number>;
    /** the single most severe finding to headline, if any (a stop beats a warn). */
    headline: Finding | null;
    /** true when a rehearsal produced at least one STOP-level finding — the "don't ship yet" signal. */
    hasBlocker: boolean;
  };
}

const RANK: Record<FindingLevel, number> = { stop: 0, warn: 1, ok: 2 };

export function buildReport(input: {
  rehearsalId: string;
  agentId: string;
  agentName: string;
  createdAt: number;
  personasGenerated: boolean;
  results: PersonaResult[];
}): RehearsalReport {
  const byVerdict: Record<Verdict, number> = { completed: 0, parked: 0, looped: 0, failed: 0 };
  const findingCounts: Record<FindingLevel, number> = { stop: 0, warn: 0, ok: 0 };
  let headline: Finding | null = null;

  for (const r of input.results) {
    byVerdict[r.judgement.verdict] += 1;
    // Count each finding level once per persona per code, and track the most-severe overall.
    for (const f of r.judgement.findings) {
      findingCounts[f.level] += 1;
      if (f.level !== "ok" && (headline === null || RANK[f.level] < RANK[headline.level])) {
        headline = f;
      }
    }
  }

  return {
    rehearsalId: input.rehearsalId,
    agentId: input.agentId,
    agentName: input.agentName,
    createdAt: input.createdAt,
    personasGenerated: input.personasGenerated,
    results: input.results,
    rollup: {
      total: input.results.length,
      byVerdict,
      findingCounts,
      headline,
      hasBlocker: findingCounts.stop > 0,
    },
  };
}
