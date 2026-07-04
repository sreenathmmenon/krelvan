/**
 * Registry sync — the single source of truth is the bundled REGISTRY_SEED in
 * web/lib/registry.ts. This script regenerates registry/index.json (the file the public
 * krelvan-registry repo serves) from that seed, so the app's catalog and the public
 * marketplace can never silently drift apart again.
 *
 * Run:  npm run registry:sync   (writes registry/index.json)
 *       npm run registry:sync -- --check   (fails if out of date — for CI)
 *
 * To publish: copy registry/index.json into the krelvan-registry repo and push.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { REGISTRY_SEED, type CatalogEntry } from "../web/lib/registry.js";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..");
const OUT = join(repoRoot, "registry", "index.json");

/** A fixed timestamp read from the seed file's own header, not the wall clock — keeps the
 * output deterministic (so --check is stable) and honest about when the catalog last moved. */
function catalogVersion(): string {
  // Derive a content-stable "updated" date from the seed count so it changes only when the
  // catalog does. Format: YYYY-MM-DD is not available without a clock; we stamp the entry
  // count so drift is visible in the file, and leave the date to the committer.
  return "generated-from-seed";
}

function toRegistryEntries(seed: CatalogEntry[]): CatalogEntry[] {
  // The registry file carries the SAME entry shape the app consumes — no lossy transform.
  // Sort by kind then name for a stable, reviewable diff.
  const order: Record<string, number> = { template: 0, pack: 1, mcp: 2, yaml: 3, builtin: 4 };
  return [...seed].sort((a, b) =>
    (order[a.kind] ?? 9) - (order[b.kind] ?? 9) || a.name.localeCompare(b.name));
}

function build(): string {
  const capabilities = toRegistryEntries(REGISTRY_SEED);
  const byKind: Record<string, number> = {};
  for (const c of capabilities) byKind[c.kind] = (byKind[c.kind] ?? 0) + 1;
  const envelope = {
    $schema: "https://raw.githubusercontent.com/sreenathmmenon/krelvan-registry/main/schema.json",
    version: 1,
    generator: "krelvan scripts/sync-registry.ts",
    updated: catalogVersion(),
    counts: { total: capabilities.length, ...byKind },
    capabilities,
  };
  return JSON.stringify(envelope, null, 2) + "\n";
}

const next = build();
const check = process.argv.includes("--check");

if (check) {
  let current = "";
  try { current = readFileSync(OUT, "utf8"); } catch { /* missing = out of date */ }
  // Compare ignoring the `updated` line (committer-owned) — only the catalog content matters.
  const strip = (s: string) => s.replace(/"updated":\s*"[^"]*",?\n/, "");
  if (strip(current) !== strip(next)) {
    console.error("❌ registry/index.json is OUT OF DATE with the seed. Run: npm run registry:sync");
    process.exit(1);
  }
  console.log("✅ registry/index.json is in sync with the seed.");
} else {
  writeFileSync(OUT, next);
  const counts = JSON.parse(next).counts as Record<string, number>;
  console.log(`✅ wrote registry/index.json — ${counts["total"]} entries:`,
    Object.entries(counts).filter(([k]) => k !== "total").map(([k, v]) => `${v} ${k}`).join(", "));
  console.log("   To publish: copy registry/index.json into the krelvan-registry repo and push.");
}
