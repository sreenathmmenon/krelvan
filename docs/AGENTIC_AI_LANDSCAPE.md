# Agentic AI Landscape — What's Being Built and Why

> Research compiled June 2026. Sources: Anthropic, OpenAI, a16z, Harvey, Sierra, Cognition, ZenML, arXiv, IBM, Google, JPMorgan, Klarna, and 40+ additional primary sources.

---

## The Core Distinction: Why This Era Is Different

Traditional automation (Zapier, IFTTT, RPA, bots) is **trigger → fixed action**. You specify every step. It breaks the moment anything goes off-script.

Agentic AI is **goal → autonomous path-finding**. You specify the outcome. The agent decides the steps, recovers from failures, uses tools, and iterates.

| Dimension | Zapier / IFTTT / RPA | Agentic AI |
|---|---|---|
| Control model | "Do these exact steps" | "Achieve this goal" |
| Input type | Structured, predefined triggers | Unstructured: emails, PDFs, screenshots, conversations |
| Failure handling | Breaks and stops | Plans, replans, recovers |
| Decision-making | Zero — logic is in the rule | Embedded in the model |
| Scope | One tool, one workflow | Multi-tool, multi-system, multi-step |
| New capability | Faster humans | Replaces judgment |

The 2024–2025 practitioner consensus: the strongest production systems are **hybrid** — RPA for precision on known structured flows, agents for complexity, ambiguity, and exception handling.

---

## Part 1: What Anthropic Says About Agents

### Building Effective Agents
**URL:** https://www.anthropic.com/research/building-effective-agents

The canonical Anthropic reference for production agent design. Key finding: "The most successful implementations weren't using complex frameworks. They were building with simple, composable patterns."

Six core patterns documented:
1. **Prompt chaining** — sequential task decomposition
2. **Routing** — classify then specialize
3. **Parallelization** — concurrent workers
4. **Orchestrator-Workers** — supervisor dispatching specialized agents
5. **Evaluator-Optimizer** — agent reviews its own output
6. **Autonomous Agents** — open-ended goal pursuit

The team spent *more time optimizing tools than prompts*. Tools are the bottleneck, not prompts.

### How We Built Our Multi-Agent Research System
**URL:** https://www.anthropic.com/engineering/multi-agent-research-system

- Claude Opus 4 + Claude Sonnet 4 subagents **outperformed single-agent Opus 4 by 90.2%** on research tasks
- Token usage explains **80% of performance variance**
- Agents consume **4x more tokens** than chat, **15x more** than standard calls
- Parallel tool calling reduced research time by **up to 90%**
- Architecture: orchestrator spawns specialized parallel subagents

### Measuring AI Agent Autonomy in Practice
**URL:** https://www.anthropic.com/research/measuring-agent-autonomy

- **~50% of all agentic activity is software engineering tasks**
- 99th percentile Claude Code session length: under 25 min (Oct 2025) → over 45 min (Jan 2026) — sessions are getting longer as trust grows
- New users enable full auto-approval in ~20% of sessions; experienced users (750+ sessions) in >40%
- Only 0.8% of tool calls are irreversible
- Agents self-initiate pauses on complex tasks more than twice as often as humans interrupt

### Effective Harnesses for Long-Running Agents
**URL:** https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents

Two-component pattern (Initializer + Coding Agent) for session continuity. Key insight: use git as state recovery. JSON feature tracking preferred over Markdown (model less likely to overwrite JSON). Single-feature-at-a-time execution prevents over-ambition.

### AWS re:Invent 2025 — What Anthropic Learned
**URL:** https://dev.to/kazuya_dev/aws-reinvent-2025-what-anthropic-learned-building-ai-agents-in-2025-aim277-16lc

"2024 was the year of Q&A chatbots. 2025 was when Claude became a collaborator in agentic loops." The shift from single-turn to multi-turn, multi-tool, multi-session interactions happened during this window.

---

## Part 2: The 8 Agent Categories — What's Actually Being Built

### Category 1: Software Engineering Agents

**What they do:** Plan, write, test, debug, and deploy production code autonomously. Work inside real codebases, run test suites, read error traces, iterate without human involvement per step.

**Sub-types:**

| Type | Example | User | What it does |
|---|---|---|---|
| Autonomous engineer | Devin (Cognition) | Enterprise engineering teams | Full ticket-to-PR pipeline |
| AI-native IDE agent | Cursor (Anysphere) | Individual developers | Deep in-editor with codebase context |
| Browser-based builder | Replit Agent | Non-technical founders | Idea → live URL in minutes |
| Reasoning-first agent | Imbue/Sculptor | Research/reliability-focused teams | Automatically detect bugs, generate tests |

**Real numbers:**
- Cognition (Devin): $1M ARR (Sept 2024) → $73M ARR (June 2025) — 73x growth in 9 months. PR merge rate: 34% → 67% year-over-year. Security vulnerability fix: 30 min → 1.5 min (20x). Java migration: 14x faster than engineers. 89% of code at Cognition itself now written by Devin.
- Cursor (Anysphere): $3B+ ARR, $29.3B valuation. NVIDIA: 40,000 engineers. Coinbase: every engineer by Feb 2025. Upwork: 25%+ higher PR volume.
- Goldman Sachs, Citi, Dell, Cisco, Ramp, Palantir all use Devin in production for: technical debt, dependency upgrades, API integrations.

**Sources:**
- https://cognition.ai/blog/devin-annual-performance-review-2025
- https://agentmarketcap.ai/blog/2026/04/11/cognition-devin-73x-arr-growth-coding-agent-revenue
- https://www.getpanto.ai/blog/cursor-ai-statistics

---

### Category 2: Legal Agents

**What they do:** Contract review, due diligence, drafting, M&A filings, compliance workflows, bulk document processing. Multi-agent: a supervisor agent breaks down the legal task, routes to specialized sub-agents, synthesizes.

**Who uses it:** 50% of Am Law 100 law firms. 500+ Fortune 500 in-house legal teams. HSBC, NBCUniversal, PwC, Dentsu.

**Real numbers:**
- Harvey AI: $190M ARR (Jan 2026), $11B valuation. 142,000+ lawyers across 1,500+ organizations in 60 countries. 700,000+ agentic legal tasks executed **daily**. 50M+ legal terms extracted weekly. Agent performance on complex tasks: 41% → 88% via iterative self-improvement.
- JPMorgan COiN: 12,000 commercial credit agreements reviewed/year. 360,000 lawyer-hours reclaimed annually. 80% error reduction.
- Salesforce legal operations agent: $5M+ in outside counsel costs eliminated.

**Key insight:** Prior tools (Kira, Luminance) pattern-matched and highlighted. Harvey's agents reason — they understand context, draft language, handle multi-document analysis.

**Sources:**
- https://www.harvey.ai/blog/autonomous-agents-legal-is-next
- https://www.harvey.ai/blog/legal-agent-benchmark-initial-results
- https://arxiv.org/pdf/2601.06216

---

### Category 3: Customer Service / CX Agents

**What they do:** Handle inbound across chat, voice, SMS, email, WhatsApp. Go beyond FAQ bots: process refunds, rebook flights, replace credit cards, handle multi-step resolution flows.

**Who uses it:** Nordstrom, Wayfair, Ramp, SoFi, Rocket Mortgage, Cigna, ADT (all Sierra customers). Sierra serves 40%+ of Fortune 50.

**Real numbers:**
- Klarna (Feb 2024): 2.3M conversations in month one. Resolution time: 11 min → under 2 min. Equivalent to 700 FTE agents at capacity. $60M saved. 35+ languages, 23 markets.
- Sierra at Ramp: 90% case resolution.
- Sierra at SoFi: +33 NPS points.
- Sierra at Rocket Mortgage: 4x higher conversion.
- Sierra AI valuation: $10B (2026).

**Nuance:** Klarna reversed course partially by May 2025 — AI handles volume, humans handle edge cases. The pattern is hybrid, not full replacement.

**Sources:**
- https://openai.com/index/klarna/
- https://sierra.ai/customers
- https://www.cmswire.com/customer-experience/sierra-ais-10b-valuation-marks-a-turning-point-for-conversational-ai/

---

### Category 4: Research and Data Analysis Agents

**What they do:** Multi-step research across web, internal docs, databases, data files. Synthesize findings, run analysis, generate reports, answer complex questions requiring judgment.

**Sub-types:**
- **Web research agents** — OpenAI Deep Research, Perplexity, Gemini Deep Research
- **Data analysis agents** — reason over datasets, run Python, generate visualizations
- **Scientific discovery agents** — hypothesis generation, literature review, experiment design

**Who uses it:** Knowledge workers in finance, consulting, pharma, academia. JPMorgan runs 450+ AI use cases in production daily.

**What's different:** Bloomberg Terminal gives structured data. Research agents read a 300-page 10-K, cross-reference 15 competitor filings, and produce an investment thesis. That reasoning step previously required a human analyst.

**Sources:**
- https://aimonk.com/agentic-ai-examples-enterprise-roi-case-studies/
- https://arxiv.org/html/2503.08979v1

---

### Category 5: Browser / Computer-Use Agents

**What they do:** Operate GUIs — websites, desktop apps, forms — by seeing screenshots and clicking/typing like a human. Used when no API exists or when the task spans GUI-only tools.

**Real examples:**
- Anthropic Computer Use (released public beta Oct 22, 2024) — Claude receives screen screenshot, takes keyboard/mouse actions, executes multi-step GUI workflows.
- OpenAI Computer Using Agent (CUA) / Operator
- browser-use (open source Python library)
- Microsoft Copilot Studio Computer Use (2025)

**What's different:** Selenium/Playwright requires brittle CSS selectors — one DOM change breaks the script. UI agents understand pages semantically, handle layout changes, work with any software.

**Sources:**
- https://www.anthropic.com/news/3-5-models-and-computer-use

---

### Category 6: Personal Productivity Agents

**What they do:** Manage calendars, inboxes, to-do lists, meeting notes, daily planning. Some run continuously in the background; others are on-demand.

**Sub-types:**
- **Calendar/scheduling** — Reclaim.ai, Motion: auto-schedule tasks and habits around meetings. Reclaim reports ~395 hours/year saved per user.
- **Executive assistant agents** — Lindy, Alfred: email triage, draft responses, coordinate schedules
- **Autonomous background agents** (run without prompting) vs. **on-demand agents** (invoked when needed)

**Who uses it:** Individual professionals, executives, founders. ~30% of consumers willing to let an AI autonomously manage certain personal tasks.

**What's different:** Google Calendar smart suggestions pattern-match time slots. Personal agents reason about priorities and context across the full picture of a person's work.

**Sources:**
- https://www.lindy.ai/blog/best-ai-agents-small-business
- https://www.kumohq.co/blog/personal-ai-agent

---

### Category 7: Domain-Vertical Agents

#### Finance
- Compliance monitoring (transaction anomaly flagging, regulatory reporting)
- Portfolio analysis, earnings research, due diligence
- Accounts payable, invoice processing
- DBS Bank: ~S$1B in AI-driven value in FY2025
- IBM watsonx Orchestrate: 150+ pre-built automations for finance ops

#### Healthcare
- Provider-facing: documentation agents process recorded consultations → structured notes → EHR update. 42% reduction in documentation time per provider.
- Patient-facing: access, scheduling, intake, care navigation
- Health plan: claims processing, billing, compliance
- Examples: Hippocratic AI, Kore.ai healthcare suite, Nuance DAX, Ambience, Suki

#### HR
- Recruiting pipeline, candidate screening, onboarding
- IBM watsonx Orchestrate pre-built HR workflows

#### Sales
- Lead research, enrichment, personalization, follow-up sequencing
- Clay, Actively: CRM-augmenting agents pulling from unstructured signals
- Salesforce Agentforce, HubSpot Breeze, Microsoft Copilot Studio + Dynamics 365

#### Supply Chain
- Walmart: autonomous inventory and replenishment across 4,700 stores
- General Mills: $20M+ in supply chain savings since FY2024
- 5,000+ daily shipments assessed autonomously for routing/vendor performance

**Sources:**
- https://aimonk.com/agentic-ai-examples-enterprise-roi-case-studies/
- https://www.ibm.com/think/insights/ai-agents-2025-expectations-vs-reality

---

### Category 8: Multi-Agent Orchestration Systems

This is the architecture layer that coordinates all other categories into compound pipelines.

**Patterns:**

| Pattern | How it works | Best for |
|---|---|---|
| Orchestrator-Worker | Supervisor decomposes goal, routes to specialists | Most enterprise workflows |
| Swarm | Agents self-organize, any agent can hand off | Open-ended tasks |
| Hierarchical | Nested orchestrators (L1 → L2 → L3 workers) | Very large scale |
| Pipeline | Sequential agents, each transforms the artifact | Document processing |

**Frameworks:**
- **LangGraph 1.0** — stateful directed graphs, lowest latency, fine-grained control, used by Cognition in production
- **CrewAI** — role-based crews, fastest developer onboarding (~35 lines for minimal agent)
- **AutoGen / AG2** — conversational multi-agent, best for debate/critique/multi-perspective, expensive at scale
- **Google ADK** — hierarchical agent tree, native A2A protocol support

**Standards:**
- **MCP** (Anthropic, Nov 2024) — connects any AI to external tools/data sources. Loblaws wrapped 50+ APIs with MCP. Sentry: 60M monthly MCP requests.
- **A2A** (Google, April 2025) — agent-to-agent discovery, task lifecycle, structured handoff between agents from different vendors.

**66.4%** of production agentic AI deployments use coordinated multi-agent approaches.

**Sources:**
- https://www.langchain.com/blog/how-and-when-to-build-multi-agent-systems
- https://latenode.com/blog/platform-comparisons-alternatives/automation-platform-comparisons/langgraph-vs-autogen-vs-crewai-complete-ai-agent-framework-comparison-architecture-analysis-2025

---

## Part 3: VC / Investor Perspective

### a16z — State of AI: 100 Trillion Token Study
**URL:** https://a16z.com/state-of-ai/

- Fastest-growing behavior on OpenRouter is "agentic inference" — models operating in extended sequences (plan → retrieve → revise → iterate)
- Reasoning and tool-use models gaining share vs. chat models
- Agentic AI funding: $1.5B / 31 deals (2024) → $2.9B / 50 deals (2025)

### OpenAI State of Enterprise AI Report 2025
**URL:** https://cdn.openai.com/pdf/7ef17d82-96bf-4dd1-9df2-228f7f377a29/the-state-of-enterprise-ai_2025-report.pdf

- Average enterprise ROI from agentic AI: **171%** (U.S. enterprises: 192%)
- Exceeds traditional automation ROI by 3x
- Gartner projects 40% of enterprise applications will include task-specific agents by 2026

### Market Size
- AI agents market: $5.25B (2024) → $7.84B (2025) → $52.62B projected (2030)
- 67% of Fortune 500 had production agentic AI deployments in 2025 (up from 19% one year prior)
- 57% of companies surveyed by G2 (August 2025) already have agents in production

**Sources:**
- https://a16z.com/state-of-ai/
- https://newmarketpitch.com/blogs/news/agentic-ai-funding-trends

---

## Part 4: Honest Assessment — What's Working vs. Hype

### What's Working (production, proven ROI)
- Coding agents (Cursor, Devin) — highest revenue, clearest ROI
- Customer service at scale (Klarna, Sierra) — volume + speed, not full replacement
- Legal document processing (Harvey) — narrow, auditable, high-value
- Finance operations — compliance monitoring, AP automation, code review

### What's Overhyped / Failing
- **Gartner (June 2025):** Agentic AI at "peak of inflated expectations." 40%+ of agentic AI projects projected cancelled by 2027 due to unclear business value and inadequate risk controls.
- **AI initiative failure rate:** 17% (2024) → 42% (2025)
- **Salesforce Agentforce:** Enterprise customers reporting outcomes that missed marketed expectations (Bloomberg, 2025)
- **Compounding error problem:** 85% per-step accuracy → only 20% success on 10-step workflows
- ~130 of thousands of "agentic AI" vendors are legitimate. The rest are "agent washing" — rebranded chatbots and RPA.

### What the ZenML 1,200-Deployment Study Found
**URL:** https://www.zenml.io/blog/what-1200-production-deployments-reveal-about-llmops-in-2025

- "Software engineering fundamentals — not frontier models — remain the primary predictor of production success"
- "Context rot" begins at 50k–150k tokens — context engineering matters more than prompt engineering
- Infrastructure guardrails are mandatory: one team spent **$47,000 in 11 days** from an infinite agent loop
- Prompt caching: reduced one customer's costs by 86%
- "What 1997 was for SQL injection, 2025 is for prompt injection"

---

## Part 5: Academic Papers

| Paper | URL | What it covers |
|---|---|---|
| Agentic AI: Architectures, Taxonomies, Evaluation | https://arxiv.org/html/2601.12560v1 | Survey of 100 papers (2022–2025). 6-dimension taxonomy. POMDP-based control loop as unifying architecture. Benchmarks: SWE-bench, OSWorld, WebArena, GAIA. |
| Agentic AI for Scientific Discovery | https://arxiv.org/html/2503.08979v1 | LLM agents for literature review, hypothesis generation, experiment design |
| Survey of AI Agent Protocols | https://arxiv.org/pdf/2504.16736 | MCP, A2A, and emerging agent communication standards |
| Multi-level Value Alignment in Agentic AI | https://arxiv.org/pdf/2506.09656 | Alignment, safety, governance in multi-agent systems |
| Stop Wasting Your Tokens | https://arxiv.org/pdf/2510.26585 | Token efficiency in production multi-agent deployments |
| LLM Agents in Law | https://arxiv.org/pdf/2601.06216 | Taxonomy: document analysis, contract review, litigation support, compliance |
| 2025 AI Agent Index | https://arxiv.org/pdf/2602.17753 | Comprehensive index of agent capabilities |
| Data Agents | https://arxiv.org/html/2602.04261v1 | L0–L5 autonomy scale for data analysis agents |

---

## Part 6: What Genesis Can Build From This

Every category above maps to agent types Genesis should be able to create:

| Agent Category | Genesis feasibility | What's needed |
|---|---|---|
| Coding agent (review, refactor, analyze) | **Now** — capabilities exist | web_search + code execution via Modal |
| Research agent (web + synthesis) | **Now** — web_search + compose | Multi-step orchestration |
| Data analysis agent | **Now** with Modal sandbox | Code execution, file input |
| Customer service agent | **Now** — compose + notify_webhook | Webhook for outbound, input parsing |
| Legal document review | **Now** — compose + file read | Long-context handling |
| Scheduling / recurring agents | **Missing** — needs scheduler | CronScheduler (next to build) |
| Browser / computer-use agent | **Not yet** — needs computer-use capability | Computer-use API via capability |
| Multi-agent orchestration | **Architecture supports it** | Supervisor manifest pattern |
| Finance/compliance monitoring | **Now** — web_search + compose | Domain-specific manifests |
| Personal assistant | **Now** + scheduling | Needs timed triggers |

The single most important missing piece to unlock the majority of real-world use cases: **scheduling** (recurring triggers). Every "runs daily at 8am", "monitors weekly", "checks hourly" pattern requires it.

---

## All Sources

### Anthropic
- https://www.anthropic.com/research/building-effective-agents
- https://www.anthropic.com/engineering/multi-agent-research-system
- https://www.anthropic.com/research/measuring-agent-autonomy
- https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents
- https://www.anthropic.com/research/trustworthy-agents
- https://dev.to/kazuya_dev/aws-reinvent-2025-what-anthropic-learned-building-ai-agents-in-2025-aim277-16lc

### OpenAI / Enterprise Reports
- https://cdn.openai.com/pdf/7ef17d82-96bf-4dd1-9df2-228f7f377a29/the-state-of-enterprise-ai_2025-report.pdf
- https://openai.com/index/klarna/

### Companies / Case Studies
- https://cognition.ai/blog/devin-annual-performance-review-2025
- https://agentmarketcap.ai/blog/2026/04/11/cognition-devin-73x-arr-growth-coding-agent-revenue
- https://www.getpanto.ai/blog/cursor-ai-statistics
- https://www.harvey.ai/blog/autonomous-agents-legal-is-next
- https://www.harvey.ai/blog/legal-agent-benchmark-initial-results
- https://www.harvey.ai/blog/harvey-raises-at-dollar11-billion-valuation-to-scale-agents-across-law-firms-and-enterprises
- https://sierra.ai/customers
- https://www.cmswire.com/customer-experience/sierra-ais-10b-valuation-marks-a-turning-point-for-conversational-ai/
- https://aimonk.com/agentic-ai-examples-enterprise-roi-case-studies/
- https://letsdatascience.com/news/ai-agents-demonstrate-practical-enterprise-use-cases-d63dbdaa
- https://skywork.ai/blog/ai-agents-case-studies-2025/

### VC / Market Research
- https://a16z.com/state-of-ai/
- https://www.lewis-lin.com/blog/top-50-ai-startups-of-2025-andreessen-horowitzs-a16z-list
- https://newmarketpitch.com/blogs/news/agentic-ai-funding-trends
- https://menlovc.com/perspective/2025-the-state-of-generative-ai-in-the-enterprise/
- https://www.marketsandmarkets.com/Market-Reports/agentic-ai-market-208190735.html

### Engineering / Production
- https://www.zenml.io/blog/what-1200-production-deployments-reveal-about-llmops-in-2025
- https://www.langchain.com/blog/how-and-when-to-build-multi-agent-systems
- https://developers.googleblog.com/architecting-efficient-context-aware-multi-agent-framework-for-production/
- https://latenode.com/blog/platform-comparisons-alternatives/automation-platform-comparisons/langgraph-vs-autogen-vs-crewai-complete-ai-agent-framework-comparison-architecture-analysis-2025
- https://www.getmaxim.ai/articles/top-5-ai-agent-frameworks-in-2025-a-practical-guide-for-ai-builders/

### Academic
- https://arxiv.org/html/2601.12560v1
- https://arxiv.org/html/2503.08979v1
- https://arxiv.org/pdf/2504.16736
- https://arxiv.org/pdf/2506.09656
- https://arxiv.org/pdf/2510.26585
- https://arxiv.org/pdf/2601.06216
- https://arxiv.org/pdf/2602.17753
- https://arxiv.org/html/2602.04261v1

### Honest Assessment / Hype
- https://byteiota.com/gartner-40-agentic-ai-projects-fail-heres-why/
- https://www.ibm.com/think/insights/ai-agents-2025-expectations-vs-reality
- https://aiweekly.co/alerts/salesforce-agentforce-falls-short-in-enterprise-deployments
- https://cloudwars.com/cloud/the-agentic-enterprise-arrives-microsofts-copilot-and-agent-breakthroughs-of-2025/

### Small Business / Personal
- https://www.lindy.ai/blog/best-ai-agents-small-business
- https://www.kumohq.co/blog/personal-ai-agent
- https://cloud.google.com/transform/101-real-world-generative-ai-use-cases-from-industry-leaders

### Healthcare / Legal / Other Verticals
- https://www.kore.ai/blog/ai-agents-in-healthcare-12-real-world-use-cases-2026
- https://www.hoganlovells.com/en/publications/agentic-ai-in-financial-services-regulatory-and-legal-considerations
- https://www.microsoft.com/en-us/industry/blog/general/2026/03/11/modernizing-regulated-industries-with-cloud-and-agentic-ai/
- https://sanalabs.com/agents-blog/leading-ai-enterprise-fortune-500
