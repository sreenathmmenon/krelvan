// Krelvan capability catalog — the bundled "marketplace" of installable capabilities.
//
// v1 is a curated, shipped catalog (install-by-definition): each entry carries the
// payload needed to install it through the EXISTING endpoints (a YAML body for
// `POST /api/capabilities`, or an MCP connection config for `POST /api/mcp`). This
// looks and behaves like a real marketplace today and swaps to a live registry later
// with no UI change — keep this shape aligned with the future registry response.
//
// NOTE: these are real, honest entries (official = shipped/known-good patterns;
// community = illustrative wrappers). No fabricated download counts or ratings.

export type CatalogKind = "yaml" | "mcp";
export type CatalogTier = "official" | "community";

export interface CatalogEntry {
  name: string;
  title: string;
  oneLiner: string;
  category: string;
  sideEffect: string;
  estimateCents: number;
  tier: CatalogTier;
  author: string;
  kind: CatalogKind;
  /** secret refs the capability needs (rendered as a scope list) */
  secretRefs?: string[];
  /** install payload — a YAML body, or an MCP connection config */
  yaml?: string;
  mcp?: { name: string; command?: string; args?: string[]; url?: string; defaultSideEffect?: string };
}

export const CATALOG: CatalogEntry[] = [
  // ── Official connectors (MCP) ──────────────────────────────────────────────
  {
    name: "github", title: "GitHub", oneLiner: "Read repos, issues and PRs — every tool becomes a capability.",
    category: "Connectors", sideEffect: "read", estimateCents: 0, tier: "official", author: "Krelvan", kind: "mcp",
    mcp: { name: "github", command: "npx", args: ["-y", "@modelcontextprotocol/server-github"], defaultSideEffect: "read" },
    secretRefs: ["GITHUB_TOKEN"],
  },
  {
    name: "filesystem", title: "Filesystem", oneLiner: "Give an agent scoped read/write access to a local folder.",
    category: "Connectors", sideEffect: "write-reversible", estimateCents: 0, tier: "official", author: "Krelvan", kind: "mcp",
    mcp: { name: "filesystem", command: "npx", args: ["-y", "@modelcontextprotocol/server-filesystem"], defaultSideEffect: "write-reversible" },
  },
  {
    name: "slack", title: "Slack", oneLiner: "Post and read messages in your workspace channels.",
    category: "Connectors", sideEffect: "message-human", estimateCents: 0, tier: "official", author: "Krelvan", kind: "mcp",
    mcp: { name: "slack", command: "npx", args: ["-y", "@modelcontextprotocol/server-slack"], defaultSideEffect: "message-human" },
    secretRefs: ["SLACK_BOT_TOKEN"],
  },

  // ── Official YAML capabilities (HTTP wrappers) ─────────────────────────────
  {
    name: "weather.fetch", title: "Weather", oneLiner: "Fetch the current forecast for any location.",
    category: "Research", sideEffect: "read", estimateCents: 0, tier: "official", author: "Krelvan", kind: "yaml",
    yaml: `name: weather.fetch
description: Fetch the current weather forecast for a location
sideEffect: read
estimateCents: 0
http:
  url: https://api.open-meteo.com/v1/forecast?latitude={{input.lat}}&longitude={{input.lon}}&current_weather=true
  method: GET
input:
  lat: { type: string, required: true }
  lon: { type: string, required: true }
responseField: current_weather
`,
  },
  {
    name: "hn.top", title: "Hacker News", oneLiner: "Pull the current top stories from Hacker News.",
    category: "Research", sideEffect: "read", estimateCents: 0, tier: "official", author: "Krelvan", kind: "yaml",
    yaml: `name: hn.top
description: Fetch the current top stories from Hacker News
sideEffect: read
estimateCents: 0
http:
  url: https://hacker-news.firebaseio.com/v0/topstories.json
  method: GET
`,
  },

  // ── Community (unsigned — install requires risk ack) ───────────────────────
  {
    name: "stripe.charge", title: "Stripe charge", oneLiner: "Create a charge — spends real money, gates for approval.",
    category: "Payments", sideEffect: "spend", estimateCents: 0, tier: "community", author: "community", kind: "yaml",
    secretRefs: ["STRIPE_API_KEY"],
    yaml: `name: stripe.charge
description: Create a Stripe charge (spends money)
sideEffect: spend
estimateCents: 0
http:
  url: https://api.stripe.com/v1/charges
  method: POST
  headers:
    Authorization: "Bearer {{secret:STRIPE_API_KEY}}"
  body:
    amount: "{{input.amount}}"
    currency: "{{input.currency}}"
input:
  amount: { type: string, required: true }
  currency: { type: string, required: true }
`,
  },
  {
    name: "discord.notify", title: "Discord notify", oneLiner: "Send a message to a Discord channel via webhook.",
    category: "Messaging", sideEffect: "message-human", estimateCents: 0, tier: "community", author: "community", kind: "yaml",
    secretRefs: ["DISCORD_WEBHOOK"],
    yaml: `name: discord.notify
description: Post a message to a Discord channel
sideEffect: message-human
estimateCents: 0
http:
  url: "{{secret:DISCORD_WEBHOOK}}"
  method: POST
  body:
    content: "{{input.message}}"
input:
  message: { type: string, required: true }
`,
  },
];
