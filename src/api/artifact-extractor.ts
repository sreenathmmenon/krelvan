/**
 * The ONE output extractor — shared by the Inbox/artifact store and by delivery.
 *
 * Given a completed run's manifest + final projection state, produce the deliverable
 * output (title, body, format) or null. Precedence:
 *
 *   1. output_map (A2): if the manifest's seed declares output_map and its body key
 *      resolves to a non-empty string in state, use it — title from titleKey (or derived
 *      from the body), format as declared. This is the deterministic path.
 *   2. Heuristic: otherwise the exact guessing logic the Inbox used to run client-side —
 *      a prose-suffix priority list, then the longest substantial string, then a
 *      notable-values line. Ported verbatim so behavior is byte-identical to what shipped.
 *      Format is always "text" for the heuristic (we did not declare it markdown).
 *
 * This module has no I/O and no clock — it is a pure function of (manifest, state), so it
 * is equally callable from the runtime, from delivery, and from tests.
 */

import type { Manifest } from "../core/manifest/manifest.js";
import { parseOutputMap, type OutputFormat } from "../core/manifest/output-map.js";

export interface ExtractedArtifact {
  title: string;
  body: string;
  format: OutputFormat;
}

/** Clamp a body down to a short, single-line-ish title. */
/**
 * A SHORT, human title for an output — never the whole body. Takes the first non-empty line,
 * strips leading markdown heading/list/emphasis markers, cuts to the first sentence, and caps at
 * ~70 chars on a word boundary. This keeps the title distinct from the body (a failure message or
 * a long paragraph must not become a giant, truncated headline that just repeats the body).
 */
function deriveTitle(body: string): string {
  let line = body.split("\n").map((l) => l.trim()).find((l) => l.length > 0) ?? body.trim();
  // strip leading markdown: #, >, -, *, 1. and surrounding ** emphasis
  line = line.replace(/^#{1,6}\s+/, "").replace(/^>\s+/, "").replace(/^[-*]\s+/, "").replace(/^\d+\.\s+/, "").trim();
  line = line.replace(/\*\*/g, "").replace(/[*_`]/g, "").trim();
  // first sentence, if the line is long
  const sentence = line.match(/^(.{20,}?[.!?])(\s|$)/);
  const firstSentence = sentence?.[1];
  if (firstSentence && firstSentence.length <= 80) line = firstSentence.trim();
  if (line.length <= 70) return line;
  // cut at a word boundary before 70 chars
  const cut = line.slice(0, 70);
  const lastSpace = cut.lastIndexOf(" ");
  return `${(lastSpace > 40 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.trim().length > 0;
}

/**
 * The heuristic fallback — a verbatim port of the Inbox's `extractOutput()`. Returns the
 * best-guess prose (or a notable-values summary) as { title, body } in "text" format, or
 * null when the run produced nothing worth surfacing.
 */
function extractHeuristic(state: Record<string, unknown>): { title: string; body: string } | null {
  const entries = Object.entries(state);
  // Prefer, in order: a *.result, a composed *.body/*.reply/*.answer/*.summary, else nothing.
  const pick = (suffixes: string[]): string | null => {
    for (const suf of suffixes) {
      const hit = entries.find(([k]) => k.endsWith(suf) && typeof state[k] === "string" && (state[k] as string).trim().length > 0);
      if (hit) return String(hit[1]);
    }
    return null;
  };
  const primary = pick([".result", ".briefing", ".body", ".reply", ".answer", ".digest", ".summary", ".message", ".note", ".text", ".output"]);
  if (primary) {
    const full = primary.trim();
    return { title: deriveTitle(full), body: full };
  }
  // Still nothing under a known key — a non-standard agent may put its answer under an unusual
  // key. Fall back to the LONGEST substantial string value in the state (real prose output) so a
  // genuine result never shows "No text output".
  const longest = entries
    .filter(([k, v]) => typeof v === "string" && !k.startsWith("_") && !/^seed\./.test(k))
    .map(([, v]) => (v as string).trim())
    .filter((s) => s.length >= 40)
    .sort((a, b) => b.length - a.length)[0];
  if (longest) {
    return { title: deriveTitle(longest), body: longest };
  }
  // No prose output — summarise the run's notable result values so the card still says
  // something ("price: $19.99 · ok: true") instead of looking empty.
  const notable = entries
    .filter(([k, v]) => (typeof v === "string" || typeof v === "number" || typeof v === "boolean")
      && !k.startsWith("_") && String(v).length > 0 && String(v).length < 120)
    .filter(([k]) => !/(url|email|_id|target|seed|message)$/i.test(k))
    .slice(0, 4)
    .map(([k, v]) => `${k.includes(".") ? k.split(".").pop() : k}: ${v}`);
  if (notable.length === 0) return null;
  const line = notable.join(" · ");
  return { title: line.length > 180 ? line.slice(0, 178) + "…" : line, body: line };
}

/**
 * Extract the deliverable artifact from a completed run. Returns null when the run
 * produced no surfaceable output (the caller then creates no artifact and delivers nothing).
 */
export function extractArtifact(
  manifest: Pick<Manifest, "seed">,
  state: Record<string, unknown>,
): ExtractedArtifact | null {
  // 1. output_map — deterministic, wins when its body key resolves to real content.
  const map = parseOutputMap(manifest.seed);
  if (map) {
    const bodyVal = state[map.bodyKey];
    if (isNonEmptyString(bodyVal)) {
      const body = bodyVal.trim();
      const titleVal = map.titleKey ? state[map.titleKey] : undefined;
      const title = isNonEmptyString(titleVal) ? titleVal.trim() : deriveTitle(body);
      return { title, body, format: map.format };
    }
    // output_map declared but its body key didn't resolve (e.g. a branch that didn't compose
    // prose) — fall through to the heuristic rather than emitting an empty artifact.
  }

  // 2. heuristic fallback — always "text".
  const h = extractHeuristic(state);
  if (!h) return null;
  return { title: h.title, body: h.body, format: "text" };
}
