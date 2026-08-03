import type { Manifest } from "../core/manifest/manifest.js";

export interface ManualRunInput {
  initialState?: Record<string, string | number | boolean | null>;
  message?: unknown;
  input?: unknown;
}

/**
 * Build the state supplied by a customer's manual run. `message` is the universal free-text
 * input. When a template carries a sample `query`, the live customer input also replaces that
 * sample so every downstream node reasons about and records the same question that retrieval
 * used. An explicit structured `initialState.query` still wins.
 */
export function manualRunInitialState(
  manifest: Manifest,
  body: ManualRunInput,
): Record<string, string | number | boolean | null> {
  const state: Record<string, string | number | boolean | null> = { ...(body.initialState ?? {}) };
  const userInput = typeof body.message === "string" ? body.message
    : typeof body.input === "string" ? body.input : "";
  const message = userInput.trim();
  if (!message) return state;

  if (state["message"] === undefined) state["message"] = message;
  if (manifest.seed?.["query"] !== undefined && state["query"] === undefined) {
    state["query"] = message;
  }
  return state;
}
