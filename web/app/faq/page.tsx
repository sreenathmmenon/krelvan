import type { Metadata } from "next";
import type { ReactNode } from "react";
import Link from "next/link";
import { glyphFor, UI } from "../../lib/glyphs";

// FAQ — grouped, honest answers rendered as native <details>/<summary> accordions
// (keyboard-accessible for free, zero JS). Every claim on this page is true of the
// shipped product; the "honest limits" section says plainly what isn't built yet.
// Content is a typed data structure so the on-page answers and the FAQPage JSON-LD
// are generated from the same source and can never drift apart.

export const metadata: Metadata = {
  title: "FAQ — Krelvan",
  description:
    "Straight answers about Krelvan: building agents that research, draft, and act, self-hosting, supported models, delivery to your inbox and channels, autonomy and approvals, budgets, security, and today's honest limits.",
};

type QA = { q: string; a: string[] };
type Section = { id: string; title: string; icon: string; items: QA[] };

// Backtick spans render as inline <code>; the JSON-LD strips them to plain text.
const SECTIONS: Section[] = [
  {
    id: "basics",
    title: "The basics",
    icon: UI.spark,
    items: [
      {
        q: "What is Krelvan?",
        a: [
          "Krelvan is a self-hostable, open-source platform for building and running AI agents you own. You describe a goal in plain English; Krelvan builds a real agent, shows you the plan before anything executes, runs it on your machine, and keeps a complete, replayable record of every step it took.",
          "The core idea: the canvas is the runtime. Every step of a run is a real recorded event, and the visual canvas, the run timeline, and the history are all direct reads of that one record — so what you see is exactly what executed.",
        ],
      },
      {
        q: "Is it free? Is it really open-source?",
        a: [
          "Yes. Krelvan is Apache-2.0. You self-host it on your own machine, run it for yourself, your team, or your clients, extend it, and build free or paid solutions on top — you own what you build. There is no license fee and no metering; the only running cost is whatever you pay your model provider, and with a local model that can be nothing.",
        ],
      },
      {
        q: "Is Krelvan a hosted service? Do I need an account?",
        a: [
          "No. Krelvan is self-host first: the API, the web UI, and all your data run on your own box, and there is no hosted edition today. The only account is the admin credential you create for your own install — self-hosted auth with scrypt password hashing, sessions, and CSRF protection — so an internet-facing box stays yours.",
        ],
      },
      {
        q: "How do I install and run it?",
        a: [
          "Two ways. With Node 22+, clone the repository and run `npx krelvan` — one command builds and starts both the API (port 3201) and the web UI (port 3100). Or run `docker compose up --build` for the same result.",
          "Everything Krelvan persists lives in a single data directory — the SQLite database plus your secret keys — so backing up your install means backing up one folder.",
        ],
      },
      {
        q: "Do I need an LLM API key just to try it?",
        a: [
          "No. The web UI and API boot with no secrets at all — the app runs and clearly reports that LLM features are off. Building agents, run explanations, and failure diagnosis switch on when you connect a provider: either an API key, or a local Ollama model with no key and no network.",
        ],
      },
    ],
  },
  {
    id: "runs",
    title: "How runs work",
    icon: UI.shield,
    items: [
      {
        q: "What does “the canvas is the runtime” mean?",
        a: [
          "In most systems, execution happens somewhere and a log is written about it afterwards — and the two can drift. In Krelvan the visual canvas, the run timeline, the history, and even agent memory are all direct reads of the same recorded run. There is no separate “what happened” store that could disagree.",
          "That single design choice is why “what you see is exactly what executed” is structural rather than hopeful — there is nothing else the UI could be showing you.",
        ],
      },
      {
        q: "Can I replay exactly what an agent did?",
        a: [
          "Yes. Every step of a run is recorded as a real event, so you can scrub back through any run step by step and see precisely what the agent read, decided, and did — the same view whether the run finished a minute ago or last month.",
        ],
      },
      {
        q: "What happens if a run crashes halfway?",
        a: [
          "It resumes safely. The run's state lives entirely in its recorded history, so resuming is just re-reading it: the engine sees exactly which steps completed and continues from there. Side effects use a three-step protocol (intent, execution, result), which guarantees an irreversible effect — sending an email, calling a paid API — runs exactly once, never twice, even if the process dies mid-step.",
          "There's a runnable demo: `npm run demo:resume` kills a run mid-flight, resumes it, and shows each irreversible effect executed exactly once.",
        ],
      },
    ],
  },
  {
    id: "models",
    title: "Models & your data",
    icon: glyphFor("http"),
    items: [
      {
        q: "Which LLM providers can I use?",
        a: [
          "Seven, behind one client: Anthropic, OpenAI, Google Gemini, Groq, Mistral, Ollama (fully local), and any OpenAI-compatible endpoint — so a self-hosted gateway or another vendor's compatible API works too. The provider is configuration, not architecture: you can switch without rebuilding your agents.",
        ],
      },
      {
        q: "Can it run fully local?",
        a: [
          "Yes. Set the provider to Ollama and Krelvan runs against a model on your own hardware — no API key, no network calls to any model vendor. RAG works fully local too: `rag.ingest` and `rag.search` can use local embeddings via Ollama, so a document-grounded agent can run entirely offline.",
        ],
      },
      {
        q: "Does my data leave my machine?",
        a: [
          "Only where you point it. Krelvan is self-hosted: your agents, your runs, and your documents live in your own data directory. The only outbound calls are the ones you configure — your chosen model provider, plus whatever capabilities you explicitly grant (an HTTP API, an MCP server). With Ollama, even the model calls stay on your machine.",
          "Secrets are encrypted at rest with AES-256-GCM, and they never enter plugin code — a broker injects them at the destination on the host.",
        ],
      },
    ],
  },
  {
    id: "control",
    title: "Control & safety",
    icon: UI.check,
    items: [
      {
        q: "Can an agent act without my approval?",
        a: [
          "Only to the degree you allow. Every step has an autonomy level — `suggest` (propose only), `act-with-veto` (act, but pause first on anything risky), or `full`. Independently, every capability declares a side-effect class, and irreversible or spend-class actions pause for human approval and show you the exact action it wants to take, not a summary.",
          "Capabilities are deny-by-default: one that was never granted never runs, no matter what the model asks for.",
        ],
      },
      {
        q: "What are budgets?",
        a: [
          "Hard ceilings, enforced before a step runs. Each run and each capability carries a ceiling in integer cents, and admission uses reserve-then-settle: the projected amount is reserved before dispatch, then settled to what was actually observed afterwards. A step that would exceed its run or per-capability ceiling is refused up front — the model can't spend its way past the limit, and concurrent calls can't each sneak under it.",
        ],
      },
      {
        q: "How does Krelvan handle prompt injection?",
        a: [
          "Honestly: no agent platform can make prompt injection impossible, and we won't claim otherwise. What Krelvan does is bound the blast radius with mechanical guards: capability monotonicity in the compiler (content an agent read can never widen what the agent is allowed to do), untrusted inbound content is quarantined in memory with provenance, conditional logic is a restricted typed-AST evaluator — there is no `eval` anywhere — and outbound HTTP goes through an allowlisted, SSRF-guarded egress channel.",
          "And because every step is recorded, if something does go wrong you can see exactly what happened, after the fact.",
        ],
      },
      {
        q: "How are third-party capabilities sandboxed?",
        a: [
          "By trust tier. Declarative YAML capabilities and MCP connectors are data, not code — safe by construction. Untrusted TypeScript plugins run in a real OS-process sandbox (`node --permission`): filesystem writes, child processes, native addons, workers, and WASI are denied, with memory and timeout caps and a scrubbed environment.",
          "Plugins reach the network only through the brokered, allowlisted, SSRF-guarded channel; secrets never enter the plugin process; and a supervisor co-signs what it mechanically observed — a plugin can never sign facts about its own behaviour. This sandbox is adversarially tested.",
        ],
      },
    ],
  },
  {
    id: "build",
    title: "Building & extending",
    icon: UI.plug,
    items: [
      {
        q: "How do I build an agent?",
        a: [
          "Describe the outcome in plain English. Krelvan compiles that into a validated, typed agent graph — the model acts as a compiler into a manifest the kernel runs; it never executes free-form code — and shows you the plan before anything runs. Approve it, run it, and open the full run history.",
          "You can also start from a ready-made template in the marketplace — a price monitor, a RAG support bot, a knowledge-base ingester — and make it yours.",
        ],
      },
      {
        q: "Can I build agents for my clients or customers?",
        a: [
          "Yes — that's an intended use, and Apache-2.0 permits it commercially. The fastest path: install a template (say the RAG support bot), then use its customize surface to rename it, point it at the client's knowledge base, and set their tone and autonomy limits. Each clone is baked into a fresh manifest and installed as its own independent agent.",
          "When you deliver, the client can see exactly what the agent did — every run keeps a complete, replayable history they can scrub through step by step.",
        ],
      },
      {
        q: "How do I extend Krelvan with new tools?",
        a: [
          "Four extension surfaces, ordered by effort. A YAML capability wraps any HTTP API with no code. An MCP connector plugs in any MCP server — every tool it exposes becomes a capability. A TypeScript plugin (sandboxed, as above) covers anything custom. And an agent template packages a whole working agent — the graph, its capabilities, and the secrets it needs — installable in one click.",
          "The marketplace itself is a public Git repository, not a hosted catalog: publishing means opening a pull request, and a validator — the same one the runtime uses — gates every entry, so a broken capability can't reach the Discover tab.",
        ],
      },
      {
        q: "What happens when a run fails?",
        a: [
          "Krelvan doesn't just retry — it reasons about the failure. It reads the full history of the failed run to find the root cause and the failing step, drafts a corrected agent from that diagnosis, and re-runs it. The repair attempt is recorded too, pass or fail, so the fix is as inspectable as the failure.",
        ],
      },
      {
        q: "Can agents run on a schedule?",
        a: [
          "Yes. Cron and interval schedules run agents unattended — a price watcher every hour, a digest every morning. Scheduled runs go through exactly the same pipeline as manual ones: same budgets, same approval gates, same complete run history.",
        ],
      },
    ],
  },
  {
    id: "limits",
    title: "Honest limits",
    icon: glyphFor("monitor"),
    items: [
      {
        q: "What are the honest limitations today?",
        a: [
          "Single-tenant: an install is one workspace. There is no multi-tenant store yet (a PostgreSQL adapter is on the roadmap), so “one team, one box” is the deployment model today.",
          "Self-host only: there is no hosted edition. If you want Krelvan, you run it — which is the point, but it does mean you administer it.",
          "Local models bypass budget accounting: cost estimates for Ollama and other local endpoints are 0, so budget ceilings don't meaningfully constrain fully-local runs.",
          "Some edges are still growing: messaging channels are send-only today (an agent can message you; you can't reply to drive it), and the canvas shows and replays agent graphs but isn't a drag-to-edit editor yet.",
        ],
      },
      {
        q: "Is it production-ready?",
        a: [
          "We'd rather under-claim. This is an early release, and the status section of the README marks exactly which parts are battle-tested. The load-bearing core — the event-sourced kernel, the run history and replay, the resume-after-crash protocol, and the plugin sandbox — is the most heavily tested part of the system, including adversarial tests. Strict typecheck and the test suite run clean.",
          "Judge it yourself: the code, the tests, and a premortem doc enumerating failure modes (each with its guard and status) are all public in the repository.",
        ],
      },
    ],
  },
];

// Render backtick spans as inline <code>; everything else as plain text.
function inline(text: string): ReactNode[] {
  return text.split("`").map((part, i) =>
    i % 2 === 1 ? <code key={i}>{part}</code> : part
  );
}

// The FAQPage JSON-LD is derived from the same data as the page, backticks stripped.
const JSON_LD = JSON.stringify({
  "@context": "https://schema.org",
  "@type": "FAQPage",
  mainEntity: SECTIONS.flatMap(s =>
    s.items.map(item => ({
      "@type": "Question",
      name: item.q,
      acceptedAnswer: { "@type": "Answer", text: item.a.join(" ").replace(/`/g, "") },
    }))
  ),
});

export default function FaqPage() {
  return (
    <div style={{ background: "var(--canvas)" }}>
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON_LD }} />
      <div className="container" style={{ paddingTop: "var(--s9)", paddingBottom: "var(--s9)" }}>
        <div style={{ maxWidth: 800, margin: "0 auto" }}>
          {/* header */}
          <header style={{ marginBottom: "var(--s7)" }}>
            <p className="micro" style={{ marginBottom: "var(--s3)" }}>Questions, answered straight</p>
            <h1 className="display" style={{ marginBottom: "var(--s4)", maxWidth: "20ch" }}>
              Frequently asked <span style={{ color: "var(--brand)" }}>questions</span>.
            </h1>
            <p className="body-lg soft" style={{ maxWidth: "58ch", marginBottom: "var(--s5)" }}>
              {"What Krelvan is, how runs work, what runs where, and where the edges are today. If it isn't true of the product, it isn't on this page."}
            </p>
            {/* section jump chips */}
            <nav aria-label="FAQ sections" className="faq-toc">
              {SECTIONS.map(s => (
                <a key={s.id} href={`#${s.id}`} className="chip">{s.title}</a>
              ))}
            </nav>
          </header>

          {/* grouped Q&A */}
          {SECTIONS.map(section => (
            <section key={section.id} id={section.id} aria-labelledby={`${section.id}-h`} className="faq-section">
              <div className="faq-section__head">
                <span className="faq-section__icon" aria-hidden="true">
                  <svg viewBox="0 0 16 16" width={16} height={16} fill="none">
                    <path d={section.icon} stroke="currentColor" strokeWidth={1.4} strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                </span>
                <h2 id={`${section.id}-h`} className="h2">{section.title}</h2>
              </div>
              <div>
                {section.items.map(item => (
                  <details key={item.q} className="card faq-item">
                    <summary>
                      <span>{item.q}</span>
                      <span className="faq-item__chev" aria-hidden="true">
                        <svg viewBox="0 0 16 16" width={14} height={14} fill="none">
                          <path d={UI.chevron} stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" />
                        </svg>
                      </span>
                    </summary>
                    <div className="faq-item__body">
                      {item.a.map((para, i) => <p key={i}>{inline(para)}</p>)}
                    </div>
                  </details>
                ))}
              </div>
            </section>
          ))}

          {/* still curious */}
          <div className="card" style={{ marginTop: "var(--s8)", padding: "var(--s7) var(--s6)", textAlign: "center" }}>
            <h2 className="h2" style={{ marginBottom: "var(--s3)" }}>Still curious?</h2>
            <p className="body-lg soft" style={{ maxWidth: "48ch", margin: "0 auto var(--s5)" }}>
              {"The fastest answer is the product itself — build an agent, run it, and open the full run history. Or read the source; it's all there."}
            </p>
            <div style={{ display: "flex", gap: "var(--s3)", justifyContent: "center", flexWrap: "wrap" }}>
              <Link href="/dashboard" className="btn btn-primary">Build an agent</Link>
              <a href="https://github.com/sreenathmmenon/krelvan" className="btn btn-secondary">Read the source</a>
              <a href="mailto:hello@krelvan.com" className="btn btn-ghost">Ask us directly</a>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
