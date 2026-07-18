/**
 * "synthetic_users" capability — cast a spread of SYNTHETIC USERS for testing an agent.
 *
 * This is the composable half of Krelvan's testing story. The Rehearsal Room casts personas at a
 * whole agent from the UI (one-click, pre-ship). This capability exposes the SAME persona engine as
 * a node any agent can call, so a customer can build a *tester agent* that runs on a schedule:
 *
 *     cast (synthetic_users)  →  run_each (delegate: agentId=<target>)  →  grade (think)  →  report
 *
 * i.e. AGENTS THAT TEST OTHER AGENTS — cast tricky users, run them through the target, report where
 * it breaks. This is exactly the 2026 "persona-driven synthetic users + LLM-as-judge" pattern, made
 * no-code and schedulable.
 *
 * Input keys:
 *   scenario / topic / goal — what to test (e.g. "a password-reset support bot"). Required-ish;
 *                             falls back to the node's role or the run intent.
 *   count                   — how many users to cast (clamped 3..8, default 5).
 *   lens                    — optional focus: "adversarial" | "confused" | "edge_cases" | "mixed".
 *
 * Output:
 *   users    — [{ name, description, message }]  (structured; loop over these with delegate)
 *   messages — [string]                          (just the opening messages, convenience)
 *   count    — number
 *   summary  — a readable markdown list of the cast (human-facing / Inbox artifact)
 *   generated — true if the LLM cast them, false if the deterministic archetype fallback was used
 *
 * Side effect: "read" — generates test data only; sends/charges nothing.
 * Cost estimate: 10 cents per call.
 */

import type { CapabilityPlugin, EffectCall } from "../capability/capability.js";
import { getLLMClient, currentProvider, resolveModel } from "../../adapters/llm-client.js";
import { getLogger } from "../observability/logger.js";
import { generatePersonas, archetypeCast, type Persona } from "../../api/rehearsal/personas.js";

const log = getLogger("synthetic-users");

function hasLlm(): boolean {
  const provider = process.env["KRELVAN_LLM_PROVIDER"] ?? "anthropic";
  return provider === "ollama"
    || !!(process.env["KRELVAN_LLM_API_KEY"] || process.env["KRELVAN_ANTHROPIC_KEY"]);
}

// A value is a directive/role prompt, not a scenario subject, if it opens like a command. We prefer
// a concrete scenario; if only an instruction is available we still use it (personas read fine from
// a goal sentence), but we strip a leading "test/simulate/cast …" verb so the scenario stays clean.
function cleanScenario(s: string): string {
  return (s ?? "")
    .trim()
    .replace(/^\s*(?:please\s+)?(?:cast|generate|create|simulate|test|stress[- ]?test|rehearse|make|produce)\s+(?:\d+\s+)?(?:synthetic\s+)?(?:users?|personas?|testers?)\s+(?:for|to\s+test|against|of)?\s*/i, "")
    .replace(/[.:;]+\s*$/, "")
    .trim();
}

// Focus the cast toward a lens by nudging the scenario the persona generator sees. The generator
// always covers a spread, but this biases it (and the deterministic fallback slice) sensibly.
function applyLens(scenario: string, lens: string): string {
  switch (lens) {
    case "adversarial":
      return `${scenario} — focus on adversarial, red-team, and out-of-scope users who push the agent's limits`;
    case "confused":
      return `${scenario} — focus on confused, vague, and first-time users who leave out key details`;
    case "edge_cases":
      return `${scenario} — focus on edge cases: malformed input, missing data, and unusual requests`;
    default:
      return scenario;
  }
}

/** Render the cast as a clean, human-facing markdown list (the Inbox artifact for a cast-only run). */
export function summariseCast(users: Persona[], scenario: string): string {
  const heading = scenario ? `Synthetic users — ${scenario}` : "Synthetic users";
  const lines = users.map((u, i) => {
    const msg = u.seedMessage?.trim() ? `“${u.seedMessage.trim()}”` : "(empty / malformed input)";
    return `${i + 1}. **${u.name}** — ${u.description}\n   ${msg}`;
  });
  return [`## ${heading}`, "", ...lines].join("\n");
}

export const syntheticUsersCapability: CapabilityPlugin = {
  name: "synthetic_users",
  sideEffect: "read",

  estimateCents: () => 10,

  async invoke(call: EffectCall) {
    const input = call.input as Record<string, unknown>;

    // Scenario: an explicit key, else the node's role/goal, else the run intent.
    const raw = String(
      input["scenario"] ?? input["topic"] ?? input["goal"] ??
      input[`${call.nodeId}.role`] ?? input["role"] ?? input["intent"] ?? "",
    );
    const scenario = cleanScenario(raw) || "an AI agent";

    const count = Math.max(3, Math.min(8, Number(input["count"]) || 5));
    const lens = String(input["lens"] ?? "mixed").toLowerCase();
    const lensedScenario = applyLens(scenario, lens);

    let users: Persona[];
    let generated = false;
    if (hasLlm()) {
      try {
        const client = getLLMClient();
        const model = resolveModel(currentProvider(), "cheap");
        const res = await generatePersonas({ intent: lensedScenario, graphSummary: scenario, count, client, model });
        users = res.personas;
        generated = res.generated;
      } catch (err) {
        log.warn({ nodeId: call.nodeId, err: (err as Error)?.message }, "synthetic_users: LLM cast failed — using archetypes");
        users = archetypeCast(lensedScenario).slice(0, count);
      }
    } else {
      users = archetypeCast(lensedScenario).slice(0, count);
    }

    log.info({ nodeId: call.nodeId, scenario, count: users.length, generated }, "synthetic_users: cast");

    // Emit both the structured cast (to loop over with delegate) and a clean human-facing summary
    // (so a cast-only run still produces a readable Inbox artifact). `result`/`text` mirror the
    // summary for output-map/back-compat, like other read capabilities.
    const summary = summariseCast(users, scenario);
    return {
      output: {
        users: users.map((u) => ({ name: u.name, description: u.description, message: u.seedMessage })),
        messages: users.map((u) => u.seedMessage),
        count: users.length,
        summary,
        result: summary,
        text: summary,
        generated,
      },
      claimedCostCents: 10,
    };
  },
};
