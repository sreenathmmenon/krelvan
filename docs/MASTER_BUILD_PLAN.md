# Krelvan — Master Build Plan (code-verified)

*Goal: bring the proven "Fiverr/Upwork-for-agents" demand onto Krelvan's rails — the 8 buyer
deliverables + the connectors + a marketplace people can contribute to — and make it a HIT on our
wedge: **own it + prove it** (signed ledger), free and self-hosted. This plan is grounded in a full,
file-cited read of the codebase, including the gaps that read surfaced.*

---

## PART I — What the code ACTUALLY supports today (the honest baseline)

A deep read of kernel, engine, manifest, compiler, runtime, scheduler, memory, secrets, API, web UI,
capability/plugin/registry layers. The good and the real gaps:

### ✅ Already real and strong
- **Multi-step agent graphs.** Manifest = nodes (each with an ordered capability list) + edges. Engine
  folds the ledger → pure `decide()` → executes → appends. (`engine.ts`, `kernel.ts`)
- **LLM reasoning as a node** (`think`) and **LLM routing** (`llm_route`) — a node *is* an agent, not
  just an API call. (`think.ts`, `llm-route.ts`)
- **State flows between nodes** as flat scalar keys `"nodeId.key"`. (`project.ts`)
- **Pause-for-approval + resume** is fully built and crash-safe (autonomy gradient → `AwaitRequested`
  → halt → `AwaitResolved` → re-fold). (`engine.ts`, `capability.ts`)
- **Bounded loops + sub-agents** (agent-as-capability with its own ledger). (`kernel.ts`,
  `sub-agent-executor.ts`)
- **Scheduling** — real cron + interval; a fire starts a full autonomous run, identical to
  `POST /api/runs`. (`scheduler.ts`, `runtime.ts:1357`)
- **Cross-run state** — `recall`/`remember` semantic memory on disk, per-agent, survives restart.
  This is the price-monitor's diff baseline. (`memory-plugins.ts`)
- **Secrets** — AES-256-GCM persistent store + env fallback, resolved into every run. (`secret-store.ts`)
- **External trigger** — `POST /api/runs {agentId, initialState}` runs async; webhook-style triggering
  already works. (`server.ts:387`)
- **The proof surface is built** — run view shows the signed ledger, timeline replay, HMAC-verified
  badge, explain/diagnose/retry-with-fix, inline HITL approve/deny. (`web/app/runs/[id]/page.tsx`)
- **14 built-in capabilities ship today:** `think, llm_route, compose, recall, remember, identify,
  web_search, http_get, http_post, notify_webhook, text_transform, email_send, telegram_send,
  slack_send`. Plus bundled YAML (deploy.*, github-dispatch, slack-notify, web-fetch…) and 7 registry
  entries (github/filesystem MCP, hn.top, weather, wikipedia, discord.notify, serp.search).

### ⚠️ Real gaps the read surfaced (these reshape the plan)
1. **Compiler can't emit conditional branches.** The LLM proposes an edge `condition` *string*, but
   nothing converts it to the `when` Expr AST — so **compiler-built edges are always unconditional**
   (`anthropic-model.ts:112-124`; the string is dropped). Branching works only in hand-authored
   manifests. → *Gating like "only alert IF price changed" must live inside a `think` node's
   reasoning today, OR we add condition→AST compilation.* **(Engine work.)**
2. **Same capability can't run twice in one node** — idempotency key is `hash(nodeId, capability)`,
   excluding input (`capability.ts:116`). "reason → tool → reason" = **three nodes**, not one.
3. **Run state is flat scalars only** — arrays/objects are silently dropped (`project.ts:127`). A RAG
   chunk-set or a lead list can't pass between nodes as structured data; must be stringified.
4. **No embeddings anywhere.** `LLMClient` has only `complete()` — no `embed()`. And the default
   provider (Anthropic) has **no** embeddings API. RAG needs `embed()` added + a non-Anthropic
   embeddings provider. (`llm-client.ts`)
5. **The marketplace installs CAPABILITIES, not AGENTS.** Registry kinds are `yaml | mcp` only; there
   is **no way to publish/install a whole agent** (graph + its capabilities + secrets). And there is
   **no API endpoint to register a pre-built manifest** — agents are created only via the NL builder.
   (`web/.../capabilities/page.tsx`, `lib/registry.ts`, `lib/api.ts`) **← THE biggest unlock + the
   biggest gap.**
6. **Canvas is read-only** — renders the manifest, can't edit it. No manifest-write path at all.
7. **Scheduler timers are in-memory `setTimeout`** — a process down at 08:00 **misses that fire** (no
   catch-up). Fine for v1, must be documented; durable scheduling is later work.
8. **LLM provider/model is global, not per-agent** — `CLAUDE.md`'s "per-agent model" is aspirational.
9. **Registry entries are escaped YAML strings inside one `index.json`** — painful to author; no CI
   validation actually runs (the README's "CI validates" is aspirational).
10. **Untrusted-TS enable gate still references the old worker risk** — first-party RAG should ship as
    a trusted built-in to avoid it; the egress broker injects `Bearer` only (Qdrant needs `api-key`).

### Verdict on "can we build the 8?"
**Yes — and the engine is more capable than I assumed (the `think` node was the load-bearing unknown,
and it's real).** Re-rated against the verified code:

| Agent | Buildable today | Needs | Confidence |
|---|---|---|---|
| **Competitor/price monitor** | Yes (gate inside `think`) | connectors only | **High** |
| **Content repurposer** | Yes | — | **High** |
| **SEO blog writer** | Yes | — | **High** |
| **Email triage + digest** | Yes | gate-in-think or condition-AST | **High** |
| **Meeting-notes → CRM/Notion** | Yes | 1 connector | **Med-High** |
| **Lead-gen pipeline** | Yes | connectors + approval (built) | **Medium** |
| **Invoice extract + reconcile** | Yes, harder | OCR/PDF input + logic | **Medium** |
| **RAG support chatbot** | Needs `embed()` + Qdrant plumbing | the real engineering | **Medium** |

Nothing is *blocked* by a missing primitive except RAG's embeddings. The big product gap is
**templates-as-installable-agents**, not agent capability.

---

## PART II — The build, in dependency order

Five workstreams. Each ships independently; sequenced so every step produces something demoable.

### W1 — Author + document the rails (unblocks contributors) — *small, do first*
- **W1.1** `docs/CAPABILITY_AUTHORING.md` — the YAML format, a copy-paste template, side-effect
  honesty, `egressHosts`, the publish-by-PR flow. (No code; highest leverage for the flywheel.)
- **W1.2** Add `egressHosts` to the registry entry schema so an `official` connector ships with its
  allowlist (Slack→`slack.com`), tightening security by default. (`registry/README.md` + install path.)
- **W1.3** Split registry entries from escaped-strings-in-`index.json` to per-file `capabilities/*.yaml`
  + a build step that inlines them. Author `registry.schema.json`. Add a PR-CI test that calls the
  *already-existing* pure validators (`validateYamlCapability`, `validateManifest`) — zero new deps.

### W2 — The connector pack (mostly YAML, zero new deps) — *the breadth*
Ship as bundled `capabilities/*.yaml` + `official` registry entries, each with honest `sideEffect`,
declared `secretRefs`, and `egressHosts`:
- **W2.1** `slack.post` (`chat.postMessage`, `xoxb` token) · `sheets.append`/`sheets.read`
  (service-account) · `notion.create_page` (`ntn_` token, pin `Notion-Version: 2025-09-03`).
- **W2.2** `hubspot.upsert_contact` (`batch/upsert`, idProperty=email) · `ghl.create_contact`
  (`Version: 2021-07-28` header) · `firecrawl.scrape` (`/v2/scrape`, markdown).
  *Validate HubSpot/GHL request bodies against a live account first — their docs render via JS so the
  research couldn't fully scrape them.*
- **W2.3** Gmail: ship `gmail.send` (access-token-in YAML) + a documented one-time refresh-token
  helper, OR a small Gmail MCP. Pick one, document the OAuth wrinkle honestly.

### W3 — RAG capability (the one real engineering item)
- **W3.1** Add `embed(texts): Promise<number[][]>` to `LLMClient` + OpenAI/Gemini/Ollama
  implementations; make embeddings provider independent of `KRELVAN_LLM_PROVIDER` (Anthropic can't
  embed — handle explicitly). (`llm-client.ts`)
- **W3.2** Extend the egress broker's `SecretInjector` to support a per-host header name (Qdrant uses
  `api-key`, not `Authorization: Bearer`). (`egress-broker.ts`, `subprocess-plugin-loader.ts`)
- **W3.3** Build `rag.ingest` (chunk→embed→upsert) + `rag.search` (embed→top-k) as **trusted built-ins**
  (`registerBuiltin`) so they skip the untrusted-TS enable gate, calling Qdrant Cloud + an embeddings
  host through the broker (both allowlisted). Note: self-hosted Qdrant on localhost is SSRF-blocked —
  document Qdrant Cloud for v1, microVM tier later.
- **W3.4** Adversarially test the RAG path through the broker (allowlist, secret-injection, size cap).

### W4 — Templates as first-class products (THE unlock) — *the HIT-maker*
This is what turns "a marketplace of parts" into "a marketplace of working agents people want."
- **W4.1** Add `kind: "template"` to the registry: `{ manifest (full Manifest object),
  requiredCapabilities[], secretRefs[] (union) }`. A publishable agent maps **1:1 to the existing
  `Manifest` type** — reuse `validateManifest()` as the validator.
- **W4.2** Backend: add `POST /api/agents/install` (register a pre-built signed manifest — the missing
  manifest-write endpoint) + transitive capability install + secret-union resolution.
- **W4.3** UI: an "Agents/Templates" section in Discover; install = install each missing capability →
  create agent from manifest → "set these N secrets to finish" step (reuse the `/secrets?name=`
  deep-link + the required-secrets to-do that already exist) → route to canvas/run. Reuse
  `FullMiniGraph` for the preview and `BuildPreviewModal` for review-before-run.
- **W4.4** Author the 4 flagship templates as **signed manifests** (gate logic inside `think` until
  W5 lands): **price-monitor (first)**, email-triage, lead-gen, RAG-support-bot.

### W5 — Engine hardening for richer agents (do as templates demand it)
- **W5.1** Compile the LLM's edge `condition` string → `when` Expr AST, so compiler-built agents can
  branch (not just hand-authored ones). Biggest single capability upgrade. (`anthropic-model.ts` +
  `expr.ts`) Add `contains`/`exists` ops for text-classification branches.
- **W5.2** (Optional) structured (non-scalar) state passing for RAG chunk-sets / lead lists, or a
  documented "stringify JSON into one scalar" convention.
- **W5.3** (Later) durable scheduling with missed-run catch-up; per-agent model selection.

---

## PART III — Portability & the contributor flywheel (how it becomes a HIT)

**Portable by construction — keep it that way:**
- YAML/MCP capabilities are pure data, Node-built-ins-only, **zero deps** — same on laptop/Docker/VPS.
- Secrets via `{{secret:NAME}}` → encrypted store/env, never inlined.
- Registry is a Git repo reachable by raw URL, overridable via `NEXT_PUBLIC_KRELVAN_REGISTRY_URL` — so
  a company runs a **private internal registry** (their own fork) = the enterprise/Bobcares/Infosys
  wedge. Document this as a first-class path.
- Templates are **signed manifests** — portable JSON that re-verifies on any install.
- Self-host every dependency the templates touch (Qdrant Apache-2.0; Firecrawl AGPL — note the AGPL
  caveat in its registry entry).

**The flywheel — make contributing irresistible:**
1. 10-minute publish path: `CAPABILITY_AUTHORING.md` + a `npx krelvan new-capability` scaffolder +
   local test command.
2. PR-CI validation on the registry repo (W1.3) → green check → merge → live in every install.
3. Trust tiers: `official` (signed by us, one-click) vs `community` (PR, risk-ack badge) — already in
   the schema; lean in with a clear "verified" badge.
4. **Templates, not just connectors, are publishable** (W4): a company publishes "Acme Support Bot" =
   manifest + its capabilities; a user installs the whole working agent. This is the "Steam/Fiverr-gig
   as a download" the thread predicted — but **free, self-hosted, and provable**.
5. Paid-but-you-own: the schema already supports `price` + `licenseUrl` — a vendor monetizes a premium
   connector via the user's own key, **we never touch the money or lock the user in**. The opposite of
   the gig platforms.

**The launch narrative:** *"The agent marketplaces want to rent you agents. Krelvan lets you own one —
describe the job, get a real signed agent, run it on your own box, and prove what it did. Here are 8
agents people pay freelancers to build, free and yours to keep."* Homepage hero = the **price-monitor
with its signed-ledger receipt** — the most visceral "an agent did a real job, here's proof" demo.

---

## PART IV — Recommended sequence (so confidence is anchored in running code)

1. **Proof slice first** (smallest end-to-end HIT): W1.1 (authoring doc) + W2.1 `slack.post` +
   `firecrawl.scrape` + W4.4 **price-monitor template authored as a signed manifest** + W4.2 manifest
   install endpoint. Outcome: a real, recognizable, *signed* agent installs in one click and runs on a
   schedule. **This validates the entire thesis on a running thing before we scale.**
2. **Breadth**: the rest of W2 (connectors) + W1.2/W1.3 (registry hardening + CI).
3. **The unlock at full strength**: W4 templates UI + the other 3 templates.
4. **RAG**: W3 (the one real engineering block).
5. **Richer agents**: W5 (condition-AST so compiled agents branch).

**My honest confidence:** High on connectors + price-monitor/content/SEO/email templates + the
template-install mechanism (the data model already exists as `Manifest`). Medium on RAG (needs
`embed()` + broker tweak) and on *reliability against messy real-world data* — the same risk every
platform in that thread has, but here the signed ledger turns failures into *provable* failures, which
is a feature. Nothing in the 8 is blocked by a missing primitive except RAG embeddings.

---

## Appendix — the five code-verified investigations behind this plan
Execution core (engine/manifest/compiler/think); API/runtime/scheduler/memory/secrets; web UI
(builder/canvas/runs/discover); capability/plugin/registry/LLM-adapter. All gaps in Part I were found
by reading the actual files (citations in the task transcript). Prior research docs:
`docs/MARKETPLACE_RESEARCH.md` (the landscape), `docs/MARKETPLACE_BUILD_PLAN.md` (connectors + template
detail).
