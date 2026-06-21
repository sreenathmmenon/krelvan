// Self-hosted SVG glyph set for the Capabilities marketplace.
//
// No network, no external logos — every icon is an inline SVG path drawn on-brand. We key
// glyphs by capability name first, then fall back to category, then to a generic plug. This
// gives 40+ connectors a distinct, recognizable face without fetching brand logos from a CDN
// (which would break the offline / self-hosted / zero-dependency ethos).
//
// Each entry is a 16x16 path string used with stroke="currentColor".

// ── raw 16x16 path shapes ────────────────────────────────────────────────────
const P = {
  // generic / category
  plug: "M5 1.5v3M11 1.5v3M3.5 4.5h9v3a4.5 4.5 0 0 1-9 0v-3zM8 12v2.5",
  bolt: "M8 1.6l1.7 4.7L14.4 8l-4.7 1.7L8 14.4l-1.7-4.7L1.6 8l4.7-1.7L8 1.6z",
  chat: "M2.5 3.5h11v7h-6l-3 2.5v-2.5h-2v-7z",
  mail: "M2 4h12v8H2zM2.5 4.5l5.5 4 5.5-4",
  dollar: "M8 1.5v13M11 4.2c0-1.3-1.3-2-3-2s-3 .8-3 2.2c0 3 6 1.5 6 4.4 0 1.4-1.3 2.2-3 2.2s-3-.8-3-2.2",
  db: "M3 4c0-1.1 2.2-2 5-2s5 .9 5 2-2.2 2-5 2-5-.9-5-2zM3 4v8c0 1.1 2.2 2 5 2s5-.9 5-2V4M3 8c0 1.1 2.2 2 5 2s5-.9 5-2",
  globe: "M8 1.5a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13zM1.5 8h13M8 1.5c2 2 2 11 0 13M8 1.5c-2 2-2 11 0 13",
  search: "M7 12.5a5.5 5.5 0 1 0 0-11 5.5 5.5 0 0 0 0 11zM11 11l3.5 3.5",
  doc: "M4 1.5h5l3 3v10H4zM9 1.5V5h3.5",
  calendar: "M3 3h10v10H3zM3 6h10M5.5 1.5v3M10.5 1.5v3",
  code: "M5.5 5L2.5 8l3 3M10.5 5l3 3-3 3M9 3.5l-2 9",
  cart: "M2 2.5h2l1.5 7.5h6l1.5-5.5H4.5M6.5 13.5a1 1 0 1 0 0-.01M12 13.5a1 1 0 1 0 0-.01",
  brain: "M6 2.5a2 2 0 0 0-2 2 2 2 0 0 0-1 3.5A2 2 0 0 0 4 11.5a2 2 0 0 0 4 0v-9a2 2 0 0 0-2 0zM10 2.5a2 2 0 0 1 2 2 2 2 0 0 1 1 3.5 2 2 0 0 1-1 3.5 2 2 0 0 1-4 0",
  rocket: "M8 1.5c2.5 1.5 3.5 4 3.5 6.5L8 11 4.5 8c0-2.5 1-5 3.5-6.5zM8 6.5a1 1 0 1 0 0-.01M6 11l-2 3M10 11l2 3",
  phone: "M4 2.5h2l1 3-1.5 1a8 8 0 0 0 4 4l1-1.5 3 1v2c0 .8-.7 1.5-1.5 1.4C8 13.3 2.7 8 2.6 4 2.5 3.2 3.2 2.5 4 2.5z",
  folder: "M2 4c0-.8.7-1.5 1.5-1.5h2L7 4h5.5c.8 0 1.5.7 1.5 1.5v6c0 .8-.7 1.5-1.5 1.5h-9C2.7 13 2 12.3 2 11.5V4z",
  link: "M6.5 9.5l3-3M6 7l-2 2a2.5 2.5 0 0 0 3.5 3.5l2-2M10 9l2-2A2.5 2.5 0 0 0 10.5 3.5l-2 2",
  flag: "M4 14V2.5M4 3h7l-1.5 2.5L11 8H4",
  bell: "M8 2a3.5 3.5 0 0 0-3.5 3.5c0 4-1.5 5-1.5 5h10s-1.5-1-1.5-5A3.5 3.5 0 0 0 8 2zM6.5 13a1.5 1.5 0 0 0 3 0",
  sparkles: "M5 2.5l.9 2.4L8.3 6 5.9 6.9 5 9.3 4.1 6.9 1.7 6l2.4-.9L5 2.5zM11 8l.6 1.6 1.6.6-1.6.6L11 12.4l-.6-1.6L8.8 10.2l1.6-.6L11 8z",
  github: "M8 1.6a6.4 6.4 0 0 0-2 12.5c.3.06.43-.14.43-.3v-1.1c-1.8.4-2.2-.85-2.2-.85-.3-.75-.72-.95-.72-.95-.6-.4.04-.4.04-.4.65.05 1 .67 1 .67.58 1 1.5.7 1.9.55.06-.43.23-.7.42-.87-1.45-.16-2.97-.72-2.97-3.2 0-.7.25-1.3.66-1.74-.07-.16-.29-.82.06-1.7 0 0 .54-.18 1.78.66a6.1 6.1 0 0 1 3.24 0c1.24-.84 1.78-.66 1.78-.66.35.88.13 1.54.06 1.7.41.44.66 1.04.66 1.74 0 2.49-1.52 3.04-2.97 3.2.23.2.44.6.44 1.2v1.78c0 .17.12.37.44.3A6.4 6.4 0 0 0 8 1.6z",
  stripe: "M3 5.5h10l-1 5H4l-1-5zM6 8h4",
  slack: "M6 4.5a1 1 0 1 1 2 0v3a1 1 0 1 1-2 0v-3zM4.5 8a1 1 0 1 1 0 2h-1a1 1 0 1 1 0-2h1zM9.5 8a1 1 0 1 1 0-2h1a1 1 0 1 1 0 2h-1zM8 9.5a1 1 0 1 1 0 2v1a1 1 0 1 1-2 0v-1a1 1 0 0 1 2-0z",
  shield: "M8 1.6l5 1.8v3.4c0 3.2-2.1 5.4-5 6.2-2.9-.8-5-3-5-6.2V3.4L8 1.6z",
  box: "M8 1.8l5.5 3v6.4L8 14.2l-5.5-3V4.8L8 1.8zM2.6 4.9L8 7.9l5.4-3M8 7.9v6.3",
  pen: "M11 2.5l2.5 2.5-8 8L2.5 14l1-3 7.5-7.5z",
  // distinct shapes so recognizable services don't all collapse to the generic globe
  crawl: "M8 5.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5zM8 2v2M8 12v2M2 8h2M12 8h2M3.8 3.8l1.4 1.4M10.8 10.8l1.4 1.4M12.2 3.8l-1.4 1.4M5.2 10.8l-1.4 1.4", // firecrawl / scrape — radial crawler
  cloud: "M5 11.5h6.2a2.7 2.7 0 0 0 .3-5.4 3.8 3.8 0 0 0-7.2-1A2.9 2.9 0 0 0 5 11.5z",   // cloudflare / cloud egress
  sun: "M8 5a3 3 0 1 0 0 6 3 3 0 0 0 0-6zM8 1.5v1.8M8 12.7v1.8M1.5 8h1.8M12.7 8h1.8M3.4 3.4l1.3 1.3M11.3 11.3l1.3 1.3M12.6 3.4l-1.3 1.3M4.7 11.3l-1.3 1.3", // weather
  grid: "M2.5 2.5h4v4h-4zM9.5 2.5h4v4h-4zM2.5 9.5h4v4h-4zM9.5 9.5h4v4h-4z",            // google workspace / suite
};

// Capability/connector name → glyph. Names are matched by substring (case-insensitive) so
// "deploy.vercel" → rocket, "slack.post" → slack, etc.
const NAME_GLYPHS: { match: string; glyph: keyof typeof P }[] = [
  { match: "github", glyph: "github" },
  { match: "stripe", glyph: "stripe" },
  { match: "slack", glyph: "slack" },
  { match: "deploy", glyph: "rocket" },
  { match: "vercel", glyph: "rocket" },
  { match: "netlify", glyph: "rocket" },
  { match: "railway", glyph: "rocket" },
  { match: "render", glyph: "rocket" },
  { match: "cloudflare", glyph: "cloud" },
  { match: "wiki", glyph: "doc" },
  { match: "rag", glyph: "brain" },
  { match: "recall", glyph: "brain" },
  { match: "remember", glyph: "brain" },
  { match: "think", glyph: "sparkles" },
  { match: "advisor", glyph: "sparkles" },
  { match: "mail", glyph: "mail" },
  { match: "email", glyph: "mail" },
  { match: "sendgrid", glyph: "mail" },
  { match: "resend", glyph: "mail" },
  { match: "mailchimp", glyph: "mail" },
  { match: "telegram", glyph: "chat" },
  { match: "discord", glyph: "chat" },
  { match: "notify", glyph: "bell" },
  { match: "webhook", glyph: "link" },
  { match: "http", glyph: "globe" },
  { match: "web", glyph: "globe" },
  { match: "fetch", glyph: "globe" },
  { match: "scrape", glyph: "crawl" },
  { match: "firecrawl", glyph: "crawl" },
  { match: "search", glyph: "search" },
  { match: "serp", glyph: "search" },
  { match: "exa", glyph: "search" },
  { match: "brave", glyph: "search" },
  { match: "tavily", glyph: "search" },
  { match: "perplexity", glyph: "search" },
  { match: "wikipedia", glyph: "doc" },
  { match: "weather", glyph: "sun" },
  { match: "hn", glyph: "doc" },
  { match: "notion", glyph: "doc" },
  { match: "airtable", glyph: "db" },
  { match: "qdrant", glyph: "db" },
  { match: "pinecone", glyph: "db" },
  { match: "shopify", glyph: "cart" },
  { match: "buffer", glyph: "pen" },
  { match: "pipedrive", glyph: "dollar" },
  { match: "hubspot", glyph: "dollar" },
  { match: "klaviyo", glyph: "dollar" },
  { match: "apollo", glyph: "dollar" },
  { match: "calcom", glyph: "calendar" },
  { match: "cal", glyph: "calendar" },
  { match: "vapi", glyph: "phone" },
  { match: "elevenlabs", glyph: "phone" },
  { match: "voice", glyph: "phone" },
  { match: "filesystem", glyph: "folder" },
  { match: "google", glyph: "grid" },
  { match: "workspace", glyph: "grid" },
  { match: "linear", glyph: "flag" },
  { match: "price", glyph: "dollar" },
  { match: "monitor", glyph: "flag" },
  { match: "support", glyph: "chat" },
  { match: "kb", glyph: "doc" },
  { match: "context", glyph: "brain" },
  { match: "compose", glyph: "code" },
  { match: "transform", glyph: "code" },
  { match: "route", glyph: "link" },
  { match: "identify", glyph: "shield" },
  { match: "delegate", glyph: "bolt" },
];

// Category → glyph (fallback when no name match).
const CATEGORY_GLYPHS: Record<string, keyof typeof P> = {
  templates: "box",
  connectors: "plug",
  messaging: "chat",
  payments: "dollar",
  research: "search",
  crm: "dollar",
  marketing: "pen",
  voice: "phone",
  data: "db",
  developer: "code",
  dev: "code",
  ops: "bolt",
  packs: "box",
};

export type GlyphKey = keyof typeof P;

/** Resolve the best glyph path for a capability by name, then category, then generic. */
export function glyphFor(name: string, category?: string, kind?: string): string {
  const n = (name || "").toLowerCase();
  for (const { match, glyph } of NAME_GLYPHS) {
    if (n.includes(match)) return P[glyph];
  }
  const c = (category || "").toLowerCase();
  for (const key of Object.keys(CATEGORY_GLYPHS)) {
    if (c.includes(key)) return P[CATEGORY_GLYPHS[key]!]!;
  }
  if (kind === "template") return P.box;
  if (kind === "mcp") return P.plug;
  return P.plug;
}

/** A small set of named paths for UI chrome (search, check, etc.). */
export const UI = {
  search: P.search, check: "M3.5 8.5l3 3 6-6.5", shield: P.shield, plug: P.plug,
  bolt: P.bolt, plus: "M8 3v10M3 8h10", chevron: "M6 4l4 4-4 4", external: "M9 3h4v4M13 3l-6 6M11 9v4H3V5h4",
  upload: "M8 11V3M5 6l3-3 3 3M3 13h10", spark: P.sparkles, close: "M4 4l8 8M12 4l-8 8",
};
