# Krelvan Marketplace — The Complete Build Plan

*From the "Fiverr/Upwork for AI agents" research → a concrete, portable, contributor-driven plan
to seed the 4 highest-demand templates + 7 connectors, grounded in how Krelvan's capability system
actually works. Goal: make the product a HIT by bringing the market's known demand onto our rails —
free, open-source, self-hosted, and **provable** (the signed ledger nobody else has).*

---

## 0. The one strategic idea

Every competitor (agent.ai, MuleRun, UpAgents, ClawGig, Dealwork…) sells **convenience** behind a
paywall. We sell **ownership + proof**. So we don't need to invent new agent types — the market has
already told us exactly what it wants. We need to:

1. **Ship the work people already pay for** (4 templates, 7 connectors) so a new user lands on
   something they recognize from Fiverr and it *just runs*.
2. **Make every one of those a `read`/`write` capability whose effects are signed to the ledger**, so
   the user can prove what the agent did — the wedge.
3. **Make contributing a new capability a 10-minute PR**, so companies/devs/products pile their own
   connectors onto our registry (the plugin CMS-for-agents flywheel).

---

## 1. How Krelvan capabilities ACTUALLY work (the ground truth)

*(Verified against the code — file:line cited so this plan stays honest.)*

A **capability** is anything a graph node can invoke. Three kinds, all compiling to one
`CapabilityPlugin` interface (`src/core/capability/capability.ts:149-156`):

| Kind | Format | Trust | Best for |
|---|---|---|---|
| **YAML** | declarative HTTP wrapper (`src/core/extensions/yaml-capability.ts`) | zero code, safe-by-construction, SSRF-guarded | **Almost every connector** (Slack, Sheets, Notion, HubSpot, GHL, Firecrawl, Gmail-send) |
| **MCP** | connect a Model Context Protocol server; each tool → `${server}.${tool}` capability (`src/core/mcp/mcp-client.ts`) | external process; side-effect inferred **fail-closed** | stateful/complex connectors with an existing MCP server (Qdrant, Notion-official, Slack) |
| **TypeScript** | a `.ts`/`.js` exporting a `CapabilityPlugin` | in-process, **gated** behind `KRELVAN_ALLOW_UNTRUSTED_PLUGINS=1` + the subprocess sandbox | custom logic that can't be expressed as one HTTP call (RAG chunk+embed+search, multi-step diff) |

**The YAML format** (the workhorse — `yaml-capability.ts:62-86`):
```yaml
name: slack.notify              # [a-z][a-z0-9._-]*
description: Post to a Slack channel
sideEffect: message-human       # read | write-reversible | write-irreversible | spend | message-human | identity-mutation
estimateCents: 0                # non-negative integer
http:
  url: "{{secret:slack-webhook}}"         # secrets only as {{secret:NAME}}, resolved lazily at invoke
  method: POST
  headers: { Content-Type: "application/json" }
  body: { text: "{{input.message}}" }     # inputs only as {{input.field}} — no eval, no arbitrary chains
input:
  message: { type: string, required: true }
responseField: data.items       # optional safe dot-path to extract from the JSON response
successCodes: [200]
```
Only two interpolation patterns are allowed (`{{secret:...}}`, `{{input.field}}`); the URL is
`assertPublicUrl`-checked before any request leaves the host (`yaml-capability.ts:484-488`).

**Registry entry** (the marketplace is a Git repo — `registry/index.json`, schema in
`registry/README.md:52-67`): `name, title, oneLiner, category, sideEffect, tier (official|community),
author, kind (yaml|mcp), secretRefs[], price?, licenseUrl?, sourceUrl?` and either the full `yaml`
string inline or the `mcp` config object. Publishing = fork → add entry → PR → merge → appears in
every install's Discover tab. No account, no server (`registry/README.md:42-49`).

**Lifecycle** (`src/core/plugins/lifecycle-service.ts`): install (path-contained, hashed, secretRefs
extracted, `egressHosts` declared) → enable (hash must match, secrets validated, TS gated) → disable
→ uninstall (refuses if open commitments). Every transition writes a **signed ledger event**.

**How a node uses it** (`src/core/kernel/engine.ts:274-435`): node lists `CapabilityRef{name,
sideEffect, budgetCents}` (deny-by-default); engine builds `EffectCall{nodeId, capability, input:
state}`, `admit()`s it (budget + `needsApproval(autonomy, sideEffect)`), parks for HITL if needed,
writes `EffectRequested`, calls `supervisor.run()` → `plugin.invoke()`, and the **Supervisor signs the
`EffectResult`** (plugins never self-sign). That signature is the proof.

**Approval gradient** (`capability.ts:122-133`): `read` never gates; `suggest` gates all non-reads;
`act-with-veto` gates `write-irreversible|spend|identity-mutation`; `full` never gates. **This is why
side-effect honesty matters** — it's what decides when a human is asked.

---

## 2. The 7 connectors — exact build form

Decision rule learned from research: **prefer a YAML HTTP wrapper** (safe, no process, no dep, fully
under our SSRF/egress controls). Use **MCP** only when an excellent official server exists and the
surface is broad/stateful. Use **TS (sandboxed)** only for RAG's chunk+embed+search loop.

| Connector | Build as | Auth (store this) | First capability to ship | sideEffect |
|---|---|---|---|---|
| **Slack** | YAML | `xoxb-` bot token (static) | `slack.post` → `chat.postMessage` | message-human |
| **Google Sheets** | YAML | service-account JSON (no OAuth flow!) | `sheets.append` → `values/{range}:append` | write-reversible |
| **Notion** | YAML (or official MCP) | `ntn_` integration secret (+ share page) | `notion.create_page` → `POST /v1/pages` | write-reversible |
| **HubSpot** | YAML (or `@hubspot/mcp-server`) | private-app bearer token | `hubspot.upsert_contact` → `contacts/batch/upsert` (idProperty=email) | write-reversible |
| **GoHighLevel** | YAML | private-integration bearer + `Version: 2021-07-28` | `ghl.create_contact` → `POST /contacts/` | write-reversible |
| **Firecrawl** | YAML (or `firecrawl-mcp-server`) | `fc-` bearer key | `firecrawl.scrape` → `POST /v2/scrape` (formats:[markdown]) | read |
| **Qdrant RAG** | TS (sandboxed) + Qdrant via Docker/MCP | none self-hosted (or `QDRANT_API_KEY`) | `rag.search` (embed→top-k) + `rag.ingest` | read / write-reversible |
| **Gmail** | YAML, but OAuth | client_id+secret+refresh_token | `gmail.send` → `messages/send` (base64url raw) | write-irreversible |

**Auth-simplicity ranking** (ship in this order — least friction first): **Sheets ≈ Slack > Notion >
HubSpot ≈ GHL ≈ Firecrawl > Qdrant(infra) > Gmail(OAuth)**. Three of these reduce to one bearer secret.

**The Gmail wrinkle (be honest):** Gmail is the only one that needs the full OAuth2 refresh-token
dance — a YAML wrapper can do the *send* (one bearer header) but can't mint the access token from the
refresh token. Two clean options: (a) ship a tiny **`gmail.send` YAML** that takes an already-minted
access token, plus a documented one-time `get-refresh-token` helper; or (b) make Gmail an **MCP** so
the token refresh lives in the server. Recommend (b) long-term, (a) to ship fast.

---

## 3. The 4 templates — as Krelvan agent graphs

Each template is a **manifest** (a graph of nodes, each node granting specific capabilities). Two graph
shapes recur: **event-triggered** (RAG query, email triage) and **scheduled** (ingestion, price
monitor, digest) — and Krelvan already has APScheduler + a `ScheduleRegistry`, so "scheduled" is a
first-class trigger, not a hack.

### 3.1 Competitor / price monitor — *ship this first* (sharpest ledger demo)
Why first: needs only capabilities we can build immediately (`firecrawl.scrape` + a diff node +
`slack.post`/`telegram`/`discord.notify`), it's the canonical "agent" everyone recognizes, and "what
it scraped, when, and what changed" is **exactly** what the signed ledger proves.

Graph (scheduled): `schedule → load watch-list (sheets.read) → firecrawl.scrape (read) → extract
fields (LLM node) → load last snapshot (sheets.read) → diff (pure node) → gate on threshold →
summarize change (LLM) → alert (slack.post, message-human) → persist new snapshot (sheets.append,
write-reversible)`. State lives in a Sheet (system of record); never overwrite the baseline before the
diff succeeds. Alert tiers: ≥10% urgent, 5–10% routine, <5% none.

### 3.2 Email triage + daily digest
Graph A (triggered, poll every ~15 min): `gmail.list unread (read) → classify (LLM: Urgent /
Needs-reply / FYI / Spam) → route → low-risk auto-reply (gmail.send, write-irreversible — GATES under
act-with-veto) | high-risk draft + slack.post for approval`. Graph B (scheduled 8am):
`gather triaged → summarize per bucket (LLM) → slack.post digest`. Keep Sales/Finance behind a draft
gate — never auto-send. The approval gate falls out of our autonomy gradient *for free* because
`gmail.send` is `write-irreversible`.

### 3.3 Lead-gen outbound pipeline
Linear graph with a hard human gate before send: `source/scrape leads (firecrawl.scrape) → stage
(sheets.append) → enrich (firecrawl + LLM) → score vs ICP (LLM) → draft outreach (LLM) → HUMAN
APPROVAL (suggest/act-with-veto) → write CRM (hubspot.upsert_contact, write-reversible) → send
(gmail.send, write-irreversible — gates)`. Verify/score *before* drafting to cut cost; dedupe vs CRM
first. The "propose-then-commit" gate sits immediately before the irreversible send — which is exactly
how `needsApproval` already behaves.

### 3.4 RAG support chatbot
Two graphs sharing a Qdrant collection. **Ingestion (scheduled):** `load docs (firecrawl.scrape /
filesystem MCP) → clean → chunk (300–500 tok, 10–20% overlap) → embed (OpenAI text-embedding-3-small
or local Ollama) → rag.ingest (upsert to Qdrant, write-reversible)`. **Query (triggered):**
`rag.search (embed question → top-k, read) → confidence gate → assemble prompt → LLM answer grounded +
cite → reply`. Anti-hallucination: "answer only from context" + score threshold + require citations.
This is the one template needing the sandboxed TS capability (chunk+embed+search is more than one HTTP
call) — a good forcing function to prove the sandbox + egress broker on a real workload.

---

## 4. Make it COMPLETE — what's missing today and the gaps to close

Honest audit of what these templates need that the codebase doesn't yet have cleanly:

1. **Capability authoring is doable but undocumented.** There's no `CAPABILITY_AUTHORING.md`. → Write
   one (the §1 format + a copy-paste template + the publish steps). This is the single highest-leverage
   doc for the contributor flywheel.
2. **No connector pack shipped.** `capabilities/` has examples but not the 7 above. → Add the 6 YAML
   connectors + 1 RAG TS capability as bundled `capabilities/*.yaml` AND as `registry/index.json`
   `official` entries.
3. **OAuth connectors (Gmail) have no token story.** → Either the access-token-in YAML + helper, or a
   small Gmail MCP. Document it; don't pretend a webhook covers it.
4. **RAG needs an embeddings capability + Qdrant wiring.** Qdrant is already in the stack (Qdrant
   Cloud per CLAUDE.md) but there's no `rag.ingest`/`rag.search`. → Build as the first real sandboxed
   TS capability.
5. **Templates aren't first-class.** The marketplace lists *capabilities*; there's no "install this
   whole agent (graph + its capabilities)" concept. → Add a **template = a signed manifest + a
   capability bundle** registry kind so a user can one-click an entire "Price Monitor" agent, not just
   the scraper. (This is the biggest product unlock — see §6.)
6. **Per-capability egress isn't wired into the registry entry.** `egressHosts` exists on install but a
   registry entry can't *declare* its hosts. → Add `egressHosts` to the registry schema so an
   `official` connector ships with its allowlist (e.g. Slack → `slack.com`), tightening security by
   default.

---

## 5. Make it PORTABLE — works anywhere, no lock-in

The whole pitch is "you own it." Portability rules to hold to:
- **YAML/MCP capabilities are already portable** — pure data, Node built-ins only, no vendor SDKs in
  core (invariant #7). Keep new connectors dependency-free: a YAML wrapper adds **zero** deps.
- **Secrets via `{{secret:NAME}}` → env/secret-store**, never inlined — so a capability is the same on
  a laptop, Docker, or a VPS. Already true; keep it true.
- **Registry is a plain Git repo + `index.json`** reachable by raw URL and overridable via
  `NEXT_PUBLIC_KRELVAN_REGISTRY_URL` — so a company can run a **private internal registry** (their own
  fork) with their own connectors. Document this as a first-class "enterprise/private marketplace" path.
- **Self-host every dependency the templates touch:** Qdrant (Apache-2.0, `docker run`), Firecrawl
  (AGPL, self-hostable) — so a fully air-gapped install is possible. Note the Firecrawl AGPL caveat in
  the registry entry so contributors/companies know.
- **Templates are signed manifests** — portable JSON that re-verifies on any install (the ledger
  guarantees the graph you import is the graph that runs).

---

## 6. Make it a HIT — the contributor flywheel (companies, devs, products)

The market is already building agents elsewhere and paying fees. Our pitch to *contributors*: **publish
once, it runs on every self-hosted Krelvan, you keep your users, no 10–20% gig fee, and the ledger
proves your capability did what it claims.** How we make contributing irresistible:

1. **10-minute publish path.** `CAPABILITY_AUTHORING.md` + a `npx krelvan new-capability` scaffolder
   that emits a valid YAML stub and a local test command. Friction is the enemy of a flywheel.
2. **CI validation on the registry repo.** A PR that adds an entry runs a validator (YAML parses,
   sideEffect valid, secretRefs declared, egressHosts present for HTTP) → green check → merge. Already
   half-built (the lifecycle validators are reusable).
3. **Tiers that build trust.** `official` (signed by Krelvan, one-click) vs `community` (PR-published,
   shows a risk-ack). This already exists in the schema — lean into it: a clear "verified" badge.
4. **Templates, not just connectors, are publishable.** A company can publish "**Acme Support Bot**" =
   a manifest + the capabilities it needs, and a user installs the whole working agent. THIS is the
   "Steam for agents" / "Fiverr gig as a downloadable" model the thread predicted — but free and
   self-hosted. Each template carries its required `secretRefs` so the install UI says exactly "Needs:
   a Slack token, a Firecrawl key."
5. **Paid-but-you-own model.** The schema already supports `price` + `licenseUrl`: the capability
   installs free, the user supplies their own API key, and a paid capability links its license. So a
   vendor can monetize a premium connector **without us touching the money or locking the user in** —
   the opposite of the gig platforms.
6. **A "bring your private registry" story for enterprises** (§5) — Bobcares/Infosys/TCS-type shops
   maintain an internal fork of connectors for their clients; the open core is the wedge into those orgs.

**The narrative for launch:** "The agent marketplaces want to rent you agents. Krelvan lets you **own**
one — describe the job, get a real signed agent, run it on your own box, and **prove** what it did.
Here are 8 agents people pay freelancers to build, free and yours to keep." Lead the homepage with the
**price-monitor** (live, signed-ledger proof) because it's the most viscerally "an agent did a real job
and here's the receipt" demo.

---

## 7. Sequenced execution plan

**Phase A — author + document the rails (unblocks everyone):**
- A1. `docs/CAPABILITY_AUTHORING.md` (format, copy-paste template, publish steps, side-effect honesty).
- A2. Add `egressHosts` to the registry entry schema + the install path that reads it.

**Phase B — ship the connector pack (mostly YAML, zero new deps):**
- B1. `slack.post`, `sheets.append`/`sheets.read`, `notion.create_page`, `hubspot.upsert_contact`,
  `ghl.create_contact`, `firecrawl.scrape` — as bundled `capabilities/*.yaml` + `official` registry
  entries, each with declared `secretRefs`, honest `sideEffect`, and `egressHosts`.
- B2. Gmail: ship `gmail.send` (access-token-in) + a documented refresh-token helper, OR a small Gmail
  MCP entry. Pick one, document it.
- B3. RAG: build `rag.ingest` + `rag.search` as the first real **sandboxed TS** capability against
  Qdrant + an embeddings provider (OpenAI or local Ollama). Adversarially test it through the egress
  broker (Qdrant host + embeddings host on the allowlist).

**Phase C — templates as first-class products (the unlock):**
- C1. Add a `template` registry kind = `{ manifest (signed), requiredCapabilities[], secretRefs[] }`.
- C2. Author the 4 templates as signed manifests: **price-monitor (first)**, email-triage, lead-gen,
  RAG-support-bot.
- C3. "Install template" UX: installs the manifest + offers to install each missing capability + lists
  the secrets to set. One click → a working, recognizable agent.

**Phase D — flywheel + launch:**
- D1. `npx krelvan new-capability` scaffolder + registry-repo CI validator.
- D2. Homepage demo = the price-monitor with its signed ledger receipt.
- D3. "Contribute a capability" CTA + the private-registry/enterprise doc.

**Recommended first commit:** Phase A1 + B1's `slack.post` and `firecrawl.scrape` + C2's price-monitor
template — that's the smallest slice that produces a *complete, recognizable, signed* agent end-to-end
and proves the whole story.

---

## Appendix — source research
Four briefs fed this plan (codebase map; Gmail/Slack/Sheets/Notion; HubSpot/GHL/Firecrawl/Qdrant; the
4 template anatomies). Key facts: Slack `xoxb` + `chat.postMessage`; Sheets service-account +
`values:append`; Notion `ntn_` + `POST /v1/pages` (pin `Notion-Version: 2025-09-03`); HubSpot
`contacts/batch/upsert` (idProperty=email); GHL `Version: 2021-07-28` header; Firecrawl `POST
/v2/scrape` (AGPL self-hostable); Qdrant `PUT /collections`, `PUT .../points`, `POST .../points/query`
(Apache-2.0, `mcp-server-qdrant`); embeddings dim must match collection size. Full URLs in the task
transcript.
