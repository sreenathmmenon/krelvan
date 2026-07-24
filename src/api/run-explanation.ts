import type { LedgerEvent } from "../core/ledger/event.js";
import type { Manifest } from "../core/manifest/manifest.js";

export type ExplanationSource = "model" | "signed-record";

export interface ExplanationFacts {
  markdown: string;
  modelContext: string;
  nodeCount: number;
  eventCount: number;
}

function asObject(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function compactText(value: unknown, maxChars = 320): string {
  if (value === null || value === undefined) return "";
  const raw = typeof value === "string"
    ? value
    : typeof value === "number" || typeof value === "boolean"
      ? String(value)
      : "";
  const clean = raw.replace(/\s+/g, " ").trim();
  return clean.length > maxChars ? `${clean.slice(0, maxChars - 1).trimEnd()}…` : clean;
}

function observedResult(output: unknown): string {
  const obj = asObject(output);
  const preferred = ["result", "summary", "answer", "message", "text", "title"];
  for (const key of preferred) {
    const value = compactText(obj[key]);
    if (value) return value;
  }

  const scalarEntries = Object.entries(obj)
    .filter(([key, value]) =>
      key !== "thought" &&
      key !== "model" &&
      key !== "words" &&
      key !== "body" &&
      key !== "snippet" &&
      key !== "content" &&
      key !== "raw" &&
      (typeof value === "string" || typeof value === "number" || typeof value === "boolean"),
    )
    .slice(0, 5)
    .map(([key, value]) => `${key}=${compactText(value, 100)}`)
    .filter((entry) => !entry.endsWith("="));
  if (scalarEntries.length > 0) return scalarEntries.join("; ");

  const body = obj["body"];
  if (typeof body === "string" && body.length > 0) {
    return `captured a response containing ${body.length.toLocaleString("en-US")} characters`;
  }
  return "";
}

interface NodeFact {
  id: string;
  role: string;
  capabilities: string[];
  results: string[];
  entered: boolean;
  concluded: boolean;
}

/**
 * Build an explanation directly from the signed run record. It is both the no-model fallback
 * and the bounded, factual context handed to a model. Large connector bodies never enter this
 * prompt; only mechanically observed node/capability outcomes do.
 */
export function buildExplanationFacts(opts: {
  events: readonly LedgerEvent[];
  manifest: Manifest | null;
  agentName: string;
  status: string;
  failureReason?: string;
}): ExplanationFacts {
  const byId = new Map<string, NodeFact>();
  const order: string[] = [];
  const capabilityByIdem = new Map<string, string>();

  const ensure = (nodeId: string): NodeFact => {
    let fact = byId.get(nodeId);
    if (!fact) {
      const manifestNode = opts.manifest?.nodes.find((node) => node.id === nodeId);
      fact = {
        id: nodeId,
        role: manifestNode?.role ?? "",
        capabilities: [],
        results: [],
        entered: false,
        concluded: false,
      };
      byId.set(nodeId, fact);
      order.push(nodeId);
    }
    return fact;
  };

  for (const event of opts.events) {
    const nodeId = event.scope.nodeId;
    const payload = asObject(event.payload);
    if (event.type === "EffectRequested") {
      const idem = String(payload["idem"] ?? "");
      const capability = String(payload["capability"] ?? "");
      if (idem && capability) capabilityByIdem.set(idem, capability);
      if (nodeId && capability) {
        const fact = ensure(nodeId);
        if (!fact.capabilities.includes(capability)) fact.capabilities.push(capability);
      }
    } else if (event.type === "EffectResult" && nodeId) {
      const fact = ensure(nodeId);
      const capability = capabilityByIdem.get(String(payload["idem"] ?? ""));
      if (capability && !fact.capabilities.includes(capability)) fact.capabilities.push(capability);
      const result = observedResult(payload["output"]);
      if (result) fact.results.push(result);
    } else if (event.type === "NodeEntered" && nodeId) {
      ensure(nodeId).entered = true;
    } else if (event.type === "NodeConcluded" && nodeId) {
      ensure(nodeId).concluded = true;
    }
  }

  // Include manifest nodes that did not run, after the observed execution order. This makes a
  // halted/failed explanation explicit about what was not reached without inventing why.
  for (const node of opts.manifest?.nodes ?? []) ensure(node.id);

  const facts = order.map((id) => byId.get(id)!).filter(Boolean);
  const completed = opts.status === "completed";
  const failed = opts.status === "failed";
  const overall = completed
    ? `${opts.agentName} completed ${facts.filter((fact) => fact.concluded).length} of ${facts.length} planned steps.`
    : failed
      ? `${opts.agentName} stopped before completion${opts.failureReason ? `: ${compactText(opts.failureReason, 240)}` : "."}`
      : `${opts.agentName} is currently ${opts.status}.`;

  const stepLines = facts.map((fact) => {
    const state = fact.concluded ? "completed" : fact.entered ? "started but did not conclude" : "not reached";
    const capabilityText = fact.capabilities.length > 0
      ? ` Used ${fact.capabilities.map((capability) => `\`${capability}\``).join(", ")}.`
      : "";
    const resultText = fact.results.length > 0
      ? ` Observed result: ${fact.results.map((result) => compactText(result, 280)).join(" | ")}`
      : "";
    const roleText = compactText(fact.role, 220);
    return `- **${fact.id}** — ${state}.${roleText ? ` ${roleText}` : ""}${capabilityText}${resultText}`;
  });

  const markdown = [
    "## What happened",
    overall,
    "",
    "## Steps",
    ...(stepLines.length > 0 ? stepLines : ["- No node execution was recorded."]),
    "",
    "## Outcome",
    completed
      ? "The recorded run reached its completed state."
      : failed
        ? "The recorded run reached a failed state. Review the failed step above before retrying."
        : "The run has not reached a terminal state yet.",
  ].join("\n");

  // The model sees the same facts the fallback shows, capped per field above. This remains small
  // even when EffectResult contains a multi-megabyte connector body.
  const modelContext = [
    `Agent: ${opts.agentName}`,
    `Status: ${opts.status}`,
    `Recorded events: ${opts.events.length}`,
    opts.failureReason ? `Failure reason: ${compactText(opts.failureReason, 240)}` : "",
    "",
    ...stepLines,
  ].filter(Boolean).join("\n");

  return { markdown, modelContext, nodeCount: facts.length, eventCount: opts.events.length };
}

export function buildExplanationPrompt(facts: ExplanationFacts, maxChars = 16_000): string {
  const instruction = [
    "Explain this Krelvan agent run to a non-technical user using ONLY the mechanically observed facts below.",
    "Write: (1) a 1–2 sentence overview, (2) one bullet per node in the supplied order, and (3) the outcome.",
    "Preserve node and capability names. Do not invent missing outputs or infer that an unreached step ran.",
    "Do not mention cost, money, cents, dollars, budget, or spend.",
    "Return concise Markdown with headings and bullets.",
    "",
    "=== OBSERVED RUN FACTS ===",
  ].join("\n");
  const room = Math.max(0, maxChars - instruction.length - 1);
  const context = facts.modelContext.length > room
    ? `${facts.modelContext.slice(0, Math.max(0, room - 30)).trimEnd()}\n[context bounded by Krelvan]`
    : facts.modelContext;
  return `${instruction}\n${context}`;
}
