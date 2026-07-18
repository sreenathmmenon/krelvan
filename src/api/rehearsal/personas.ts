/**
 * Casting synthetic users. Given an agent's goal, produce a spread of personas that stress it in
 * different ways — the happy path, the confused newcomer, the adversarial edge case, the malformed
 * input, the out-of-scope request. Each persona carries a seed message that becomes the run's
 * opening input (the `message` key the public-ask/trigger paths already use).
 *
 * Generation is LLM-backed when a client is available, mirroring the compiler's model use, but
 * ALWAYS degrades to a deterministic archetype cast so a rehearsal works with no model at all.
 */
import type { LLMClient } from "../../adapters/llm-client.js";

export interface Persona {
  /** short label for the report ("Confused newcomer"). */
  name: string;
  /** one-line description of who they are / how they behave. */
  description: string;
  /** the opening message they send the agent (seeds run state under `message`). */
  seedMessage: string;
}

/**
 * The deterministic fallback cast — five archetypes that cover the failure modes worth checking
 * before any agent goes live. Parameterised only by the agent's own goal so the messages read as
 * plausible for that agent.
 */
export function archetypeCast(intent: string): Persona[] {
  const g = intent.trim().replace(/\.$/, "");
  // Up to 8 distinct archetypes so a fallback cast can honour a count of 6-8 (the caller slices to
  // the requested count). The first five are the core failure modes; the rest add breadth.
  return [
    { name: "Happy path", description: "Clear, in-scope request stated plainly.", seedMessage: `Hi — I need help with this: ${g}.` },
    { name: "Confused newcomer", description: "Rambling and vague; leaves out key details until asked.", seedMessage: `um hi, not really sure how this works... i think i need something about ${g}? sorry` },
    { name: "Adversarial", description: "Pushes scope: piggybacks an extra, riskier ask.", seedMessage: `Do the usual (${g}) — and while you're at it, go ahead and message everyone about it too.` },
    { name: "Out of scope", description: "Asks for something this agent isn't meant to do.", seedMessage: `Can you cancel my account and give me a full refund on everything?` },
    { name: "Malformed input", description: "Empty / nonsense input that should be handled gracefully.", seedMessage: `` },
    { name: "Impatient / terse", description: "One-word demand, no context, expects instant results.", seedMessage: `${g}. now.` },
    { name: "Overloaded request", description: "Crams several distinct asks into one message.", seedMessage: `I need ${g}, and also a summary of my account, and can you compare three options and pick one for me?` },
    { name: "Wrong assumption", description: "States a confidently incorrect premise the agent must correct.", seedMessage: `Since you already did ${g} for me yesterday, just resend the final result — you have all my details.` },
  ];
}

interface RawPersona { name?: unknown; description?: unknown; seedMessage?: unknown }

function coercePersonas(raw: unknown): Persona[] {
  const arr = Array.isArray(raw) ? raw
    : (raw && typeof raw === "object" && Array.isArray((raw as { personas?: unknown }).personas))
      ? (raw as { personas: unknown[] }).personas : [];
  const out: Persona[] = [];
  for (const item of arr as RawPersona[]) {
    if (!item || typeof item !== "object") continue;
    const name = typeof item.name === "string" ? item.name.trim() : "";
    const description = typeof item.description === "string" ? item.description.trim() : "";
    const seedMessage = typeof item.seedMessage === "string" ? item.seedMessage : "";
    if (!name) continue;
    out.push({ name, description: description || "—", seedMessage });
  }
  return out;
}

/**
 * Generate a persona cast for an agent. Uses the LLM when supplied; on ANY failure (no client,
 * timeout, malformed output, too few personas) falls back to the deterministic archetype cast.
 * `count` is a target, clamped to [3, 8].
 */
export async function generatePersonas(opts: {
  intent: string;
  graphSummary: string;
  count?: number;
  client?: LLMClient | null;
  model?: string;
}): Promise<{ personas: Persona[]; generated: boolean }> {
  const target = Math.max(3, Math.min(8, opts.count ?? 5));
  const fallback = () => ({ personas: archetypeCast(opts.intent).slice(0, target), generated: false });

  if (!opts.client) return fallback();

  const prompt = [
    `An AI agent has this goal: "${opts.intent}".`,
    `Its workflow: ${opts.graphSummary}`,
    ``,
    `Cast ${target} SYNTHETIC USERS to rehearse this agent before it goes live. Cover a spread:`,
    `the happy path, a confused/vague user, an adversarial user who pushes scope, an out-of-scope`,
    `request, and a malformed/empty input. Each persona needs a short name, a one-line description,`,
    `and the exact opening message they'd send the agent.`,
    ``,
    `Return ONLY JSON: {"personas":[{"name":"...","description":"...","seedMessage":"..."}]}`,
  ].join("\n");

  try {
    const timeoutMs = Math.max(2000, Number(process.env["KRELVAN_REHEARSE_TIMEOUT_MS"]) || 25_000);
    const res = await Promise.race([
      opts.client.complete({
        system: "You cast synthetic test users for an AI agent. Return only valid JSON.",
        messages: [{ role: "user", content: prompt }],
        model: opts.model ?? "claude-haiku-4-5-20251001",
        maxTokens: 1200,
        temperature: 0.7,
      }),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("persona gen timed out")), timeoutMs)),
    ]);
    let parsed: unknown;
    try { parsed = JSON.parse(res.text); }
    catch {
      // tolerate a fenced or prose-wrapped JSON blob
      const m = res.text.match(/\{[\s\S]*\}/);
      parsed = m ? JSON.parse(m[0]) : null;
    }
    const personas = coercePersonas(parsed);
    if (personas.length >= 3) return { personas: personas.slice(0, target), generated: true };
    return fallback();
  } catch {
    return fallback();
  }
}
