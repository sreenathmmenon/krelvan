# The Public Surface — the Agent Front Door, and its trust model

Krelvan agents are private by default. Workstream B adds an opt-in **public surface** so an
owner can put one agent in front of the world: a public page at `/a/:slug`, an optional
published-output feed, and an embeddable chat widget. This document states exactly what that
surface exposes, what authenticates it, and — most importantly — where the boundaries are,
because a trust claim that hides its own limits isn't one.

## Deny-by-default

Nothing is public until the owner flips it. `AgentPublicConfig` is `{ enabled, showFeed, chat }`,
all `false` on a fresh agent. Every `/api/public/*` route 404s unless the matching flag is on,
and an absent agent and a private agent are indistinguishable (both `404 not found`, no oracle).
Disabling any flag kills the corresponding surface instantly — including the site key, which is
dropped the moment chat is turned off.

## The site-key trust model

Chat turns are authenticated by a per-agent **site key** (`pk_…`). It is deliberately a *weak,
public* credential — do not reason about it like the admin session or the webhook trigger token.

- **Once chat is enabled, the site key is discovery-public by design.** It is embedded in the
  widget snippet that runs on other people's sites, and `GET /api/public/agents/:slug` returns it
  so the `/a/:slug` storefront can chat. Anyone who can reach the storefront can obtain it. This is
  intentional, not a leak.
- **Its only power** is to start a chat turn under the agent's *existing* grants (zero capability
  widening — a public turn can do nothing the agent couldn't already do) and to read the public
  feed. It cannot read run records, cannot approve a parked action, cannot see costs or internal
  ids, and cannot change any configuration.
- **Rotation is a re-key, not a revocation lever.** `POST /public/rotate-key` mints a new key and
  invalidates the old one — useful hygiene (refresh a stale snippet), but the new key is just as
  public. Rotating does *not* stop an abuser, because the replacement is equally discoverable. To
  actually turn an agent off, **disable chat** (which drops the key entirely).
- **`allowedOrigins` constrains browsers only.** When set, `/ask` checks the request `Origin`
  header against the allowlist, so the widget won't run on unlisted sites (an embedding/UX control).
  A non-browser client can forge `Origin`, so this is *not* a hard authentication boundary.

### What actually stops abuse

Because the key is public, the binding abuse controls are **rate limits and run caps**, enforced
on the ask path and independent of the key:

- **Per-IP throttle** on every `/api/public/*` route (60/min): blunts scraping and floods.
- **Per-thread and per-agent run caps** (sliding windows, env-tunable
  `KRELVAN_PUBLIC_THREAD_MAX` / `KRELVAN_PUBLIC_AGENT_MAX` / `KRELVAN_PUBLIC_WINDOW_MS`): stop a
  single conversation or a single agent from being cost-drained. When a cap trips, the response is
  `429` with a plain message and **no cost or budget numbers** (AGENTS.md rule 3 applies to public
  surfaces too).

So: the key gates *who is talking to which agent*; the rate limits and caps gate *how much it can
cost you*. The second is the load-bearing control.

## The human-approval gate is honored verbatim

A public chat turn runs through the same engine as any other run. If a node is approval-gated
(autonomy `suggest` on a consequential effect), the public ask **parks** — it returns
`202 { status: "awaiting-approval" }`, nothing is sent, and the parked action waits in the admin
Approvals page. A public caller can never approve; only the owner, in the authenticated admin, can
release it. When they do, the run resumes and the approval is recorded in the signed ledger like
any other.

## What a public response never contains

No `runId`, no artifact id, no agent id, no internal identifiers, and no cost/budget numbers — in
any success body or error. The public share payload and the feed items carry only rendered output
plus the agent name and a timestamp.

## Where the site-key plaintext lives

`agents.json` stores only the **hash** of the site key (for constant-time verification). The
plaintext is stored **encrypted** (AES-256-GCM) in the secret store under a reserved
`__sitekey__<agentId>` name, so the profile endpoint and the admin snippet can re-serve the
public key without persisting it in cleartext. Reserved `__`-prefixed secrets are hidden from the
admin Secrets list.

## Manual-check list (not automated)

The route/security behavior is covered by `src/api/public-surface.test.ts` and the acceptance e2e
in `src/api/acceptance.test.ts`. A few things are visual or environment-dependent and are checked
by hand (screenshots archived under `web/audit/`):

- `/a/:slug` and the widget render with **no admin chrome** (no nav, footer, or admin links) —
  automated as a DOM assertion in the e2e, and re-confirmed visually.
- The widget mounts and chats **cross-origin** from a real third-party origin (Chrome's Private
  Network Access blocks the loopback dev case, so this is verified from a served page, not `data:`).
- A **real** chat answer requires a configured LLM; the test environment exercises the full
  request/park/reply *mechanism* but returns the graceful "couldn't answer just now" fallback when
  no model is set.
