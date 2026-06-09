/**
 * The Agent Manifest — the declarative, model-agnostic program the user owns.
 *
 * The manifest declares INTENT, POLICY, and CAPABILITY-REFERENCES — never prompts,
 * weights, or vendor calls. The kernel interprets it; the LLM is a compiler into it
 * and a plugin behind it, never the substrate. The manifest + the ledger are the
 * two artifacts that compound across model generations.
 *
 * Guards:
 *  - MAN: conditional edges are a restricted expression (see expr.ts), NEVER eval.
 *  - MAN: every node declares the capabilities it may use; the kernel admits an
 *    effect only if the node's manifest grants it (capability monotonicity).
 *  - MAN: the manifest is validated structurally before any run (no dangling edges,
 *    exactly one resolvable entry, acyclic except declared loops with a bound).
 */

import type { Expr } from "./expr.js";

/** Side-effect class of a capability — drives admission + replay re-gating. */
export type SideEffectClass =
  | "read"
  | "write-reversible"
  | "write-irreversible"
  | "spend"
  | "message-human"
  | "identity-mutation";

/**
 * Sub-agent binding — pinned at manifest compile time.
 * `manifestId` is the resolved ID of the sub-agent manifest (from AgentRegistry).
 * `outputMapping` maps sub-agent public output keys → parent state keys.
 * `onSubFailure` controls whether a sub-run failure propagates to the parent or
 * is returned as a capability error the parent manifest can route around.
 */
export interface SubAgentBinding {
  /** The resolved, pinned manifest ID (set at compile time, never at runtime). */
  manifestId: string;
  /** Maps sub-agent output key → parent state key. */
  outputMapping: Record<string, string>;
  /** Default: "return-error" — parent gets EffectResult({ error }). */
  onSubFailure?: "propagate" | "return-error";
}

/** A capability a node is allowed to invoke, with its declared effect profile. */
export interface CapabilityRef {
  /** the capability/tool name, resolved to a plugin at run time */
  name: string;
  sideEffect: SideEffectClass;
  /** hard ceiling for this capability per run, in integer minor-units (cents). */
  budgetCents: number;
  /**
   * If set, this capability is backed by a sub-agent rather than a plugin.
   * The engine spawns a full sub-run instead of calling the Supervisor.
   * `budgetCents` becomes the sub-run's budget ceiling (reserve-then-settle).
   */
  subAgent?: SubAgentBinding;
}

/** A node = one agent in the workflow. */
export interface ManifestNode {
  id: string;
  /** human role (for the canvas); not executable. */
  role: string;
  /** capabilities this node may use (deny-by-default: anything not listed is denied). */
  capabilities: CapabilityRef[];
  /** the autonomy level governing this node's side effects. */
  autonomy: AutonomyLevel;
}

/** suggest = always ask; act-with-veto = do it but allow a countdown veto; full = autonomous. */
export type AutonomyLevel = "suggest" | "act-with-veto" | "full";

/** An edge. `when` is a restricted expression over run state; absent = unconditional. */
export interface ManifestEdge {
  from: string;
  to: string;
  when?: Expr;
}

export interface Manifest {
  /** schema version — migrations key off this (guards the "silent schema drift" failure). */
  version: 1;
  name: string;
  /** the original natural-language intent, for provenance (not executed). */
  intent: string;
  nodes: ManifestNode[];
  edges: ManifestEdge[];
  /** the entry node id. */
  entry: string;
  /** hard ceiling for the whole run, integer cents. */
  runBudgetCents: number;
  /** max times any single node may be (re)entered — bounds loops (anti-runaway). */
  maxNodeVisits: number;
  /**
   * Static initial state seeded into every run of this manifest.
   * Values here are merged with (and overridden by) any initialState passed at run-start.
   * Use this to embed URLs, configuration, or any other static inputs the agent always needs.
   */
  seed?: Record<string, string | number | boolean | null>;
}

export interface ValidationIssue {
  code: string;
  message: string;
}

/**
 * Structurally validate a manifest BEFORE any run. Returns all issues (empty = ok).
 * This is a pure function — no I/O.
 */
export function validateManifest(m: Manifest): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const ids = new Set<string>();

  if (m.version !== 1) issues.push({ code: "BAD_VERSION", message: `unsupported manifest version ${String(m.version)}` });
  if (!m.nodes.length) issues.push({ code: "NO_NODES", message: "manifest has no nodes" });

  for (const n of m.nodes) {
    if (ids.has(n.id)) issues.push({ code: "DUP_NODE", message: `duplicate node id '${n.id}'` });
    ids.add(n.id);
    if (!n.id) issues.push({ code: "EMPTY_NODE_ID", message: "a node has an empty id" });
  }

  if (!ids.has(m.entry)) issues.push({ code: "BAD_ENTRY", message: `entry '${m.entry}' is not a node` });

  for (const e of m.edges) {
    if (!ids.has(e.from)) issues.push({ code: "DANGLING_EDGE_FROM", message: `edge from unknown node '${e.from}'` });
    if (!ids.has(e.to)) issues.push({ code: "DANGLING_EDGE_TO", message: `edge to unknown node '${e.to}'` });
  }

  if (m.runBudgetCents < 0) issues.push({ code: "BAD_BUDGET", message: "runBudgetCents must be >= 0" });
  if (m.maxNodeVisits < 1) issues.push({ code: "BAD_MAX_VISITS", message: "maxNodeVisits must be >= 1" });

  // capability budgets must be non-negative integers (LED-02 spirit)
  for (const n of m.nodes) {
    for (const c of n.capabilities) {
      if (!Number.isInteger(c.budgetCents) || c.budgetCents < 0) {
        issues.push({ code: "BAD_CAP_BUDGET", message: `node '${n.id}' cap '${c.name}' budget must be a non-negative integer cents` });
      }
    }
  }

  return issues;
}

/** Look up a node by id. */
export function getNode(m: Manifest, id: string): ManifestNode | undefined {
  return m.nodes.find((n) => n.id === id);
}

/** Find the capability a node is allowed to use, or undefined (= denied). */
export function findCapability(node: ManifestNode, name: string): CapabilityRef | undefined {
  return node.capabilities.find((c) => c.name === name);
}
