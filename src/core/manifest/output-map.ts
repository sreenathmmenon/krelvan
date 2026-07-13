/**
 * output_map — the deterministic output declaration.
 *
 * Extracting an agent's deliverable output used to need a ~40-line heuristic that guessed
 * which state key held the "answer". This seed convention fixes it at the source, mirroring
 * `remember_map` (`factName=stateKey` pairs): an agent whose final node composes prose
 * declares exactly which state keys carry the title and body, so the artifact extractor
 * reads them directly instead of guessing.
 *
 *   "seed": { "output_map": "title=compose.title,body=compose.body,format=markdown" }
 *
 * This module is PURE (core rule): string → validated data, no I/O, no clock, no eval.
 * `body` is required (an output must have content); `title` and `format` are optional
 * (title defaults to absent → the extractor derives one; format defaults to "markdown",
 * since an agent that bothers to declare output is composing prose).
 */

export type OutputFormat = "markdown" | "text";

export interface OutputMap {
  /** state key holding the title, e.g. "compose.title". Absent when not declared. */
  titleKey?: string;
  /** state key holding the body, e.g. "compose.body". Always present. */
  bodyKey: string;
  /** render format; defaults to "markdown". */
  format: OutputFormat;
}

/** A state key: "nodeId.key" or a bare "key". Same shape remember_map accepts as a source. */
const KEY_RE = /^[a-z0-9_]+(\.[a-z0-9_]+)?$/i;

/**
 * Parse `seed.output_map`. Returns the declaration, or null when it is absent or malformed
 * (a bad declaration falls back to heuristic extraction — never throws). `seed` may be the
 * whole seed object or the raw string; anything without a usable `body` key yields null.
 */
export function parseOutputMap(
  seed: string | Record<string, unknown> | null | undefined,
): OutputMap | null {
  const raw = typeof seed === "string" ? seed : (seed && typeof seed === "object" ? seed["output_map"] : undefined);
  if (typeof raw !== "string" || !raw.trim()) return null;

  let titleKey: string | undefined;
  let bodyKey: string | undefined;
  let format: OutputFormat = "markdown";

  for (const pair of raw.split(",")) {
    const eq = pair.indexOf("=");
    if (eq <= 0) continue; // no "=", or empty left side → skip (malformed pair ignored)
    const field = pair.slice(0, eq).trim().toLowerCase();
    const value = pair.slice(eq + 1).trim();
    if (!value) continue;

    if (field === "title") {
      if (KEY_RE.test(value)) titleKey = value;
    } else if (field === "body") {
      if (KEY_RE.test(value)) bodyKey = value;
    } else if (field === "format") {
      if (value === "markdown" || value === "text") format = value;
    }
    // unknown field → ignored (forward-compatible)
  }

  if (!bodyKey) return null; // an output declaration without a body key is meaningless
  return { ...(titleKey ? { titleKey } : {}), bodyKey, format };
}

/**
 * The state keys an output_map references (for validation: does the referenced node exist?).
 * Returns [] when there is no valid map.
 */
export function outputMapKeys(seed: string | Record<string, unknown> | null | undefined): string[] {
  const m = parseOutputMap(seed);
  if (!m) return [];
  return [...(m.titleKey ? [m.titleKey] : []), m.bodyKey];
}
