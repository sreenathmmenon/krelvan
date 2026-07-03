/**
 * `krelvan hello` — the first-run magic moment, in one command.
 *
 * Zero keys, zero config, no server, no model: builds a tiny real agent, runs it
 * through the real kernel against the real signed ledger, exports the run's proof
 * bundle, and immediately verifies that proof with the standalone offline verifier —
 * the same one command anyone else could run on the same file.
 *
 * The agent is deliberately deterministic (text_transform + remember, no LLM), so the
 * proof moment works in seconds on any machine. The full experience — describe an
 * agent in plain English, watch it run on the canvas — is `krelvan up`.
 */

import { writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

import { KrelvanRuntime } from "../api/runtime.js";
import type { Manifest } from "../core/manifest/manifest.js";

const HELLO_MANIFEST: Manifest = {
  version: 1,
  name: "Hello Krelvan",
  intent:
    "Prove the loop on first contact: run a real two-step agent and hold its signed, independently verifiable record.",
  entry: "greet",
  runBudgetCents: 10,
  maxNodeVisits: 2,
  seed: {
    text: "hello from your first krelvan agent",
    op: "upper",
    remember_map: "first_run=greet.text",
  },
  nodes: [
    {
      id: "greet",
      role: "Transform the greeting — a real, deterministic effect through the real capability pipeline.",
      autonomy: "full",
      capabilities: [{ name: "text_transform", sideEffect: "read", budgetCents: 5 }],
    },
    {
      id: "keepsake",
      role: "Remember the first run — a second effect class (a reversible write to the agent's memory).",
      autonomy: "full",
      capabilities: [{ name: "remember", sideEffect: "write-reversible", budgetCents: 5 }],
    },
  ],
  edges: [{ from: "greet", to: "keepsake" }],
};

export interface HelloResult {
  runId: string;
  status: string;
  events: number;
  proofPath: string;
  verifyExit: number;
}

/** Run the hello flow headless. Exported so tests can drive it without a subprocess. */
export async function runHello(dataDir: string, outDir: string): Promise<HelloResult> {
  const rt = new KrelvanRuntime({ dataDir, port: 0 });

  const imported = rt.importManifest(HELLO_MANIFEST);
  if (!imported.ok) throw new Error(`hello manifest rejected: ${imported.issues.join("; ")}`);

  const runId = `run-${Date.now()}-hello`;
  rt.runRegistry.create({ agentId: imported.agent.id, runId, manifestName: HELLO_MANIFEST.name });
  await rt.executeRun(runId, HELLO_MANIFEST, {}, imported.agent.id);
  const run = rt.runRegistry.get(runId);

  const exported = await rt.exportRun(runId);
  if (!exported.ok) throw new Error(`proof export failed: ${exported.error}`);
  const events = Array.isArray(exported.bundle["events"]) ? (exported.bundle["events"] as unknown[]).length : 0;

  const proofPath = join(outDir, `krelvan-proof-${runId}.json`);
  writeFileSync(proofPath, JSON.stringify(exported.bundle, null, 2));

  // Verify with the standalone verifier — the exact command a third party would run.
  const here = dirname(fileURLToPath(import.meta.url));
  const verifier = join(here, "..", "..", "bin", "krelvan-verify.mjs");
  const v = spawnSync(process.execPath, [verifier, proofPath], { stdio: "inherit", shell: false });

  return { runId, status: run?.status ?? "unknown", events, proofPath, verifyExit: v.status ?? -1 };
}

// ── CLI entry ─────────────────────────────────────────────────────────────────
const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const dataDir = process.env["KRELVAN_DATA_DIR"] ?? join(process.cwd(), "data");
  const t0 = Date.now();
  console.log("\nKrelvan — your first agent, in one run.\n");
  console.log("  1. Building a real 2-step agent (transform -> remember), signed manifest…");
  runHello(dataDir, process.cwd())
    .then((r) => {
      const secs = ((Date.now() - t0) / 1000).toFixed(1);
      console.log(`\n  2. Ran it: ${r.status} in ${secs}s — ${r.events} signed ledger events.`);
      console.log(`  3. Proof exported: ${r.proofPath}`);
      console.log(`  4. Verified above with the standalone verifier — the same check anyone can run:`);
      console.log(`\n       npx krelvan verify ${r.proofPath}\n`);
      console.log("  That file is portable, tamper-evident proof of exactly what the agent did.");
      console.log("  Next: `npx krelvan up` — describe your own agent in plain English.\n");
      process.exit(r.status === "completed" && r.verifyExit === 0 ? 0 : 1);
    })
    .catch((e) => {
      console.error("hello failed:", (e as Error).message);
      process.exit(1);
    });
}
