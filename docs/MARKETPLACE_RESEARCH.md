# Krelvan Marketplace — "Fiverr/Upwork for AI agents" research → what to seed

*Triggered by the "Is there a Fiverr/Upwork of AI agents yet?" thread. Researched the named
platforms (agent.ai, Jeeves, iquly, MuleRun, UpAgents, ClawGig, Dealwork) + the broader
Fiverr/Upwork demand. This doc turns that into a concrete seed list for OUR free, open-source
registry.*

---

## 1. The landscape (two distinct models)

| Platform | Model | Pricing | Strongest in |
|---|---|---|---|
| **agent.ai** | Store + "LinkedIn for agents" (HubSpot founder) | Free tier → $10/agent or $25 Pro | Sales/marketing micro-agents, research |
| **MuleRun** | Store, run-in-browser, each user gets a cloud VM | Credits $1=100 + $8–160/mo | Image/content/web generation |
| **UpAgents** | "Upwork for agents" — hire pre-built agent-workers | Pay-per-task $0.01–$8 | Long-tail business-role automation |
| **iquly** | Agent *packages* triggered from 15+ chat apps | Free agents + $3–29/mo | Chat-triggered utilities |
| **Jeeves** | Job-board: agents compete for posted gigs | Seller-set per-task/outcome | Support, data, finance |
| **ClawGig** | Crypto gig exchange, agents bid on gigs | Per-gig, 10% fee, USDC | Dev / scrape / content gigs |
| **Dealwork** | Agents AND humans bid; agents also hire | Per-task, 3–10% fee, USDC | Dev/automation, AI-to-AI work |

**Two takeaways for us:**
1. Every one of them is **paid/closed** (subscriptions, credits, per-task, or crypto fees). **Our wedge: free + open-source + self-hosted + signed-ledger proof.** Nobody in this list lets you *own* the agent and *prove* what it did. That's the Krelvan story, and it slots directly under our existing "marketplace is a Git repo, not a hosted site" model.
2. The actual WORK is remarkably consistent across all of them. The catalog below is the intersection — what buyers repeatedly request.

---

## 2. The demand, distilled — the 5 repeatable products

The paid market (Fiverr/Upwork live gigs + Upwork's 2026 In-Demand report) clusters into five
shapes. These are what people PAY to have built, so they're the highest-leverage seed templates:

1. **Workflow automation builds** — glue between apps (the n8n/Make/Zapier gig category).
2. **RAG chatbots** — "talk to your docs/website," support widget + lead capture + booking.
3. **Voice agents** — receptionist, cold-caller, appointment setter (Vapi/Retell/ElevenLabs).
4. **Lead-gen / outbound pipelines** — scrape → enrich → email → CRM → follow-up.
5. **CRM automation** — HubSpot/GoHighLevel/Pipedrive sync + enrichment.

Upwork 2026: AI integration +178%, AI chatbot dev +71%, AI video +329%, data annotation +154%.

---

## 3. The seed catalog — 11 categories × concrete agents

These are the *actual deliverables* buyers request across all 7 platforms. Each maps to a
Krelvan agent graph. **Bold = highest-frequency / build first.**

### Sales / SDR
- **Lead qualifier** — score inbound vs an ICP, route hot ones
- **Cold-outreach drafter** — personalized emails from a lead list (CSV/Sheet)
- **Contact enricher** — company size, role, tech stack, LinkedIn from an email/domain
- **Meeting-prep brief** — one-pager from LinkedIn + CRM + recent news before a call
- Stale-lead reactivator · buying-signal watcher (news/LinkedIn triggers) · win/loss debrief
- CRM dedupe/clean · "new high-value lead → Slack alert"

### Marketing
- **SEO blog writer** — from a target keyword + brief
- **Content repurposer** — one asset → blog, LinkedIn carousel, X thread, newsletter, captions
- Keyword/trend researcher · ad-copy + subject-line variants · social cross-poster (per-platform formatting) · brand-mention/social listening report · campaign performance summary

### Customer Support
- **RAG support bot** — answers from your docs/site, cites sources
- **Ticket triage** — classify intent + route
- Thread summarizer · weekly-tickets→themes · sentiment + escalation · suggested-reply drafter · auto-tagger · KB-gap finder · multilingual translator

### Research / Competitive Intelligence
- **Competitor price-page monitor** — daily diff + alert on change (this is the canonical "agent" demo)
- **Daily news/keyword digest** — for an industry or topic set
- Competitor news/blog/job-listing tracker · review-site sentiment (G2/Trustpilot) · directory/list-site → structured Sheet · long-PDF summarizer with source quotes · market-sizing brief

### Recruiting / HR
- **Resume screener** — rank candidates vs a JD, parse CV PDFs to structured data
- JD generator · candidate sourcer · interview scheduler · onboarding checklist orchestrator · HR-policy RAG bot

### Operations / Admin
- **Email triage + label/sort** (Gmail/Outlook)
- **Invoice/receipt/form → structured Sheet/DB** (OCR/extraction)
- Daily standup digest → Slack · meeting-notes → action items → CRM/Notion · cross-app sync (Airtable↔Sheets↔CRM) · SLA/deadline monitor · "chat with our database" (SQL)

### Content
- Long-form writer in brand voice · case-study from call transcript · webinar/YouTube → blog ·
  product-description generator (e-commerce) · localize into N languages · transcript → summary + chapters

### Data / Analytics
- **NL query over a DB/warehouse** · auto-dashboard from a dataset · scheduled metrics report → Slack ·
  anomaly alert on a metric · clean/normalize/dedupe · classify/tag at scale · ETL pull→transform→load

### Dev / Engineering
- **PR/code reviewer** (GitHub/GitLab) · RAG over a codebase · test-gen + ship a PR · log/error triage ·
  doc generator from code · webhook/integration glue · security-alert enrichment (MITRE ATT&CK)

### Finance / Accounting
- **Invoice extraction** (dates/amounts/tax/line items) · 3-way match (invoice↔PO↔receipt) ·
  bank-statement reconciliation · expense-policy check · cash-flow summary · stock/financial-doc analysis

### Personal Assistant
- **Email triage + draft replies** · smart calendar scheduling · daily morning/night briefing ·
  meeting prep · task capture from Telegram/Slack → to-do · "chat with PDF" research

---

## 4. Integrations the agents most need (build connectors in this order)

**Comms (highest):** Gmail, Outlook, Slack, **Telegram** (we already have python-telegram-bot in stack), WhatsApp, Discord (have `discord.notify`), SMS/Twilio.
**Productivity/docs:** **Google Sheets** (the universal data layer), Google Drive, Notion, Airtable, Google Calendar.
**CRM/sales:** HubSpot, Pipedrive, GoHighLevel, LinkedIn, Salesforce.
**Voice (own gig category):** Vapi, Retell, ElevenLabs.
**Web/data:** scraping (Firecrawl/Apify/Exa — we have `serp.search`), Postgres/Mongo/SQLite/Supabase, vector DBs (Qdrant — already in our stack, Pinecone).
**Content/commerce:** plugin CMS, Shopify, WooCommerce, YouTube, X, Reddit, Stripe.
**Meetings/finance:** Zoom, Fireflies, OCR/LlamaParse (invoices), GitHub/GitLab.

---

## 5. What we ALREADY have vs the gap

Current registry (`registry/index.json`, 7 entries): `github` (MCP), `filesystem` (MCP),
`hn.top`, `weather.fetch`, `wikipedia.summary`, `discord.notify`, `serp.search`.

So we already have: a search primitive, a notify primitive, a couple of fetch primitives, and 2
MCP connectors. **We have building blocks but zero of the 5 high-demand PRODUCTS and almost none
of the top connectors.**

### Recommended first wave — 8 templates that cover most paid demand
(each is a Krelvan agent graph built from YAML/MCP capabilities — no new sandbox code needed):

1. **RAG support chatbot** (docs/site → answers + sources)
2. **Lead-gen outbound pipeline** (scrape → enrich → draft email → CRM)
3. **Competitor / price monitor** (daily diff + alert) ← best single "signed-ledger proof" demo
4. **Email triage + daily digest**
5. **Invoice extraction + reconciliation**
6. **Content repurposer** (1 → many)
7. **Meeting-notes → CRM/Notion**
8. **SEO blog writer**

### Connectors to add to unlock those 8
**Gmail, Slack, Google Sheets, Notion, a CRM (HubSpot or GoHighLevel), a scraper (Firecrawl), a
vector DB (Qdrant — already in stack).** Telegram + Discord we already have.

---

## 6. Our positioning (do NOT lose this)

Every competitor sells **convenience** (run an agent, pay per use). We sell **ownership + proof**:
- **Free + open-source + self-hosted** — you own the agent and its data; no per-task fee, no lock-in.
- **Signed, replayable ledger** — you can *prove what the agent did* (the regulator/auditor story
  none of these marketplaces have). The competitor-monitor and invoice-reconciliation templates are
  the sharpest demos of this, because "what it touched and when" is the whole value.
- **Marketplace = a Git repo** — anyone publishes a capability by opening a PR (the plugin CMS model
  we already run via `krelvan-registry`).

**Honest framing:** the demand is real and the work is well-understood; our edge isn't "more agents,"
it's "agents you own and can trust." Seed the 8 templates above so a new user lands on something that
already does a job they recognize from Fiverr — then the signed ledger is the reason they stay.

---

## Sources
See the three research briefs that fed this (agent.ai/Jeeves/iquly; MuleRun/UpAgents/ClawGig/Dealwork;
Fiverr/Upwork + n8n demand) — URLs captured in the task transcript. Key anchors: agent.ai blog
(micro-agent use cases), upagents.app/agents-for/*, clawgig.ai/gigs, dealwork.ai/explore, Upwork
In-Demand Skills 2026, awesome-n8n-templates.
