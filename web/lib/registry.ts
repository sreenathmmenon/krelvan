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

export type CatalogKind = "yaml" | "mcp" | "template";
export type CatalogTier = "official" | "community";

/** A bundled capability a template ships and installs transitively. */
export interface TemplateCapability { name: string; yaml: string }

/** A manifest graph (loose shape — the backend validates it on install). */
export interface TemplateManifest {
  version: number;
  name: string;
  intent: string;
  entry: string;
  nodes: { id: string; role: string; autonomy: string; capabilities: { name: string; sideEffect: string; budgetCents: number }[] }[];
  edges: { from: string; to: string; when?: unknown }[];
  runBudgetCents: number;
  maxNodeVisits: number;
  seed?: Record<string, string | number | boolean | null>;
}

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
  // ── template kind (a whole installable agent) ──────────────────────────────
  manifest?: TemplateManifest;
  capabilities?: TemplateCapability[]; // the YAML capabilities this template needs
  recommendedModel?: string;           // e.g. a capable model for reliable reasoning
}

// The default registry repo (raw index.json) is the official krelvan-registry.
// Override with NEXT_PUBLIC_KRELVAN_REGISTRY_URL to point at your own fork.
export const REGISTRY_URL =
  process.env["NEXT_PUBLIC_KRELVAN_REGISTRY_URL"] ??
  "https://raw.githubusercontent.com/sreenathmmenon/krelvan-registry/main/index.json";

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
  {
    name: "slack.notify", title: "Slack notify", oneLiner: "Post a message to a Slack channel via an Incoming Webhook.",
    category: "Messaging", sideEffect: "message-human", tier: "official", author: "Krelvan", kind: "yaml",
    secretRefs: ["slack-webhook"],
    sourceUrl: "https://github.com/sreenathmmenon/krelvan-registry",
    yaml: `name: slack.notify
description: Post a message to a Slack channel via an Incoming Webhook URL.
sideEffect: message-human
estimateCents: 0
http:
  url: "{{secret:slack-webhook}}"
  method: POST
  headers:
    Content-Type: "application/json"
  body:
    text: "{{input.message}}"
input:
  message:
    type: string
    required: true
    description: The message text to post.
successCodes:
  - 200
`,
  },
  {
    name: "webhook.post", title: "Webhook POST", oneLiner: "POST a JSON message to any webhook URL you control.",
    category: "Messaging", sideEffect: "message-human", tier: "official", author: "Krelvan", kind: "yaml",
    secretRefs: ["webhook-url"],
    sourceUrl: "https://github.com/sreenathmmenon/krelvan-registry",
    yaml: `name: webhook.post
description: POST a JSON payload to a webhook URL (Zapier-free; your own endpoint).
sideEffect: message-human
estimateCents: 0
http:
  url: "{{secret:webhook-url}}"
  method: POST
  headers:
    Content-Type: "application/json"
  body:
    event: "{{input.event}}"
    message: "{{input.message}}"
input:
  event:
    type: string
    description: Optional event name/type.
  message:
    type: string
    required: true
    description: The payload message.
successCodes:
  - 200
  - 201
  - 202
  - 204
`,
  },
  {
    name: "github.dispatch", title: "Trigger GitHub Actions", oneLiner: "Kick off a GitHub Actions workflow via repository_dispatch.",
    category: "Automation", sideEffect: "write-irreversible", tier: "official", author: "Krelvan", kind: "yaml",
    secretRefs: ["github-token"],
    sourceUrl: "https://github.com/sreenathmmenon/krelvan-registry",
    yaml: `name: github.dispatch
description: Trigger a GitHub Actions workflow via the repository_dispatch API.
sideEffect: write-irreversible
estimateCents: 0
http:
  url: "https://api.github.com/repos/{{input.repo}}/dispatches"
  method: POST
  headers:
    Accept: "application/vnd.github+json"
    Authorization: "Bearer {{secret:github-token}}"
    User-Agent: "krelvan"
  body:
    event_type: "{{input.event_type}}"
input:
  repo:
    type: string
    required: true
    description: "owner/name of the repository."
  event_type:
    type: string
    required: true
    description: The repository_dispatch event type your workflow listens for.
successCodes:
  - 204
`,
  },

  // ── Official Deploy capabilities (ship a site/app via a provider deploy hook) ─
  // Each is a real, working trigger: you create a deploy/build hook in the provider
  // and store it as the named secret; the agent POSTs to it to ship. sideEffect is
  // write-irreversible, so a deploy gates on the agent's autonomy (suggest/veto).
  {
    name: "deploy.vercel", title: "Deploy to Vercel", oneLiner: "Ship a production deployment on Vercel via a Deploy Hook.",
    category: "Deploy", sideEffect: "write-irreversible", tier: "official", author: "Krelvan", kind: "yaml",
    secretRefs: ["vercel-deploy-hook"],
    sourceUrl: "https://github.com/sreenathmmenon/krelvan-registry",
    yaml: `name: deploy.vercel
description: Trigger a production deployment on Vercel via a Deploy Hook URL.
sideEffect: write-irreversible
estimateCents: 0
http:
  url: "{{secret:vercel-deploy-hook}}"
  method: POST
  headers:
    Content-Type: "application/json"
  body:
    ref: "{{input.ref}}"
input:
  ref:
    type: string
    description: Optional git ref (branch or commit) to deploy.
successCodes:
  - 200
  - 201
  - 202
`,
  },
  {
    name: "deploy.netlify", title: "Deploy to Netlify", oneLiner: "Trigger a build and deploy on Netlify via a Build Hook.",
    category: "Deploy", sideEffect: "write-irreversible", tier: "official", author: "Krelvan", kind: "yaml",
    secretRefs: ["netlify-build-hook"],
    sourceUrl: "https://github.com/sreenathmmenon/krelvan-registry",
    yaml: `name: deploy.netlify
description: Trigger a build and deploy on Netlify via a Build Hook URL.
sideEffect: write-irreversible
estimateCents: 0
http:
  url: "{{secret:netlify-build-hook}}"
  method: POST
  headers:
    Content-Type: "application/json"
  body:
    trigger_branch: "{{input.branch}}"
    trigger_title: "{{input.title}}"
input:
  branch:
    type: string
    description: Optional branch to build.
  title:
    type: string
    description: Optional reason shown in the Netlify deploy log.
successCodes:
  - 200
  - 201
  - 202
  - 204
`,
  },
  {
    name: "deploy.cloudflare_pages", title: "Deploy to Cloudflare Pages", oneLiner: "Queue a Cloudflare Pages deployment via a Deploy Hook.",
    category: "Deploy", sideEffect: "write-irreversible", tier: "official", author: "Krelvan", kind: "yaml",
    secretRefs: ["cloudflare-pages-hook"],
    sourceUrl: "https://github.com/sreenathmmenon/krelvan-registry",
    yaml: `name: deploy.cloudflare_pages
description: Trigger a Cloudflare Pages deployment via a Deploy Hook URL.
sideEffect: write-irreversible
estimateCents: 0
http:
  url: "{{secret:cloudflare-pages-hook}}"
  method: POST
  headers:
    Content-Type: "application/json"
  body:
    reason: "{{input.reason}}"
input:
  reason:
    type: string
    description: Optional human-readable reason for the deploy.
successCodes:
  - 200
  - 201
  - 202
`,
  },
  {
    name: "deploy.render", title: "Deploy to Render", oneLiner: "Trigger a deploy on Render via a service Deploy Hook.",
    category: "Deploy", sideEffect: "write-irreversible", tier: "official", author: "Krelvan", kind: "yaml",
    secretRefs: ["render-deploy-hook"],
    sourceUrl: "https://github.com/sreenathmmenon/krelvan-registry",
    yaml: `name: deploy.render
description: Trigger a deploy on Render via a service Deploy Hook URL.
sideEffect: write-irreversible
estimateCents: 0
http:
  url: "{{secret:render-deploy-hook}}"
  method: POST
  headers:
    Content-Type: "application/json"
  body:
    ref: "{{input.ref}}"
input:
  ref:
    type: string
    description: Optional git ref (branch or commit SHA) to deploy.
successCodes:
  - 200
  - 201
  - 202
`,
  },
  {
    name: "deploy.railway", title: "Deploy to Railway", oneLiner: "Redeploy a Railway service via the GraphQL API.",
    category: "Deploy", sideEffect: "write-irreversible", tier: "official", author: "Krelvan", kind: "yaml",
    secretRefs: ["railway-token"],
    sourceUrl: "https://github.com/sreenathmmenon/krelvan-registry",
    yaml: `name: deploy.railway
description: Trigger a redeploy on Railway via the project GraphQL API.
sideEffect: write-irreversible
estimateCents: 0
http:
  url: "https://backboard.railway.app/graphql/v2"
  method: POST
  headers:
    Content-Type: "application/json"
    Authorization: "Bearer {{secret:railway-token}}"
  body:
    query: "mutation($id: String!){ serviceInstanceRedeploy(serviceId: $id) }"
    variables:
      id: "{{input.serviceId}}"
input:
  serviceId:
    type: string
    required: true
    description: The Railway service id to redeploy.
successCodes:
  - 200
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
  // ── Templates: whole installable agents (manifest + capabilities) ──────────
  {
    "name": "price-monitor",
    "title": "Price Monitor",
    "oneLiner": "Watch a page on a schedule, detect price changes vs last run, and alert you \u2014 with a signed record of every check.",
    "category": "Templates",
    "sideEffect": "message-human",
    "tier": "official",
    "author": "Krelvan",
    "kind": "template",
    "secretRefs": [
      "slack-bot-token",
      "firecrawl-api-key"
    ],
    "sourceUrl": "https://github.com/sreenathmmenon/krelvan-registry",
    "recommendedModel": "a capable model (e.g. claude-sonnet, gpt-4o, or qwen2.5:14b on Ollama)",
    "manifest": {
      "version": 1,
      "name": "Price Monitor",
      "intent": "Watch a product/price page on a schedule, detect when the price changes versus the last run, and alert me \u2014 keeping a signed record of every check.",
      "entry": "recall_baseline",
      "runBudgetCents": 200,
      "maxNodeVisits": 2,
      "seed": {
        "url": "https://example.com",
        "watch_label": "the watched page",
        "remember_map": "last_price=analyze.current_price"
      },
      "nodes": [
        {
          "id": "recall_baseline",
          "role": "Load the last recorded price for this page from memory (recall.last_price). On the very first run this will be empty.",
          "autonomy": "full",
          "capabilities": [
            {
              "name": "recall",
              "sideEffect": "read",
              "budgetCents": 5
            }
          ]
        },
        {
          "id": "fetch_page",
          "role": "Fetch the current contents of {{input.target_url}} so the price can be read.",
          "autonomy": "full",
          "capabilities": [
            {
              "name": "http_get",
              "sideEffect": "read",
              "budgetCents": 10
            }
          ]
        },
        {
          "id": "analyze",
          "role": "You are a price-watch analyst. Read TWO things: (A) the CURRENT DATA TO ANALYZE section contains the freshly-fetched page text \u2014 extract the price the page shows RIGHT NOW from there. (B) the MEMORY section contains 'last_price (from a PREVIOUS run)' \u2014 that is the OLD price from before. If the MEMORY section is absent or has no last_price, this is the FIRST run. Steps: 1) From the CURRENT page text only, extract the current price as a bare number string, e.g. \"39.99\" (no symbols/words). Put it in current_price. 2) Take the previous price from MEMORY's last_price. 3) Set changed to true ONLY if a previous last_price existed AND it is different from the current price; otherwise false. Rules: write prices as quoted strings; NEVER copy the memory value into current_price \u2014 current_price must come from the CURRENT page text; never invent a previous price like 0.00. Output object keys: current_price (the price on the page now, as a quoted string), changed (true/false), result (one sentence, e.g. 'Price dropped from 49.99 to 39.99' / 'No change, still 39.99' / 'First run, baseline set to 49.99').",
          "autonomy": "full",
          "capabilities": [
            {
              "name": "think",
              "sideEffect": "read",
              "budgetCents": 80
            }
          ]
        },
        {
          "id": "alert",
          "role": "Post the price-change summary to the operator.",
          "autonomy": "full",
          "capabilities": [
            {
              "name": "notify_webhook",
              "sideEffect": "write-reversible",
              "budgetCents": 10
            }
          ]
        },
        {
          "id": "persist",
          "role": "Persist the current price as the new baseline for the next run.",
          "autonomy": "full",
          "capabilities": [
            {
              "name": "remember",
              "sideEffect": "write-reversible",
              "budgetCents": 5
            }
          ]
        }
      ],
      "edges": [
        {
          "from": "recall_baseline",
          "to": "fetch_page"
        },
        {
          "from": "fetch_page",
          "to": "analyze"
        },
        {
          "from": "analyze",
          "to": "alert",
          "when": {
            "op": "eq",
            "left": {
              "op": "var",
              "key": "analyze.changed"
            },
            "right": {
              "op": "const",
              "value": true
            }
          }
        },
        {
          "from": "analyze",
          "to": "persist"
        },
        {
          "from": "alert",
          "to": "persist"
        }
      ]
    },
    "capabilities": [
      {
        "name": "slack.post",
        "yaml": "name: slack.post\ndescription: Post a message to a Slack channel using a Bot User OAuth token (chat.postMessage). More capable than an incoming webhook \u2014 one bot token posts to any channel it is invited to.\nsideEffect: message-human\nestimateCents: 1\n\nhttp:\n  url: \"https://slack.com/api/chat.postMessage\"\n  method: POST\n  headers:\n    Authorization: \"Bearer {{secret:slack-bot-token}}\"\n    Content-Type: \"application/json; charset=utf-8\"\n  body:\n    channel: \"{{input.channel}}\"\n    text: \"{{input.message}}\"\n\ninput:\n  channel:\n    type: string\n    required: true\n    description: Channel ID (e.g. C0123456789) or name the bot has been invited to.\n  message:\n    type: string\n    required: true\n    description: The message text to post (Slack mrkdwn supported).\n\n# Slack returns HTTP 200 even on logical errors; the {ok:false} body is surfaced as the response.\nresponseField: ok\n\nsuccessCodes:\n  - 200\n"
      },
      {
        "name": "firecrawl.scrape",
        "yaml": "name: firecrawl.scrape\ndescription: Scrape a single public URL to clean markdown using Firecrawl. Strips nav/ads/boilerplate so an agent can reason over real content. Use for price pages, articles, product pages.\nsideEffect: read\nestimateCents: 2\n\nhttp:\n  url: \"https://api.firecrawl.dev/v2/scrape\"\n  method: POST\n  headers:\n    Authorization: \"Bearer {{secret:firecrawl-api-key}}\"\n    Content-Type: \"application/json\"\n  body:\n    url: \"{{input.url}}\"\n    formats:\n      - markdown\n\ninput:\n  url:\n    type: string\n    required: true\n    description: The public URL to scrape (must be publicly reachable).\n\n# Firecrawl returns { success, data: { markdown, metadata, ... } }.\nresponseField: data.markdown\n\nsuccessCodes:\n  - 200\n"
      }
    ]
  },
  {
    "name": "kb-ingest",
    "title": "Knowledge Base Ingest",
    "oneLiner": "Load a document into a named knowledge base so a RAG agent can answer from it.",
    "category": "Templates",
    "sideEffect": "write-reversible",
    "tier": "official",
    "author": "Krelvan",
    "kind": "template",
    "secretRefs": [],
    "sourceUrl": "https://github.com/sreenathmmenon/krelvan-registry",
    "manifest": {
      "version": 1,
      "name": "Knowledge Base Ingest",
      "intent": "Add a document to a named knowledge base so a RAG agent can answer questions grounded in it.",
      "entry": "ingest",
      "runBudgetCents": 100,
      "maxNodeVisits": 2,
      "seed": {
        "kb": "support-kb"
      },
      "nodes": [
        {
          "id": "ingest",
          "role": "Chunk and embed the provided text into the knowledge base.",
          "autonomy": "full",
          "capabilities": [
            {
              "name": "rag.ingest",
              "sideEffect": "write-reversible",
              "budgetCents": 20
            }
          ]
        }
      ],
      "edges": []
    },
    "capabilities": []
  },
  {
    "name": "support-bot",
    "title": "RAG Support Bot",
    "oneLiner": "Answer questions grounded ONLY in your ingested docs, cite the source, refuse when it doesn't know \u2014 with a signed record.",
    "category": "Templates",
    "sideEffect": "read",
    "tier": "official",
    "author": "Krelvan",
    "kind": "template",
    "secretRefs": [],
    "recommendedModel": "a capable model (claude-sonnet, gpt-4o, or qwen2.5:14b on Ollama) + an embeddings model (OpenAI text-embedding-3-small or Ollama nomic-embed-text)",
    "sourceUrl": "https://github.com/sreenathmmenon/krelvan-registry",
    "manifest": {
      "version": 1,
      "name": "RAG Support Bot",
      "intent": "Answer a question from my ingested knowledge base, grounded only in the retrieved documents, and cite the source \u2014 with a signed record of every answer.",
      "entry": "retrieve",
      "runBudgetCents": 200,
      "maxNodeVisits": 2,
      "seed": {
        "query": "How do I get a refund?",
        "kb": "support-kb"
      },
      "nodes": [
        {
          "id": "retrieve",
          "role": "Retrieve the most relevant knowledge-base chunks for the question.",
          "autonomy": "full",
          "capabilities": [
            {
              "name": "rag.search",
              "sideEffect": "read",
              "budgetCents": 10
            }
          ]
        },
        {
          "id": "answer",
          "role": "You are a support agent. The retrieved knowledge-base context is in the CURRENT DATA TO ANALYZE section (key ending in .body) \u2014 each chunk is tagged with its source like [1] (source: handbook). The user's question is in the 'query' state value. Answer the question using ONLY the retrieved context. If the context does not contain the answer, say you don't have that information \u2014 do NOT make anything up. Output object keys: result (your answer to the user, one or two sentences, grounded in the context); grounded (true if the answer came from the context, false if the context lacked the answer); cited_source (the source tag of the chunk you used, e.g. 'handbook', or 'none').",
          "autonomy": "full",
          "capabilities": [
            {
              "name": "think",
              "sideEffect": "read",
              "budgetCents": 80
            }
          ]
        },
        {
          "id": "record",
          "role": "Record this Q&A to memory for an audit trail.",
          "autonomy": "full",
          "capabilities": [
            {
              "name": "remember",
              "sideEffect": "write-reversible",
              "budgetCents": 5
            }
          ]
        }
      ],
      "edges": [
        {
          "from": "retrieve",
          "to": "answer"
        },
        {
          "from": "answer",
          "to": "record"
        }
      ]
    },
    "capabilities": []
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
