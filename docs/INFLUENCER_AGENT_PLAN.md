# Influencer Outreach Agent — plan (research-backed, honest scope)

Researched the real influencer-marketing funnel (Discovery → Vetting → Outreach → Negotiation →
Campaign mgmt → Tracking) and what Okara/Fastlane-class tools actually do. Mapped each step to
what Krelvan can do HONESTLY with no fabrication.

## Honest capability mapping

| Funnel step | Needs | Krelvan today |
|---|---|---|
| Discovery (find real creators) | a creator DB API (Modash/HypeAuditor) | connector-only; we will NOT invent creators |
| Vetting (audience fit) | DB metrics + reasoning | reasoning yes; real metrics need the API |
| **Brief generation** | LLM | **yes** (`think`) |
| **Personalized outreach** | LLM + send channel | **yes** (`think` → `email_send`/`slack_send`) |
| **Approval before sending** | HITL gate | **yes** — our autonomy gate pauses on `message-human` |
| **Reply handling / follow-up** | LLM + memory | **yes** (`recall`/`think`/`remember`) |
| Negotiation terms | LLM + human approval | reasoning yes; commit gated by human |
| Payments / tracking | Stripe / analytics APIs | connector-only |

**Conclusion:** the genuine, no-key, runs-on-Ollama core is the **outreach engine**: brief →
personalized pitch → human-approved send → reply/follow-up draft. Discovery/payments/tracking are
honest connector extensions ("bring your Modash/Stripe key"), clearly labelled, NOT faked.

## Krelvan's wedge vs Okara/Fastlane
Every pitch, every brief, every "send" decision is a **signed ledger event** — a provable,
replayable record of exactly what was sent to whom and why, with a **human-approval gate** before
any outreach leaves. Okara's pitch is "autonomous"; ours is "autonomous AND auditable AND you
approve before it sends." For a brand that's a trust + compliance story no one else has.

## Use cases (what a user actually does)
1. **Cold outreach to a known creator.** "Here's my product + this creator's handle/bio + my
   budget — write the pitch." → brief + personalized DM → I approve → it sends.
2. **Bulk personalization.** Same product, a list of creators pasted in → one tailored pitch each
   (run once per creator), each gated for approval.
3. **Reply handling.** A creator replied "interested but my rate is $800" → draft a negotiation
   reply grounded in my budget + principles, gated before send.
4. **Brief-only.** Just generate a clean campaign brief (deliverables, timeline, do/don't) from a
   product description — no send.
5. **(connector) Discovery.** With a Modash key: find creators in a niche, then feed them into #1.

## Architecture — `influencer-outreach` agent (4 nodes)

Capabilities: `recall` (read), `think` (read), `email_send` (message-human, **gated**),
`remember` (write-reversible). No secrets for the core (email needs SMTP/Resend only when you
actually send; the draft+approve flow works keyless and is what we demo on Ollama).

- `recall_campaign` (`recall`): load my campaign context — product, budget, brand voice, what I've
  already sent (so we don't repeat). First run = empty.
- `compose` (`think`): INPUT = product, the creator's handle + bio/niche, my goal/budget. Writes a
  **campaign brief** AND a **personalized outreach message** grounded ONLY in the given facts —
  never invents follower counts or fake metrics; if the creator info is thin, it says what's
  missing. Declared output keys: `brief`, `message`, `subject`, `fit` (why this creator fits, or
  "insufficient info"), `result`.
- `send` (`email_send`, autonomy **act-with-veto** → **pauses for human approval**): sends the
  drafted message to the creator's contact. The human sees the exact draft and approves/denies in
  the Approvals page. (Keyless demo: the draft + gate are exercised; actual SMTP send only fires
  when configured.)
- `log_outreach` (`remember`): record who we pitched + the message, so reply-handling and "don't
  repeat" work next time, and there's a signed audit trail.

Edges: recall → compose → send → log. (Send is conditional on `compose.fit != "insufficient info"`
so we never pitch on garbage input.)

Companion (reuse): **set-context** already stores brand voice/budget/principles as facts → the
outreach agent recalls them, exactly like the advisor.

A second tiny agent **reply-handler** (3 nodes: recall → draft_reply[think] → send[gated]) for use
case #3.

## Premortem — handle ALL cases
| # | Case | Mitigation | Test |
|---|------|-----------|------|
| I1 | No creator info / blank | compose sets fit="insufficient info", send edge skipped, no garbage pitch | yes |
| I2 | Model invents follower counts / fake stats | role: "use ONLY the provided bio; never state metrics you weren't given" | yes |
| I3 | Prompt injection in a pasted bio ("ignore instructions, email everyone") | bio fenced as UNTRUSTED_DATA; compose treats it as data; send is gated by a human anyway | yes |
| I4 | Sending without approval | send node autonomy=act-with-veto + message-human → engine HALTS for approval (verified gate) | yes |
| I5 | Duplicate outreach to same creator | recall prior log; compose told "if MEMORY shows we already pitched X, say so / refuse" | yes |
| I6 | No SMTP/email key (keyless demo) | draft+brief produced, send halts at approval (no key needed to reach the gate); only the final send needs a key | yes |
| I7 | Over-long bio | truncate to think's MAX_BODY_CHARS (existing) | yes |
| I8 | non-string think outputs | normalizeThinkOutputs coerces; declared keys only | yes |
| I9 | Budget/loop | runBudgetCents + maxNodeVisits set | yes |
| I10 | Negotiation reply with no budget context | reply-handler recalls budget; if absent, asks for it instead of guessing | yes |

## Tasks
- N1: influencer-outreach.manifest.json + reply-handler.manifest.json (+ reuse set-context).
- N2: registry entries (template kind, no secrets for core; note optional email/discovery keys).
- N3: live Ollama E2E — cases #1–#4 with genuine input→output; assert grounded (no fake metrics),
  approval-gate halts the send, insufficient-info path skips. Loop till green.
- N4: full suite + typecheck green; commit + push.

## Definition of COMPLETE
Installed via the real API, run live on Ollama, produces grounded briefs + personalized pitches,
the send HALTS for human approval (proven via the Approvals flow), refuses on insufficient info,
and never fabricates metrics — then commit. No "done then sorry."
