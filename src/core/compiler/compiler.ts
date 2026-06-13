/**
 * The NL → Manifest compiler. "Describe an outcome, get a working agent."
 *
 * The LLM is an UNTRUSTED frontend: it proposes a manifest, but the compiler is the
 * trust boundary. The compiler:
 *  1. asks the (swappable) model port for a proposed manifest,
 *  2. structurally validates it,
 *  3. enforces CAPABILITY MONOTONICITY — the output's capabilities/budgets may never
 *     exceed what the requesting PRINCIPAL is authorized to grant. An untrusted-origin
 *     intent (from a channel, another agent, or memory) can NEVER widen scope. Only an
 *     owner-authority compile may grant new/wider capabilities. This is the front-door
 *     fix for prompt-injection-driven privilege escalation.
 *  4. validates conditional-edge expressions reference only declared keys,
 *  5. SIGNS the manifest (provenance: who compiled it, from what intent, at what time).
 *
 * The model port returns DATA (a manifest proposal), never executable code — there is
 * no eval anywhere in this path.
 */

import { canonicalize } from "../ledger/canonical.js";
import { contentAddress, type Signature, type Signer } from "../ledger/crypto.js";
import { referencedKeys } from "../manifest/expr.js";
import {
  validateManifest,
  type Manifest,
  type SideEffectClass,
  type ValidationIssue,
} from "../manifest/manifest.js";

/** What the (untrusted) model proposes. Same shape as Manifest. */
export type ManifestProposal = Manifest;

/** The model port — swappable. A real adapter calls an LLM; tests inject a fake. */
export interface ModelPort {
  propose(intent: string): Promise<ManifestProposal>;
}

/** The authority + grants of whoever requested the compile. */
export interface Principal {
  /** "owner" can widen grants; anything else is untrusted and may only narrow. */
  kind: "owner" | "channel" | "agent" | "memory";
  id: string;
  /** the maximum capabilities this principal may confer on a manifest. */
  allowedCapabilities: AllowedCapability[];
  /** the maximum total run budget this principal may confer, integer cents. */
  maxRunBudgetCents: number;
}

export interface AllowedCapability {
  name: string;
  sideEffect: SideEffectClass;
  maxBudgetCents: number;
  /** One-line description of what the capability does. */
  description?: string;
  /** Guidance for the compiler: when should this capability be chosen over others. */
  useWhen?: string;
  /** Extra notes injected into the compiler prompt (e.g. required seed keys). */
  notes?: string;
}

/** A signed, compiled manifest with provenance. */
export interface SignedManifest {
  manifest: Manifest;
  /** content address of the canonical manifest. */
  id: string;
  provenance: {
    intent: string;
    principalKind: Principal["kind"];
    principalId: string;
    compiledAt: number;
  };
  sig: Signature;
}

export type CompileResult =
  | { ok: true; signed: SignedManifest }
  | { ok: false; stage: "validate" | "monotonicity" | "expr"; issues: ValidationIssue[] };

export class Compiler {
  constructor(
    private readonly model: ModelPort,
    private readonly signer: Signer,
  ) {}

  async compile(intent: string, principal: Principal, now: number): Promise<CompileResult> {
    const proposal = await this.model.propose(intent);

    // 1. structural validation
    const vIssues = validateManifest(proposal);
    if (vIssues.length) return { ok: false, stage: "validate", issues: vIssues };

    // 2. capability monotonicity (the security core)
    const monoIssues = checkMonotonicity(proposal, principal);
    if (monoIssues.length) return { ok: false, stage: "monotonicity", issues: monoIssues };

    // 3. edge expressions reference only keys the manifest could produce.
    //    (We allow any key here but require it be referenced consistently; a richer
    //    check ties keys to node outputs once those are modeled. For now: collect
    //    referenced keys and ensure none is empty/malformed.)
    const exprIssues = checkExpressions(proposal);
    if (exprIssues.length) return { ok: false, stage: "expr", issues: exprIssues };

    // 4. sign with provenance
    const id = contentAddress(canonicalize(proposal as unknown));
    const provenance = {
      intent,
      principalKind: principal.kind,
      principalId: principal.id,
      compiledAt: now,
    };
    // bind the provenance into what we sign so it can't be swapped after the fact
    const signedPayload = contentAddress(canonicalize({ id, provenance }));
    const sig = this.signer.sign(signedPayload, now);

    return { ok: true, signed: { manifest: proposal, id, provenance, sig } };
  }
}

/**
 * CAPABILITY MONOTONICITY. The compiled manifest may grant a capability ONLY if the
 * principal is allowed to confer it, with a side-effect class that matches and a
 * budget that does not exceed the principal's ceiling. Untrusted principals
 * (kind != "owner") may never introduce a capability the owner hasn't pre-allowed,
 * and may never raise a budget.
 */
export function checkMonotonicity(m: Manifest, principal: Principal): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const allowed = new Map(principal.allowedCapabilities.map((c) => [c.name, c]));

  // run budget ceiling
  if (m.runBudgetCents > principal.maxRunBudgetCents) {
    issues.push({
      code: "BUDGET_ESCALATION",
      message: `manifest runBudget ${m.runBudgetCents}¢ exceeds principal max ${principal.maxRunBudgetCents}¢`,
    });
  }

  for (const node of m.nodes) {
    for (const cap of node.capabilities) {
      const a = allowed.get(cap.name);
      if (!a) {
        // A capability with a subAgent binding may use any name (it's a delegation slot,
        // not a plugin lookup). Require that the principal allows "delegate" to confer it.
        if (cap.subAgent) {
          const delegateAllowed = allowed.get("delegate");
          if (!delegateAllowed) {
            issues.push({
              code: "CAPABILITY_ESCALATION",
              message: `node '${node.id}' uses subAgent delegation but principal '${principal.id}' has not allowed 'delegate'`,
            });
          } else if (cap.budgetCents > delegateAllowed.maxBudgetCents) {
            issues.push({
              code: "SUBAGENT_BUDGET_ESCALATION",
              message: `node '${node.id}' subAgent cap '${cap.name}' budget ${cap.budgetCents}¢ exceeds delegate ceiling ${delegateAllowed.maxBudgetCents}¢`,
            });
          }
          // subAgent bindings must always be declared as "read" from the parent's perspective
          if (cap.sideEffect !== "read") {
            issues.push({
              code: "SUBAGENT_SIDE_EFFECT",
              message: `node '${node.id}' subAgent cap '${cap.name}' must declare sideEffect 'read' (sub-run enforces its own classes)`,
            });
          }
        } else {
          issues.push({
            code: "CAPABILITY_ESCALATION",
            message: `node '${node.id}' requests '${cap.name}' which principal '${principal.id}' may not confer`,
          });
        }
        continue;
      }
      if (cap.sideEffect !== a.sideEffect) {
        issues.push({
          code: "SIDE_EFFECT_MISMATCH",
          message: `node '${node.id}' cap '${cap.name}' declares side-effect '${cap.sideEffect}' but allowed is '${a.sideEffect}'`,
        });
      }
      if (cap.budgetCents > a.maxBudgetCents) {
        issues.push({
          code: "CAP_BUDGET_ESCALATION",
          message: `node '${node.id}' cap '${cap.name}' budget ${cap.budgetCents}¢ exceeds allowed ${a.maxBudgetCents}¢`,
        });
      }
    }
  }

  return issues;
}

function checkExpressions(m: Manifest): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  for (const e of m.edges) {
    if (!e.when) continue;
    const keys = referencedKeys(e.when);
    for (const k of keys) {
      if (!k || typeof k !== "string") {
        issues.push({ code: "BAD_EXPR_KEY", message: `edge ${e.from}->${e.to} references a malformed state key` });
      }
    }
  }
  return issues;
}
