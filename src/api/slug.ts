/**
 * Agent slugs — the stable, URL-safe public identity used in /a/:slug and
 * /api/public/agents/:slug. Pure string logic (no I/O), so it is trivially testable.
 *
 * A slug is lowercase, hyphen-separated, ASCII-only. Collisions get a short random suffix
 * (never a predictable counter — the slug is the public handle, so it should not enumerate
 * how many agents share a name).
 */

/** Turn a display name into a slug. Returns "agent" when nothing survives normalization. */
export function slugify(name: string): string {
  const s = name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")   // strip combining marks
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")       // non-alphanumerics → hyphen
    .replace(/^-+|-+$/g, "")           // trim leading/trailing hyphens
    .replace(/-{2,}/g, "-")            // collapse repeats
    .slice(0, 60);                     // keep URLs sane
  return s || "agent";
}

/**
 * A unique slug for `name`, given the set of slugs already taken. If the base slug is free
 * it is returned as-is; otherwise a 4-char base36 suffix is appended (retried until free).
 * `rand` is injectable for deterministic tests (defaults to Math.random via base36).
 */
export function uniqueSlug(name: string, taken: ReadonlySet<string>, rand: () => string = () => Math.random().toString(36).slice(2, 6)): string {
  const base = slugify(name);
  if (!taken.has(base)) return base;
  // Bounded retry — with a 36^4 space collisions are astronomically unlikely, but never loop forever.
  for (let i = 0; i < 1000; i++) {
    const suffix = rand().replace(/[^a-z0-9]/g, "").slice(0, 4).padEnd(4, "0");
    const candidate = `${base}-${suffix}`;
    if (!taken.has(candidate)) return candidate;
  }
  // Fallback: guaranteed-unique by length (extremely unreachable).
  return `${base}-${taken.size.toString(36)}`;
}
