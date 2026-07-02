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
  /**
   * Opt-in PER-VISIT budgeting for retry loops. Default (unset/false) = PER-RUN: the cap's
   * budgetCents is a once-per-run ceiling and re-entering the node trips NODE_CAP_BUDGET_EXCEEDED
   * (byte-identical to legacy behavior; existing ledgers unchanged). When `loop: true`, budgetCents
   * is the cap for ONE visit, so an evaluator->generator back-edge can re-run the node; each visit
   * is bounded by budgetCents and the WHOLE loop is still bounded by runBudgetCents (the hard
   * aggregate ceiling) and maxNodeVisits (the anti-runaway visit bound). Worst-case per-cap spend =
   * budgetCents x maxNodeVisits, which manifest validation refuses to start unless it fits under
   * runBudgetCents.
   */
  loop?: boolean;
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

/**
 * Autonomy gradient (three genuinely distinct levels):
 * - "suggest"       — pause for human approval before ANY side effect.
 * - "act-with-veto" — act autonomously on REVERSIBLE writes; pause for approval on the
 *                     high-stakes classes (irreversible / spend / identity-mutation).
 * - "full"          — act autonomously on everything (no gate).
 */
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
  /**
   * Optional schedule — if present, installing this agent auto-arms it to run itself on a
   * cron expression or fixed interval. Makes "set it and forget it" agents (a price monitor,
   * a daily digest) genuinely self-running instead of needing a schedule wired up by hand.
   */
  schedule?: { kind: "cron"; expr: string } | { kind: "interval"; ms: number };
  /**
   * Optional builder-settable knobs — the template's "make it mine" surface.
   *
   * A template author declares which parts of the agent a BUILDER may customize when
   * cloning it for their own customer (rename it, point it at a different knowledge
   * base, change the tone, toggle auto-send vs approval) — without touching the graph.
   * A UI renders this block as a form; `applyCustomize` (customize.ts) bakes the chosen
   * settings into a fresh, self-contained manifest that installs as the builder's own
   * signed agent. Deny-by-default: only keys declared here are customizable.
   */
  customize?: Record<string, CustomizeField>;
}

/**
 * One builder-settable knob. Exactly ONE binding must be set:
 *  - `rename: true`       — the value becomes the cloned agent's display name.
 *  - `seedKey`            — the value is baked into manifest.seed[seedKey].
 *  - `autonomy`           — a toggle that flips a node's autonomy level (e.g. the
 *                           "send automatically?" switch: on="full", off="suggest").
 */
export interface CustomizeField {
  /** human label shown on the customize form */
  label: string;
  /** control kind + value validation: free text, one-of choice, or boolean toggle */
  type: "text" | "choice" | "toggle";
  /** for "choice": the allowed values (the form renders these as options) */
  options?: string[];
  /** prefill shown on the form; NOT auto-applied — an omitted setting leaves the template as-is */
  default?: string | number | boolean;
  /** bake the value into seed[seedKey] */
  seedKey?: string;
  /** toggle binding: flip node `nodeId`'s autonomy to `on` when true, `off` when false */
  autonomy?: { nodeId: string; on: AutonomyLevel; off: AutonomyLevel };
  /** this field renames the cloned agent (manifest.name) */
  rename?: boolean;
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

  if (Number(m.version) !== 1) issues.push({ code: "BAD_VERSION", message: `unsupported manifest version ${String(m.version)}` });
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

  // optional schedule — a cron expr (5 fields) or a positive interval
  if (m.schedule) {
    if (m.schedule.kind === "cron") {
      const fields = m.schedule.expr.trim().split(/\s+/);
      if (fields.length !== 5) issues.push({ code: "BAD_SCHEDULE", message: "cron schedule must be a 5-field expression" });
    } else if (m.schedule.kind === "interval") {
      if (!Number.isInteger(m.schedule.ms) || m.schedule.ms < 1000) issues.push({ code: "BAD_SCHEDULE", message: "interval schedule must be >= 1000 ms" });
    } else {
      issues.push({ code: "BAD_SCHEDULE", message: "schedule.kind must be 'cron' or 'interval'" });
    }
  }

  // capability budgets must be non-negative integers (LED-02 spirit)
  for (const n of m.nodes) {
    for (const c of n.capabilities) {
      if (!Number.isInteger(c.budgetCents) || c.budgetCents < 0) {
        issues.push({ code: "BAD_CAP_BUDGET", message: `node '${n.id}' cap '${c.name}' budget must be a non-negative integer cents` });
      }
    }
  }

  // optional customize block — every declared knob must be well-formed and bind to
  // something real, otherwise the customize form would silently do nothing (or worse,
  // applyCustomize would write into a node that does not exist).
  if (m.customize) {
    const AUTONOMY = new Set(["suggest", "act-with-veto", "full"]);
    for (const [key, f] of Object.entries(m.customize)) {
      if (!f.label) issues.push({ code: "BAD_CUSTOMIZE", message: `customize '${key}' has no label` });
      if (f.type !== "text" && f.type !== "choice" && f.type !== "toggle") {
        issues.push({ code: "BAD_CUSTOMIZE", message: `customize '${key}' type must be text | choice | toggle` });
      }
      if (f.type === "choice" && (!Array.isArray(f.options) || f.options.length === 0)) {
        issues.push({ code: "BAD_CUSTOMIZE", message: `customize '${key}' is a choice but declares no options` });
      }
      const bindings = [f.rename === true, typeof f.seedKey === "string" && f.seedKey.length > 0, f.autonomy !== undefined].filter(Boolean).length;
      if (bindings !== 1) {
        issues.push({ code: "BAD_CUSTOMIZE", message: `customize '${key}' must bind exactly one of rename | seedKey | autonomy` });
      }
      if (f.autonomy) {
        if (f.type !== "toggle") issues.push({ code: "BAD_CUSTOMIZE", message: `customize '${key}' binds autonomy so its type must be 'toggle'` });
        if (!ids.has(f.autonomy.nodeId)) issues.push({ code: "BAD_CUSTOMIZE", message: `customize '${key}' targets unknown node '${f.autonomy.nodeId}'` });
        if (!AUTONOMY.has(f.autonomy.on) || !AUTONOMY.has(f.autonomy.off)) {
          issues.push({ code: "BAD_CUSTOMIZE", message: `customize '${key}' autonomy on/off must be a valid autonomy level` });
        }
      }
      if (f.rename && f.type !== "text") issues.push({ code: "BAD_CUSTOMIZE", message: `customize '${key}' renames the agent so its type must be 'text'` });
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
