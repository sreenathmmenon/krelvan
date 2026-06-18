# Two flagship agents: Personal Advisor + LLM-Wiki (Karpathy pattern)

Researched against the primary sources (Karpathy's LLM Wiki gist; Peter Yang's advisor
pattern) and the exact Krelvan capability contracts. Both lean into Krelvan's real
differentiator: **persistent, agent-maintained memory/knowledge with a signed, replayable
ledger of every change** — not generic one-shot RAG.

## Why these two

- **Personal Advisor** (Peter Yang's pattern): context files (goals / principles / energy /
  life situation) + a learnings loop that distills "that didn't work" into new rules so the
  advisor improves over time. Maps 1:1 to Krelvan semantic facts + episodic memory + remember.
- **LLM-Wiki** (Karpathy's pattern, endorsed by Ajey Gore): the agent **compiles** sources
  into a persistent, interlinked markdown knowledge base — updating entity/concept pages,
  flagging contradictions — and answers from the *compiled wiki*, not by re-chunking raw text
  on every query. "Compiled once, kept current, not re-derived on every query."

**Decision (researched):** the LLM-Wiki is the REAL Karpathy pattern (agent-maintained entity
pages + `[[wiki-links]]` + index.md + log.md), NOT chunk-and-cite RAG — because chunk-and-cite
is exactly what the pattern defines itself against. Shipping RAG-as-wiki would be dishonest.

## Krelvan's unique twist

Every wiki page write and every advisor learning is a **signed ledger event** — a provable,
replayable history of how the knowledge/advice evolved. No other LLM-Wiki implementation has a
tamper-evident audit trail. That is the wedge.

---

## Architecture

### A. Personal Advisor — 3 nodes (recall → advise → record_learning)

Capabilities: `recall` (read), `think` (read), `remember` (write-reversible). Zero secrets.

- `recall_context` (`recall`): loads semantic facts (`recall.goals`, `recall.principles`,
  `recall.energy`, `recall.situation`) + episode history. First run = empty.
- `advise` (`think`): sees MEMORY (recalled facts) + the user's `question`. Grounds advice in
  goals/principles; if no context, gives general advice AND says adding context will sharpen it.
  Declared output keys: `result` (advice), `recommendation`, `confidence` (0-100 int as string),
  `learning` (one-line pattern worth remembering, or "none").
- `record_learning` (`remember`): persists the learning via `remember_map:
  "advisor_learning=advise.learning"`, logs the episode. Always runs (the learning loop is the point).

Companion: **set-context** (1 node, `remember`) writes goals/principles/energy as durable facts
via `remember_map`. Run once; advisor recalls them thereafter.

### B. LLM-Wiki — NEW capabilities + 2 agents (ingest, query)

New built-in capabilities (pure, no secrets, no network — operate on a wiki dir under dataDir):

- **`wiki.ingest`**: input = `{ wiki, source, text }`. The agent (LLM) reads the source, decides
  which entity/concept pages it touches, and the capability:
  - writes/updates markdown pages under `<dataDir>/wikis/<wiki>/{entities,concepts}/*.md`
  - maintains `index.md` (catalog with one-line summaries + `[[links]]`)
  - appends to `log.md` (`## [date] ingest | <source>`)
  - returns `{ ok, pages_touched, wiki }`
  The LLM proposes the page edits (think node upstream); the capability applies + signs them.
- **`wiki.query`**: input = `{ wiki, question }`. Reads `index.md`, selects relevant pages,
  returns their content as grounded context with page citations → a think node synthesizes the
  cited answer. Returns `{ ok, pages, body, sources }`.

Agents:
- **wiki-ingest** (3 nodes): `read_source` (load text) → `synthesize` (think: extract entities,
  propose page updates as structured output) → `apply` (wiki.ingest: write+sign pages).
- **wiki-ask** (3 nodes): `find` (wiki.query: index → relevant pages) → `answer` (think:
  grounded, cite pages, "not in the wiki" if absent) → `record` (remember: audit).

Both share a named `wiki`. wiki-ingest GROWS the wiki; wiki-ask reads the compiled pages.

---

## Premortem — handle ALL cases (this is the bar)

| # | Case | Mitigation (in manifest/capability) | Test |
|---|------|-------------------------------------|------|
| P1 | Advisor first run, no context | recall empty → advise role: "no goals in MEMORY → general advice + note adding context sharpens it" | yes |
| P2 | Advisor invents the user's situation | role fences: "use ONLY goals/principles in MEMORY; do not invent" | yes |
| P3 | Wiki query, topic never ingested | wiki.query returns 0 pages → answer: "the wiki has nothing on this yet" — never fabricate | yes |
| P4 | Empty/whitespace ingest | wiki.ingest: no entities → `pages_touched:0`, ok:true, no crash | yes |
| P5 | think returns malformed/extra keys | normalizeThinkOutputs coerces + allows only declared keys; roles declare keys | yes |
| P6 | Ollama down/slow | tests probe :11434/api/tags, skip-with-reason for CI; COMPLETION run is live with Ollama up | yes |
| P7 | non-integer floats in outputs (ledger rejects) | confidence as 0-100 int / quoted string; page counts are ints | yes |
| P8 | learning/source key missing | remember tolerates absent src; episode still logged | yes |
| P9 | Prompt-injection inside an ingested source ("ignore instructions") | content fenced in UNTRUSTED_DATA markers; ingest is data, not instructions; page writes are mechanical | yes |
| P10 | Budget/loop exhaustion | runBudgetCents + maxNodeVisits conservative; per-node budgets sized | yes |
| P11 | Wiki answer spans multiple pages | wiki.query cites each page; answer cites the pages actually used | yes |
| P12 | Same wiki, repeated ingest (growth) | append/update model: re-ingest updates existing page, doesn't duplicate; "grows smarter" | yes |
| P13 | Wiki name path traversal (../) | wiki/source names validated `^[a-zA-Z0-9._-]{1,64}$`, joined safely, never escape dataDir | yes |
| P14 | Concurrent ingests to same wiki | page writes are last-write-wins per file; index rebuilt from dir; no corruption | yes |
| P15 | Huge source document | chunk the synthesis; cap page size; truncate with note | yes |
| P16 | Contradiction across sources | wiki.ingest appends a "⚠ contradicts earlier" note to the page (Karpathy's "flag contradictions") | yes |

---

## Tasks

- **T1** wiki capabilities: `wiki.ingest` + `wiki.query` (pure, signed, path-safe) + unit tests
  (P4, P13, P14, P16, growth). No LLM needed for the capability's own tests.
- **T2** Advisor manifest + set-context companion + registry entries (recall/think/remember).
- **T3** Wiki-ingest + wiki-ask manifests + registry entries (wiki.* + think + remember).
- **T4** Premortem test suites (advisor.test.ts, llm-wiki.test.ts) covering P1–P16; live Ollama,
  skip-if-down for CI but RUN-for-real to complete.
- **T5** Live end-to-end via the running API (install → run) with Ollama: advisor across cases,
  wiki ingest-2-sources → ask-spanning-both → ask-unknown. Loop until green.
- **T6** Full suite + typecheck green; registry `updated`; docs; commit + push.

## Definition of COMPLETE
Both agents installed via the real API, run live against Ollama, correct grounded output across
the premortem cases (not just happy path), full suite + typecheck green, verified against the
running app — THEN commit. No "done then sorry."
