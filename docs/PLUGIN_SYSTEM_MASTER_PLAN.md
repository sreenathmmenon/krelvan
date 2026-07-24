# Krelvan Plugin System → Best-in-Class + Top-25 Connector Catalog

*Goal: make the capability/plugin system (YAML · MCP · TypeScript · built-ins) the best and most-talked-about
in the agent space, and seed the marketplace with the top-25 real-world agent requirements people pay for.
This plan is grounded in 4 code+market research streams (file:line-cited gaps, MCP-vs-YAML per connector,
the demand ranking, and the bar set by Composio/n8n/MCP-registry/plugin CMS).*

---

## 0. The strategic wedge (don't lose this)

No leader offers all three authoring formats under one trust model:
- **YAML HTTP wrapper** = n8n's loved declarative node, but language-agnostic config.
- **MCP** = native interop with the 97M-download MCP ecosystem + official registry.
- **TypeScript plugin** = the typed escape hatch for real logic (already sandboxed via subprocess + egress broker).

**The one-sentence pitch to make it buzzworthy:**
> "The first agent connector registry where a YAML API wrapper, an MCP server, and a TypeScript plugin all
> install with one line, share managed multi-user OAuth, and ship **signed, secret-scanned, and
> conformance-tested by default** — the safe successor to the MCP wild west."

Most of that already exists here (signed manifests, fail-closed MCP side-effects, SSRF guard, subprocess
sandbox, egress broker, registry CI validator). The work is closing the gaps below + filling the catalog.

---

## 1. The P0 blockers that stop us shipping many connectors (code-verified)

From the codebase map (`src/core/mcp/mcp-client.ts`, etc.):

1. **MCP secret/env injection is unsolved.** Most real MCP servers (GitHub, Stripe, Notion, Slack, Linear…)
   need an API key in a *specific* env var. Today nothing maps a registry entry's `secretRefs` →
   the spawned child's env. You'd hand-edit `mcp-servers.json` with inlined tokens. **(mcp-client.ts:145)**
2. **Full host env leaks into every MCP child** — stdio spawns with `{...process.env, ...config.env}`, so
   the child inherits Krelvan's OWN signing secrets / auth token / LLM keys. Security blocker. **(:145)**
3. **Remote/Streamable-HTTP MCP transport is a stub** — the HTTP transport POSTs to `url+"/rpc"` with
   hardcoded `id:1`, no session header, no SSE. Real hosted MCP servers won't work; every connector must be a
   local `npx` stdio process. **(:236-274)**
4. **MCP is not in the lifecycle/ledger** — no install/enable/disable/uninstall, no source hash, no signed
   event, no per-server tool allowlist. Can't manage 25 connectors like YAML ones.
5. **Registry validator never starts a server** — only checks the `mcp` block is a non-empty object.

**Highest-leverage unblock:** P0 #1–#2 (declarative MCP secret injection + scrubbed env) + a **meta-connector
entry** (Composio/Pipedream MCP) → takes the catalog from ~24 hand-built capabilities to *hundreds* of
integrations through a handful of registry entries.

---

## 2. The build — sequenced

### Phase A — MCP hardening (unblocks every connector) [P0]
- **A1. Declarative env/secret injection for MCP.** Add `env` (with `{{secret:NAME}}` interpolation) to the
  registry `mcp` block and `McpServerConfig`; resolve secrets into the child env at spawn.
- **A2. Scrubbed MCP child env.** Spawn stdio MCP with an allowlist env (PATH/HOME/etc) + only the
  declared/injected vars — never Krelvan's own secrets. (Reuse the `scrubbedEnv` pattern from the subprocess
  loader.)
- **A3. Per-server tool allowlist** — optional `tools: [...]` to expose a subset (token-context hygiene).
- **A4. Real Streamable-HTTP transport** (later if time): proper session id, incrementing ids, SSE, bearer
  auth — so hosted/remote MCP servers work.

### Phase B — Connector authoring power [P1]
- **B1. MCP-as-lifecycle-kind** so MCP connectors install/enable/disable/uninstall with signed ledger events
  like YAML/TS (optional, larger).
- **B2. YAML: query-param builder + form/multipart body + retry/timeout knobs** (the most-requested missing
  bits; OAuth/pagination are bigger, defer).

### Phase C — The Top-25 connector catalog (the visible win)
Ship the connectors behind the top-25 paid agent requirements. **MCP where a quality server exists; YAML
wrapper where MCP is weak/absent; one meta-connector for the long tail.** All as registry entries +
authoring docs. (See §3 catalog.)

### Phase D — Best-in-class DX + trust (the buzz) [P2]
- **D1. `genesis plugin new --kind yaml|mcp|ts` scaffolder + `genesis plugin check`** (the secret/dotfile
  scan + schema + SSRF lint that gates publish). plugin CMS-PCP + n8n-linter model.
- **D2. Per-connector docs** in the registry (`docsUrl`, input examples) + Connector Packs (curated bundles
  = "Sales Stack", "Support Stack" — one install, whole workflow).
- **D3. Signed-by line + verified badge** surfaced on every listing (signing already exists).

---

## 3. The Top-25 catalog — connector ↔ MCP/YAML decision

Ranked by demand (Fiverr/Upwork). **MCP** = ship as MCP registry entry; **YAML** = HTTP wrapper; **META** =
covered by a meta-connector (Composio/Pipedream).

| # | Requirement | Key connectors | Form |
|---|---|---|---|
| 1 | Workflow automation | (n8n/Make are the *competitor*; we ARE the automation) | — |
| 2 | Custom agent dev | think/compose/rag (built-in) | built-in ✓ |
| 3 | RAG "chat with docs" | Qdrant/Pinecone + Firecrawl | MCP (qdrant, firecrawl) + built-in rag ✓ |
| 4 | Voice receptionist | Vapi, Retell, ElevenLabs, Twilio, Cal.com | MCP (vapi, elevenlabs, cal.com) + YAML (twilio) |
| 5 | Lead-gen / scraping | Apollo, Firecrawl, Exa | MCP (apollo, firecrawl, exa) |
| 6 | AI SDR / cold email | Apollo + Instantly/Smartlead + HubSpot + Calendly | MCP (apollo, hubspot, calendly) + YAML (instantly) |
| 7 | Outbound caller | Retell/Vapi/Bland + Twilio | MCP + YAML |
| 8 | Support chatbot | Qdrant + Zendesk/Intercom + Stripe/Shopify | MCP (stripe, shopify) + YAML (zendesk, intercom) |
| 9 | GoHighLevel CRM | GoHighLevel | MCP (official GHL) |
| 10 | WhatsApp bot | Twilio WhatsApp | **YAML** (Messages API) |
| 11 | AI into apps | http_get/http_post (built-in) | built-in ✓ |
| 12 | Content pipeline | OpenAI + plugin CMS + Buffer | YAML (plugin-cms) + built-in compose |
| 13 | Invoice extraction | OpenAI vision + QuickBooks + Sheets | MCP (quickbooks, sheets) |
| 14 | CRM sync | HubSpot/Salesforce/Pipedrive + Stripe + Sheets | MCP (hubspot, salesforce, stripe) + YAML (pipedrive) |
| 15 | Lead scoring | HubSpot + Clay/Apollo + Slack | MCP + YAML (clay) |
| 16 | Email triage | Gmail/Outlook + Slack | MCP (gmail via workspace-mcp) + slack |
| 17 | Meeting notes | Fireflies/Otter + Notion + Slack | MCP (notion) + YAML (fireflies) |
| 18 | Price monitor | Firecrawl + Sheets + Slack | template ✓ (firecrawl + slack) |
| 19 | Custom GPT + actions | built-in think + http | built-in ✓ |
| 20 | Social auto-post | LinkedIn/X/Buffer | YAML (buffer) |
| 21 | Video gen | Runway/HeyGen/ElevenLabs | MCP (elevenlabs) + YAML |
| 22 | Receipts → accounting | QuickBooks + Stripe + Drive | MCP (quickbooks, stripe) |
| 23 | Recruiting/resume | ATS + Gmail/Calendar | MCP (gmail/calendar) + YAML (ATS) |
| 24 | E-commerce agents | Shopify + Klaviyo + Gorgias | MCP (shopify) + YAML (klaviyo) |
| 25 | Personal assistant | Gmail + Calendar + Slack | MCP (gmail, calendar, slack) |

**The connector set to ship (covers the bulk):**
- **MCP (official/strong-community servers):** github ✓, filesystem ✓, stripe, notion, slack, linear, qdrant,
  firecrawl, exa, brave-search, tavily, perplexity, vapi, elevenlabs, cal.com, calendly, apollo, hubspot,
  shopify, gohighlevel, google-workspace (gmail+calendar+sheets+drive via `workspace-mcp`), pinecone,
  resend, airtable, quickbooks.
- **YAML HTTP wrappers (MCP weak/absent):** twilio (SMS+WhatsApp), pipedrive, clay (webhook), mailchimp
  marketing, sendgrid, buffer, klaviyo, plugin-cms.
- **META-connector (the long-tail catch-all):** one Composio or Pipedream MCP entry → hundreds more apps.

**Security caution (from research):** do NOT ship the archived Anthropic reference servers (slack, gdrive,
github-TS, postgres-SQLi, brave) — use the official/community replacements noted in the catalog research.

---

## 4. What "best-in-class" requires that we DON'T have yet (honest gap list)

- **OAuth for end users** (the Composio/Pipedream moat — `external_user_id` + managed OAuth +
  credential-injecting proxy). Big, deferred; today we do static-token connectors. The meta-connector entry
  is the pragmatic near-term answer (it brings managed OAuth for hundreds of apps).
- **Scaffolder + pre-publish check CLI** (D1) — the #1 flywheel driver everyone ships day one.
- **Real remote MCP transport** (A4) — needed for hosted MCP (HubSpot/Linear/Notion-hosted, meta-connectors
  over HTTP).
- **Connector test/conformance suite** + signed-on-publish + secret scan (the "be the safe one" buzz angle).

---

## 5. This session's concrete scope (build now)

1. **A1 + A2 + A3** — MCP declarative secret-env injection + scrubbed child env + tool allowlist. (Unblocks
   everything; security-critical.)
2. **C** — add the Top-25 connector catalog as registry entries (MCP + YAML), each with secretRefs/env and
   honest sideEffects, validated by the registry CI. Add 2–3 Connector Packs.
3. **D1 (lite)** — a `genesis plugin new` scaffolder + extend the registry validator to secret-scan and
   shape-check every connector.
4. Live-test: connect a couple of real MCP servers (filesystem, a token one) with the new env injection;
   confirm scrubbed env; full suite + typecheck green; commit.

Deferred (flagged, not silently dropped): full OAuth-for-end-users, real Streamable-HTTP transport,
MCP-as-lifecycle-kind, conformance test suite.
