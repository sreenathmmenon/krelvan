# Authoring Capabilities & Templates for Krelvan

*Publish a connector or a whole agent to the marketplace — it runs on every self-hosted Krelvan,
you keep your users, there's no gig fee, and the signed ledger proves your capability did what it
claims. This is the WordPress-for-agents model: the marketplace **is** a Git repo.*

There are three things you can publish:

| Kind | What it is | Build effort | When to use |
|---|---|---|---|
| **`yaml`** | A declarative wrapper around one HTTP API call | minutes, zero code | Almost every connector (Slack, Sheets, a CRM, a scraper…) |
| **`mcp`** | A connection to a Model Context Protocol server (every tool becomes a capability) | a config block | A vendor/community already ships an MCP server |
| **`template`** | A whole pre-built agent: a signed manifest + the capabilities it needs | author a graph | "Install a working Price Monitor / Support Bot in one click" |

---

## 1. A YAML capability (the workhorse)

A YAML capability is pure data — no code runs, it's SSRF-guarded, and secrets are never inlined.
Full schema:

```yaml
name: slack.post                 # [a-z][a-z0-9._-]*  (unique machine name)
description: Post a message to a Slack channel.
sideEffect: message-human        # see §4 — drives when a human is asked to approve
estimateCents: 1                 # non-negative INTEGER cents (pre-flight cost estimate)
http:
  url: "https://slack.com/api/chat.postMessage"
  method: POST                   # GET | POST | PUT | PATCH | DELETE
  headers:
    Authorization: "Bearer {{secret:slack-bot-token}}"   # secrets ONLY as {{secret:NAME}}
    Content-Type: "application/json; charset=utf-8"
  body:                          # not allowed on GET
    channel: "{{input.channel}}" # inputs ONLY as {{input.field}}
    text: "{{input.message}}"
input:
  channel: { type: string, required: true, description: "Channel ID or name." }
  message: { type: string, required: true, description: "The message text." }
responseField: ok                # optional: safe dot-path to extract from the JSON response
successCodes: [200]              # optional; default [200, 201, 204]
```

**The only two interpolation patterns allowed** are `{{secret:NAME}}` and `{{input.field}}` — no `eval`,
no arbitrary property chains. The URL is checked against an SSRF guard (no loopback/metadata/private
hosts) before any request leaves the host.

**Test it locally** — drop the file in `capabilities/`, or `POST /api/capabilities` with `{name, yaml}`,
then enable it in the Capabilities UI (set the secret in `/secrets` first).

---

## 2. An MCP capability

```json
{
  "name": "github", "title": "GitHub", "oneLiner": "Read repos, issues and PRs.",
  "category": "Connectors", "sideEffect": "read", "tier": "official", "author": "you",
  "kind": "mcp", "secretRefs": ["GITHUB_TOKEN"],
  "mcp": { "name": "github", "command": "npx", "args": ["-y", "@modelcontextprotocol/server-github"], "defaultSideEffect": "read" }
}
```

Each tool the server exposes becomes a `${server}.${tool}` capability. Side effects are inferred
**fail-closed** (an unrecognised tool defaults to `write-irreversible` so it gates for approval) —
override per-tool with `toolSideEffects` if you know better.

---

## 3. A template (a whole installable agent)

A template bundles a **signed manifest** (the agent graph) with the **capabilities it needs**. A user
clicks once: Krelvan installs the capabilities, creates the agent, and tells them which secrets to set.

```json
{
  "name": "price-monitor", "title": "Price Monitor",
  "oneLiner": "Watch a page on a schedule, detect price changes, and alert you — with a signed record.",
  "category": "Templates", "sideEffect": "message-human", "tier": "official", "author": "you",
  "kind": "template",
  "secretRefs": ["slack-bot-token", "firecrawl-api-key"],
  "manifest": { /* a full Manifest: nodes, edges, entry, seed, budgets — see manifest.ts */ },
  "capabilities": [ { "name": "slack.post", "yaml": "<the slack.post YAML>" } ]
}
```

**Authoring the manifest graph** — key things the engine supports today (and a few it doesn't yet):

- A node has an ordered list of `capabilities`; a node *is* an agent when it uses `think` (real LLM
  reasoning over run state).
- **Branch on a condition** with an edge `when` (a small typed expression — `eq/ne/lt/gt/and/or/not`).
  Example: alert only when a price changed — `{ "op": "eq", "left": {"op":"var","key":"analyze.changed"}, "right": {"op":"const","value":true} }`.
- **State between nodes** is flat scalars keyed `nodeId.key` (strings/numbers/booleans). Arrays/objects
  are dropped — stringify if you need structure. **Money/decimals must be strings** (the ledger only
  stores integer numbers); `think` auto-coerces non-integers to strings.
- **Cross-run memory**: `recall` (first node) loads facts as `recall.<name>`; `remember` (last node)
  persists them. For a deterministic baseline, seed `remember_map: "fact=nodeId.key"` — `remember`
  copies that state value into the named fact with no LLM involved.
- **A capability name can appear only once per node** (idempotency keys exclude input). "reason → tool
  → reason" must be three nodes.
- **Approval gates are automatic** from the side-effect class + node autonomy (§4) — you don't wire them.
- **Schedule it** after install via `POST /api/schedules` (cron or interval).

---

## 4. Side-effect classes (be honest — they decide when a human is asked)

| Class | Meaning | Gates for approval under `act-with-veto`? |
|---|---|---|
| `read` | observes only | never |
| `write-reversible` | a writable, undoable effect | no (proceeds, vetoable) |
| `write-irreversible` | can't be undone (send email, deploy) | **yes** |
| `spend` | costs money | **yes** |
| `message-human` | notifies a person | no |
| `identity-mutation` | changes the agent's own identity/standing instructions | **yes** |

Pick the honest class — a Gmail `send` is `write-irreversible`, a CRM read is `read`. This is what
makes the autonomy gradient (`suggest` / `act-with-veto` / `full`) work.

---

## 5. Publish it

The marketplace is the Git repo [`krelvan-registry`](https://github.com/sreenathmmenon/krelvan-registry).

1. Fork it.
2. Add your entry to `index.json` (copy an existing one). Set `tier: "community"`, declare your
   `secretRefs`, an honest `sideEffect`, and for HTTP capabilities an `egressHosts` allowlist.
3. Open a PR. CI runs the validator (`registry/validate.test.ts` — same pure validators the runtime
   uses): your YAML must compile, the declared sideEffect must match, a template's manifest must
   validate and use only known/bundled capabilities. Green check → merge → it appears in every
   install's Discover tab.

No account, no marketplace server, no gatekeeper. `official` entries are signed by Krelvan (one-click);
`community` entries show a risk-ack before install.

**Paid but you-own:** add `price` + `licenseUrl` and the capability still installs free — the user
supplies their own API key, and you link your license. Krelvan never touches the money or locks the
user in.

---

## 6. Run a private marketplace (companies)

Point any install at your own fork with
`NEXT_PUBLIC_KRELVAN_REGISTRY_URL=https://raw.githubusercontent.com/<you>/krelvan-registry/main/index.json`.
A consultancy or enterprise can curate an internal catalogue of connectors + agent templates for its
clients — the open core is the wedge, your registry is private.
