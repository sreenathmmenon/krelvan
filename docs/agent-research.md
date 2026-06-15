# Real-World Agent Use Cases — Research

Sources: Anthropic, OpenAI, a16z, Sequoia, Andrew Ng, financial companies, academic papers.

---

## Anthropic

- **Building Effective Agents**: anthropic.com/research/building-effective-agents
  Five canonical patterns: Prompt Chaining, Routing, Parallelization, Orchestrator-Workers, Evaluator-Optimizer.
- **Claude Managed Agents** (April 2026 public beta): platform.claude.com/docs/en/managed-agents/overview
- **Agent Skills** (open standard, Dec 2025): platform.claude.com/docs/en/agents-and-tools/agent-skills/overview
  Filesystem-based skill registry — domain knowledge loads on-demand, not all in context.
- **Finance Agents** (May 2026, 10 templates): anthropic.com/news/finance-agents
  Real artifacts: Excel comps models, PowerPoint pitchbooks, journal entries, KYC entity files.

## OpenAI

- **Swarm** (2024): lightweight multi-agent orchestration framework, agent handoffs via tool calls.
- **Operator** (2025): computer-use agent for web tasks — booking, form fills, purchasing.
- **Deep Research** (2025): multi-step web research agent, produces cited long-form reports.

## Financial Industry

### Investment Banking (Anthropic finance templates)
- **Pitch Builder**: fetch comps data → model → generate Excel + PowerPoint + email cover note
- **KYC Screener**: fetch entity data → screen against sanctions/PEP lists → package escalation file
- **Month-end Closer**: run close checklist → post journal entries → generate close report
- **Valuation Reviewer**: fetch financials → compare methodologies → flag discrepancies → audit trail
- **Earnings Reviewer**: fetch transcript + filings → extract key metrics → compare vs estimates → route to alert or pass

### Hedge Funds / Quant
- **Signal Generator**: fetch price/vol data → detect regime change → update position sizing model → log to ledger
- **Risk Monitor**: pull portfolio Greeks → compare vs limits → branch: within limits (log) vs breach (alert + hedge proposal)
- **Earnings Surprise Detector**: scrape consensus estimates → fetch actual → compute surprise → route to trade signal or ignore

### Insurance (Verisk connector)
- **Claims Triage**: ingest claim → fetch property data → assess fraud signals → route: auto-approve / manual review / deny with reason

---

## a16z

- **The Decade of the Agent** (2024 thesis): AI agents will replace SaaS workflows end-to-end. Key insight: agents don't just automate tasks, they own outcomes.
- Focus areas: vertical agents (one industry, deep), memory-first agents (learn from every run), agents with real-world actions (not just text generation).

## Sequoia

- **Generative AI Act Two** (2023/2024): agents as "the next wave" after copilots. Prediction: agents will run entire business processes autonomously.
- Key pattern: agents that loop — observe → plan → act → verify → repeat. Not one-shot.

## Andrew Ng (DeepLearning.AI)

- **Agentic AI Design Patterns** (2024 lecture series):
  1. Reflection: agent critiques its own output and iterates
  2. Tool Use: agent calls real APIs, not just text completion
  3. Planning: agent breaks goal into sub-steps, executes sequentially
  4. Multi-agent: specialist agents collaborate, each with narrow scope
- Key insight: "Iterative agentic workflows dramatically outperform single-pass prompting."

---

## Real Agent Patterns (what Krelvan should build)

These are NOT: search → compose → send (pre-agent era, IFTTT-style).

These ARE real agents because they: **mutate state**, **make branching decisions with consequences**, **operate on real external data**, **remember across runs**.

| Domain | Agent | What makes it real |
|--------|-------|-------------------|
| Legal | Contract Risk Reviewer | Fetches real document, extracts structured clauses, scores risk, routes to escalation or approval, remembers past contracts |
| DevOps | Incident Investigator | Fetches live metrics, correlates failure patterns, auto-remediates known issues, escalates unknowns, updates incident memory |
| Engineering | PR Security Reviewer | Fetches real GitHub diff, multi-axis analysis (security/perf/tests), branches on severity, blocks or approves |
| Data | DB Anomaly Detector | Fetches live query metrics, compares against remembered baseline, updates baseline, alerts only on real deviation |
| Finance | Portfolio Risk Monitor | Fetches live Greeks, compares against risk limits, branches: within limits (log) vs breach (propose hedge) |
| Compliance | KYC Entity Screener | Fetches entity data, screens against sanctions lists, routes to auto-clear or manual review, packages escalation dossier |
| Product | Customer Signal Analyzer | Fetches support tickets + NPS, clusters themes via LLM, detects new complaint patterns, routes to PM alert or routine digest |
| Infrastructure | Cost Anomaly Monitor | Fetches cloud spend by service, compares against 30-day rolling average, flags outliers, suggests rightsizing actions |

---

## Key Insight (from all sources consistently)

> "The value of an agent is not in what it says — it's in what it changes."

An agent that only produces text is a chatbot. An agent that:
- reads real data from external systems
- makes decisions that have consequences
- writes results back somewhere
- learns from previous runs
- escalates when uncertain

...is a real agent.

Krelvan's architecture (manifest graph + signed ledger + capability system + memory) is the right substrate for all of these.
