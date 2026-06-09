/**
 * A sample run — the exact event shape the engine produces (a 3-node content
 * pipeline: research → write → deliver). Used to render the UI before the backend
 * API is wired. Replacing this with a fetch from the core changes nothing in the
 * views, because the views are pure folds.
 */

import type { LedgerEvent, RunMeta } from "./ledger";

export const sampleRunMeta: RunMeta = {
  runId: "run-42",
  tenantId: "acme",
  manifestName: "daily-ai-news-brief",
  intent: "Every morning, research the top AI news and send me a short brief.",
  status: "completed",
  budgetCents: 50,
};

let off = 0;
let t = 1_717_000_000;
const ev = (e: Omit<LedgerEvent, "offset" | "ts" | "id">): LedgerEvent => ({
  ...e,
  offset: off++,
  ts: (t += 1),
  id: "sha256:" + Math.abs(hash(`${off}:${e.type}:${e.nodeId ?? ""}`)).toString(16).padStart(12, "0"),
});
function hash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  return h;
}

export const sampleEvents: LedgerEvent[] = [
  ev({ type: "RunStarted", author: "owner", payload: { manifest: "daily-ai-news-brief" } }),

  ev({ type: "NodeEntered", nodeId: "research", author: "owner", payload: {} }),
  ev({ type: "AdmissionDecision", nodeId: "research", author: "owner", payload: { capability: "web_search", admitted: true, reservedCents: 8, idem: "research:web_search:1" } }),
  ev({ type: "EffectRequested", nodeId: "research", author: "owner", payload: { capability: "web_search", idem: "research:web_search:1" } }),
  ev({ type: "EffectResult", nodeId: "research", author: "supervisor", payload: { idem: "research:web_search:1", capability: "web_search", costCents: 8, output: { sources: 5 } } }),
  ev({ type: "NodeConcluded", nodeId: "research", author: "owner", payload: {} }),

  ev({ type: "NodeEntered", nodeId: "write", author: "owner", payload: {} }),
  ev({ type: "AdmissionDecision", nodeId: "write", author: "owner", payload: { capability: "compose", admitted: true, reservedCents: 6, idem: "write:compose:1" } }),
  ev({ type: "EffectRequested", nodeId: "write", author: "owner", payload: { capability: "compose", idem: "write:compose:1" } }),
  ev({ type: "EffectResult", nodeId: "write", author: "supervisor", payload: { idem: "write:compose:1", capability: "compose", costCents: 6, output: { words: 480 } } }),
  ev({ type: "NodeConcluded", nodeId: "write", author: "owner", payload: {} }),

  ev({ type: "NodeEntered", nodeId: "deliver", author: "owner", payload: {} }),
  ev({ type: "AdmissionDecision", nodeId: "deliver", author: "owner", payload: { capability: "telegram_send", admitted: true, reservedCents: 1, idem: "deliver:telegram_send:1" } }),
  ev({ type: "EffectRequested", nodeId: "deliver", author: "owner", payload: { capability: "telegram_send", idem: "deliver:telegram_send:1" } }),
  ev({ type: "EffectResult", nodeId: "deliver", author: "supervisor", payload: { idem: "deliver:telegram_send:1", capability: "telegram_send", costCents: 1, output: { delivered: true } } }),
  ev({ type: "NodeConcluded", nodeId: "deliver", author: "owner", payload: {} }),

  ev({ type: "RunCompleted", author: "owner", payload: {} }),
];

/** The node order, for the canvas. */
export const sampleNodeOrder = ["research", "write", "deliver"];
