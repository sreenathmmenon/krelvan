// Krelvan capability registry — the live marketplace source.
//
// The "Discover" tab fetches a registry index.json from a GitHub repo (raw URL),
// configurable via NEXT_PUBLIC_KRELVAN_REGISTRY_URL. This is the "WordPress.org for
// agents" model: the registry IS a Git repo — anyone publishes by opening a PR that
// adds an entry to index.json (community) or you curate official entries. No separate
// marketplace server to host.
//
// If the remote registry is unreachable (offline / first boot), we fall back to the
// SEED below — which is the exact content you'd commit to the registry repo. Every
// entry here is REAL and installs through the existing endpoints (a YAML HTTP wrapper
// to a real public API, or a real MCP server). No fabricated/non-working entries.

export type CatalogKind = "yaml" | "mcp";
export type CatalogTier = "official" | "community";

export interface CatalogEntry {
  name: string;
  title: string;
  oneLiner: string;
  category: string;
  sideEffect: string;
  tier: CatalogTier;
  author: string;
  kind: CatalogKind;
  secretRefs?: string[];
  /** pricing — free entries omit these; paid entries carry both. */
  price?: string;        // e.g. "$5/mo" — display only
  licenseUrl?: string;   // where to buy/get a license key
  sourceUrl?: string;    // the GitHub source for this capability
  yaml?: string;
  mcp?: { name: string; command?: string; args?: string[]; url?: string; defaultSideEffect?: string };
}

// The default registry repo (raw index.json). Override with the env var to point at
// your own fork. Example shape once the repo exists:
//   https://raw.githubusercontent.com/<owner>/krelvan-registry/main/index.json
export const REGISTRY_URL =
  process.env["NEXT_PUBLIC_KRELVAN_REGISTRY_URL"] ?? "";

// ── SEED registry — the exact index.json content for the registry repo ──────────
// Every entry is real and working: YAML wrappers target real keyless public APIs;
// MCP entries are real published servers. Paid entries demonstrate the free/paid
// boundary with real license-flow fields (no fake prices on free items).
export const REGISTRY_SEED: CatalogEntry[] = [
  // ── Official connectors (real MCP servers) ────────────────────────────────
  {
    name: "github", title: "GitHub", oneLiner: "Read repos, issues and PRs — every tool becomes a capability.",
    category: "Connectors", sideEffect: "read", tier: "official", author: "Krelvan", kind: "mcp",
    sourceUrl: "https://github.com/modelcontextprotocol/servers/tree/main/src/github",
    mcp: { name: "github", command: "npx", args: ["-y", "@modelcontextprotocol/server-github"], defaultSideEffect: "read" },
    secretRefs: ["GITHUB_TOKEN"],
  },
  {
    name: "filesystem", title: "Filesystem", oneLiner: "Give an agent scoped read/write access to a local folder.",
    category: "Connectors", sideEffect: "write-reversible", tier: "official", author: "Krelvan", kind: "mcp",
    sourceUrl: "https://github.com/modelcontextprotocol/servers/tree/main/src/filesystem",
    mcp: { name: "filesystem", command: "npx", args: ["-y", "@modelcontextprotocol/server-filesystem"], defaultSideEffect: "write-reversible" },
  },

  // ── Official YAML capabilities (real keyless public APIs — work immediately) ─
  {
    name: "hn.top", title: "Hacker News", oneLiner: "Fetch the current top stories from Hacker News.",
    category: "Research", sideEffect: "read", tier: "official", author: "Krelvan", kind: "yaml",
    sourceUrl: "https://github.com/sreenathmmenon/krelvan-registry",
    yaml: `name: hn.top
description: Fetch the current top story ids from Hacker News
sideEffect: read
estimateCents: 0
http:
  url: https://hacker-news.firebaseio.com/v0/topstories.json
  method: GET
`,
  },
  {
    name: "weather.fetch", title: "Weather", oneLiner: "Current forecast for any latitude/longitude — no key needed.",
    category: "Research", sideEffect: "read", tier: "official", author: "Krelvan", kind: "yaml",
    sourceUrl: "https://github.com/sreenathmmenon/krelvan-registry",
    yaml: `name: weather.fetch
description: Fetch the current weather for a location (Open-Meteo, no key)
sideEffect: read
estimateCents: 0
http:
  url: https://api.open-meteo.com/v1/forecast?latitude={{input.lat}}&longitude={{input.lon}}&current_weather=true
  method: GET
input:
  lat:
    type: string
    required: true
  lon:
    type: string
    required: true
responseField: current_weather
`,
  },
  {
    name: "wikipedia.summary", title: "Wikipedia", oneLiner: "Get the summary extract for any Wikipedia article.",
    category: "Research", sideEffect: "read", tier: "official", author: "Krelvan", kind: "yaml",
    sourceUrl: "https://github.com/sreenathmmenon/krelvan-registry",
    yaml: `name: wikipedia.summary
description: Fetch the summary of a Wikipedia article
sideEffect: read
estimateCents: 0
http:
  url: https://en.wikipedia.org/api/rest_v1/page/summary/{{input.title}}
  method: GET
input:
  title:
    type: string
    required: true
`,
  },

  // ── Community (unsigned — install requires risk ack) ───────────────────────
  {
    name: "discord.notify", title: "Discord notify", oneLiner: "Post a message to a Discord channel via webhook.",
    category: "Messaging", sideEffect: "message-human", tier: "community", author: "community", kind: "yaml",
    secretRefs: ["DISCORD_WEBHOOK"],
    sourceUrl: "https://github.com/sreenathmmenon/krelvan-registry",
    yaml: `name: discord.notify
description: Post a message to a Discord channel webhook
sideEffect: message-human
estimateCents: 0
http:
  url: "{{secret:DISCORD_WEBHOOK}}"
  method: POST
  body:
    content: "{{input.message}}"
input:
  message:
    type: string
    required: true
`,
  },

  // ── Paid example (real free→paid boundary; license flow) ───────────────────
  {
    name: "serp.search", title: "SERP Search (Pro)", oneLiner: "Google-grade web search results via a managed SERP API.",
    category: "Research", sideEffect: "read", tier: "community", author: "marketplace", kind: "yaml",
    price: "from $5/mo", licenseUrl: "https://serpapi.com/",
    secretRefs: ["SERP_API_KEY"],
    sourceUrl: "https://github.com/sreenathmmenon/krelvan-registry",
    yaml: `name: serp.search
description: Web search results via SerpApi (requires a SERP_API_KEY)
sideEffect: read
estimateCents: 0
http:
  url: https://serpapi.com/search.json?q={{input.q}}&api_key={{secret:SERP_API_KEY}}
  method: GET
input:
  q:
    type: string
    required: true
`,
  },
];

// Fetch the live registry; fall back to the seed if unreachable or not configured.
export async function loadRegistry(): Promise<{ entries: CatalogEntry[]; source: "remote" | "bundled" }> {
  if (REGISTRY_URL) {
    try {
      const res = await fetch(REGISTRY_URL, { cache: "no-store" });
      if (res.ok) {
        const data = await res.json() as { capabilities?: CatalogEntry[] } | CatalogEntry[];
        const entries = Array.isArray(data) ? data : (data.capabilities ?? []);
        if (entries.length > 0) return { entries, source: "remote" };
      }
    } catch { /* fall through to bundled seed */ }
  }
  return { entries: REGISTRY_SEED, source: "bundled" };
}
