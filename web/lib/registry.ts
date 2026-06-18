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

export type CatalogKind = "yaml" | "mcp" | "template" | "pack";
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
  mcp?: { name?: string; command?: string; args?: string[]; url?: string; env?: Record<string, string>; tools?: string[]; defaultSideEffect?: string };
  // ── template kind (a whole installable agent) ──────────────────────────────
  manifest?: TemplateManifest;
  capabilities?: TemplateCapability[]; // the YAML capabilities this template needs
  recommendedModel?: string;           // e.g. a capable model for reliable reasoning
  // ── pack kind (a curated bundle of connectors) ─────────────────────────────
  connectors?: string[];               // names of the connectors this pack installs
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
  {
    "name": "hn.top",
    "title": "Hacker News",
    "oneLiner": "Fetch the current top stories from Hacker News.",
    "category": "Research",
    "sideEffect": "read",
    "tier": "official",
    "author": "Krelvan",
    "kind": "yaml",
    "sourceUrl": "https://github.com/sreenathmmenon/krelvan-registry",
    "yaml": "name: hn.top\ndescription: Fetch the current top story ids from Hacker News\nsideEffect: read\nestimateCents: 0\nhttp:\n  url: https://hacker-news.firebaseio.com/v0/topstories.json\n  method: GET\n"
  },
  {
    "name": "weather.fetch",
    "title": "Weather",
    "oneLiner": "Current forecast for any latitude/longitude \u2014 no key needed.",
    "category": "Research",
    "sideEffect": "read",
    "tier": "official",
    "author": "Krelvan",
    "kind": "yaml",
    "sourceUrl": "https://github.com/sreenathmmenon/krelvan-registry",
    "yaml": "name: weather.fetch\ndescription: Fetch the current weather for a location (Open-Meteo, no key)\nsideEffect: read\nestimateCents: 0\nhttp:\n  url: https://api.open-meteo.com/v1/forecast?latitude={{input.lat}}&longitude={{input.lon}}&current_weather=true\n  method: GET\ninput:\n  lat:\n    type: string\n    required: true\n  lon:\n    type: string\n    required: true\nresponseField: current_weather\n"
  },
  {
    "name": "wikipedia.summary",
    "title": "Wikipedia",
    "oneLiner": "Get the summary extract for any Wikipedia article.",
    "category": "Research",
    "sideEffect": "read",
    "tier": "official",
    "author": "Krelvan",
    "kind": "yaml",
    "sourceUrl": "https://github.com/sreenathmmenon/krelvan-registry",
    "yaml": "name: wikipedia.summary\ndescription: Fetch the summary of a Wikipedia article\nsideEffect: read\nestimateCents: 0\nhttp:\n  url: https://en.wikipedia.org/api/rest_v1/page/summary/{{input.title}}\n  method: GET\ninput:\n  title:\n    type: string\n    required: true\n"
  },
  {
    "name": "discord.notify",
    "title": "Discord notify",
    "oneLiner": "Post a message to a Discord channel via webhook.",
    "category": "Messaging",
    "sideEffect": "message-human",
    "tier": "community",
    "author": "community",
    "kind": "yaml",
    "secretRefs": [
      "DISCORD_WEBHOOK"
    ],
    "sourceUrl": "https://github.com/sreenathmmenon/krelvan-registry",
    "yaml": "name: discord.notify\ndescription: Post a message to a Discord channel webhook\nsideEffect: message-human\nestimateCents: 0\nhttp:\n  url: \"{{secret:DISCORD_WEBHOOK}}\"\n  method: POST\n  body:\n    content: \"{{input.message}}\"\ninput:\n  message:\n    type: string\n    required: true\n"
  },
  {
    "name": "serp.search",
    "title": "SERP Search (Pro)",
    "oneLiner": "Google-grade web search results via a managed SERP API.",
    "category": "Research",
    "sideEffect": "read",
    "tier": "community",
    "author": "marketplace",
    "kind": "yaml",
    "price": "from $5/mo",
    "licenseUrl": "https://serpapi.com/",
    "secretRefs": [
      "SERP_API_KEY"
    ],
    "sourceUrl": "https://github.com/sreenathmmenon/krelvan-registry",
    "yaml": "name: serp.search\ndescription: Web search results via SerpApi (requires a SERP_API_KEY)\nsideEffect: read\nestimateCents: 0\nhttp:\n  url: https://serpapi.com/search.json?q={{input.q}}&api_key={{secret:SERP_API_KEY}}\n  method: GET\ninput:\n  q:\n    type: string\n    required: true\n"
  },
  {
    "name": "github",
    "title": "GitHub",
    "oneLiner": "Read/write repos, issues and PRs \u2014 every tool becomes a capability.",
    "category": "Dev",
    "sideEffect": "write-reversible",
    "tier": "official",
    "author": "Krelvan",
    "kind": "mcp",
    "mcp": {
      "name": "github",
      "command": "docker",
      "args": [
        "run",
        "-i",
        "--rm",
        "-e",
        "GITHUB_PERSONAL_ACCESS_TOKEN",
        "ghcr.io/github/github-mcp-server"
      ],
      "defaultSideEffect": "write-reversible",
      "env": {
        "GITHUB_PERSONAL_ACCESS_TOKEN": "{{secret:GITHUB_TOKEN}}"
      }
    },
    "secretRefs": [
      "GITHUB_TOKEN"
    ],
    "sourceUrl": "https://github.com/github/github-mcp-server"
  },
  {
    "name": "stripe",
    "title": "Stripe",
    "oneLiner": "Create customers, charges, invoices and payment links.",
    "category": "Payments",
    "sideEffect": "spend",
    "tier": "official",
    "author": "Krelvan",
    "kind": "mcp",
    "mcp": {
      "name": "stripe",
      "command": "npx",
      "args": [
        "-y",
        "@stripe/mcp",
        "--tools=all",
        "--api-key={{secret:STRIPE_API_KEY}}"
      ],
      "defaultSideEffect": "spend"
    },
    "secretRefs": [
      "STRIPE_API_KEY"
    ],
    "sourceUrl": "https://github.com/stripe/agent-toolkit"
  },
  {
    "name": "notion",
    "title": "Notion",
    "oneLiner": "Create pages, query databases, append blocks in your Notion workspace.",
    "category": "Productivity",
    "sideEffect": "write-reversible",
    "tier": "official",
    "author": "Krelvan",
    "kind": "mcp",
    "mcp": {
      "name": "notion",
      "command": "npx",
      "args": [
        "-y",
        "@notionhq/notion-mcp-server"
      ],
      "defaultSideEffect": "write-reversible",
      "env": {
        "NOTION_TOKEN": "{{secret:NOTION_TOKEN}}"
      }
    },
    "secretRefs": [
      "NOTION_TOKEN"
    ],
    "sourceUrl": "https://github.com/makenotion/notion-mcp-server"
  },
  {
    "name": "slack",
    "title": "Slack",
    "oneLiner": "Post messages, read channels and threads via a bot token.",
    "category": "Messaging",
    "sideEffect": "message-human",
    "tier": "official",
    "author": "Krelvan",
    "kind": "mcp",
    "mcp": {
      "name": "slack",
      "command": "npx",
      "args": [
        "-y",
        "slack-mcp-server@latest"
      ],
      "defaultSideEffect": "message-human",
      "env": {
        "SLACK_MCP_XOXB_TOKEN": "{{secret:SLACK_BOT_TOKEN}}"
      }
    },
    "secretRefs": [
      "SLACK_BOT_TOKEN"
    ],
    "sourceUrl": "https://github.com/korotovsky/slack-mcp-server"
  },
  {
    "name": "linear",
    "title": "Linear",
    "oneLiner": "Create and update issues, projects and cycles in Linear.",
    "category": "Productivity",
    "sideEffect": "write-reversible",
    "tier": "official",
    "author": "Krelvan",
    "kind": "mcp",
    "mcp": {
      "name": "linear",
      "command": "npx",
      "args": [
        "-y",
        "mcp-remote",
        "https://mcp.linear.app/mcp"
      ],
      "defaultSideEffect": "write-reversible"
    },
    "sourceUrl": "https://linear.app/docs/mcp"
  },
  {
    "name": "airtable",
    "title": "Airtable",
    "oneLiner": "Read and write records across your Airtable bases.",
    "category": "Productivity",
    "sideEffect": "write-reversible",
    "tier": "official",
    "author": "Krelvan",
    "kind": "mcp",
    "mcp": {
      "name": "airtable",
      "command": "npx",
      "args": [
        "-y",
        "airtable-mcp-server"
      ],
      "defaultSideEffect": "write-reversible",
      "env": {
        "AIRTABLE_API_KEY": "{{secret:AIRTABLE_API_KEY}}"
      }
    },
    "secretRefs": [
      "AIRTABLE_API_KEY"
    ],
    "sourceUrl": "https://github.com/domdomegg/airtable-mcp-server"
  },
  {
    "name": "hubspot",
    "title": "HubSpot",
    "oneLiner": "Manage contacts, companies and deals in HubSpot CRM.",
    "category": "CRM",
    "sideEffect": "write-reversible",
    "tier": "official",
    "author": "Krelvan",
    "kind": "mcp",
    "mcp": {
      "name": "hubspot",
      "command": "npx",
      "args": [
        "-y",
        "mcp-remote",
        "https://mcp.hubspot.com"
      ],
      "defaultSideEffect": "write-reversible"
    },
    "sourceUrl": "https://developers.hubspot.com/mcp"
  },
  {
    "name": "gohighlevel",
    "title": "GoHighLevel",
    "oneLiner": "Contacts, opportunities and messaging across the GHL CRM.",
    "category": "CRM",
    "sideEffect": "write-reversible",
    "tier": "official",
    "author": "Krelvan",
    "kind": "mcp",
    "mcp": {
      "name": "gohighlevel",
      "command": "npx",
      "args": [
        "-y",
        "mcp-remote",
        "https://services.leadconnectorhq.com/mcp/"
      ],
      "defaultSideEffect": "write-reversible",
      "env": {
        "GHL_PRIVATE_TOKEN": "{{secret:GHL_TOKEN}}"
      }
    },
    "secretRefs": [
      "GHL_TOKEN"
    ],
    "sourceUrl": "https://marketplace.gohighlevel.com/docs/other/mcp"
  },
  {
    "name": "shopify",
    "title": "Shopify",
    "oneLiner": "Query products, orders and inventory for a Shopify store.",
    "category": "E-commerce",
    "sideEffect": "read",
    "tier": "official",
    "author": "Krelvan",
    "kind": "mcp",
    "mcp": {
      "name": "shopify",
      "command": "npx",
      "args": [
        "-y",
        "@shopify/dev-mcp@latest"
      ],
      "defaultSideEffect": "read"
    },
    "sourceUrl": "https://shopify.dev/docs/apps/build/devmcp"
  },
  {
    "name": "qdrant",
    "title": "Qdrant",
    "oneLiner": "Store and semantically search vectors in a Qdrant collection.",
    "category": "Data",
    "sideEffect": "write-reversible",
    "tier": "official",
    "author": "Krelvan",
    "kind": "mcp",
    "mcp": {
      "name": "qdrant",
      "command": "uvx",
      "args": [
        "mcp-server-qdrant"
      ],
      "defaultSideEffect": "write-reversible",
      "env": {
        "QDRANT_URL": "{{secret:QDRANT_URL}}",
        "QDRANT_API_KEY": "{{secret:QDRANT_API_KEY}}",
        "COLLECTION_NAME": "krelvan"
      }
    },
    "secretRefs": [
      "QDRANT_URL",
      "QDRANT_API_KEY"
    ],
    "sourceUrl": "https://github.com/qdrant/mcp-server-qdrant"
  },
  {
    "name": "pinecone",
    "title": "Pinecone",
    "oneLiner": "Upsert and query vectors in Pinecone for RAG.",
    "category": "Data",
    "sideEffect": "write-reversible",
    "tier": "official",
    "author": "Krelvan",
    "kind": "mcp",
    "mcp": {
      "name": "pinecone",
      "command": "npx",
      "args": [
        "-y",
        "@pinecone-database/mcp"
      ],
      "defaultSideEffect": "write-reversible",
      "env": {
        "PINECONE_API_KEY": "{{secret:PINECONE_API_KEY}}"
      }
    },
    "secretRefs": [
      "PINECONE_API_KEY"
    ],
    "sourceUrl": "https://github.com/pinecone-io/pinecone-mcp"
  },
  {
    "name": "firecrawl",
    "title": "Firecrawl",
    "oneLiner": "Scrape and crawl websites to clean markdown.",
    "category": "Research",
    "sideEffect": "read",
    "tier": "official",
    "author": "Krelvan",
    "kind": "mcp",
    "mcp": {
      "name": "firecrawl",
      "command": "npx",
      "args": [
        "-y",
        "firecrawl-mcp"
      ],
      "defaultSideEffect": "read",
      "env": {
        "FIRECRAWL_API_KEY": "{{secret:FIRECRAWL_API_KEY}}"
      }
    },
    "secretRefs": [
      "FIRECRAWL_API_KEY"
    ],
    "sourceUrl": "https://github.com/firecrawl/firecrawl-mcp-server"
  },
  {
    "name": "exa",
    "title": "Exa",
    "oneLiner": "Neural web search + content retrieval for agents.",
    "category": "Research",
    "sideEffect": "read",
    "tier": "official",
    "author": "Krelvan",
    "kind": "mcp",
    "mcp": {
      "name": "exa",
      "command": "npx",
      "args": [
        "-y",
        "exa-mcp-server"
      ],
      "defaultSideEffect": "read",
      "env": {
        "EXA_API_KEY": "{{secret:EXA_API_KEY}}"
      }
    },
    "secretRefs": [
      "EXA_API_KEY"
    ],
    "sourceUrl": "https://github.com/exa-labs/exa-mcp-server"
  },
  {
    "name": "brave",
    "title": "Brave Search",
    "oneLiner": "Web and local search via the Brave Search API.",
    "category": "Research",
    "sideEffect": "read",
    "tier": "official",
    "author": "Krelvan",
    "kind": "mcp",
    "mcp": {
      "name": "brave",
      "command": "npx",
      "args": [
        "-y",
        "@brave/brave-search-mcp-server"
      ],
      "defaultSideEffect": "read",
      "env": {
        "BRAVE_API_KEY": "{{secret:BRAVE_API_KEY}}"
      }
    },
    "secretRefs": [
      "BRAVE_API_KEY"
    ],
    "sourceUrl": "https://github.com/brave/brave-search-mcp-server"
  },
  {
    "name": "tavily",
    "title": "Tavily",
    "oneLiner": "Search and extract web content optimized for LLMs.",
    "category": "Research",
    "sideEffect": "read",
    "tier": "official",
    "author": "Krelvan",
    "kind": "mcp",
    "mcp": {
      "name": "tavily",
      "command": "npx",
      "args": [
        "-y",
        "tavily-mcp@latest"
      ],
      "defaultSideEffect": "read",
      "env": {
        "TAVILY_API_KEY": "{{secret:TAVILY_API_KEY}}"
      }
    },
    "secretRefs": [
      "TAVILY_API_KEY"
    ],
    "sourceUrl": "https://github.com/tavily-ai/tavily-mcp"
  },
  {
    "name": "perplexity",
    "title": "Perplexity",
    "oneLiner": "Answer questions with cited web research via Perplexity.",
    "category": "Research",
    "sideEffect": "read",
    "tier": "official",
    "author": "Krelvan",
    "kind": "mcp",
    "mcp": {
      "name": "perplexity",
      "command": "npx",
      "args": [
        "-y",
        "@perplexity-ai/mcp-server"
      ],
      "defaultSideEffect": "read",
      "env": {
        "PERPLEXITY_API_KEY": "{{secret:PERPLEXITY_API_KEY}}"
      }
    },
    "secretRefs": [
      "PERPLEXITY_API_KEY"
    ],
    "sourceUrl": "https://github.com/perplexityai/modelcontextprotocol"
  },
  {
    "name": "apollo",
    "title": "Apollo",
    "oneLiner": "Find and enrich B2B leads (people + companies).",
    "category": "Sales",
    "sideEffect": "read",
    "tier": "official",
    "author": "Krelvan",
    "kind": "mcp",
    "mcp": {
      "name": "apollo",
      "command": "npx",
      "args": [
        "-y",
        "mcp-remote",
        "https://mcp.apollo.io/mcp"
      ],
      "defaultSideEffect": "read",
      "env": {
        "APOLLO_API_KEY": "{{secret:APOLLO_API_KEY}}"
      }
    },
    "secretRefs": [
      "APOLLO_API_KEY"
    ],
    "sourceUrl": "https://docs.apollo.io/docs/apollo-mcp"
  },
  {
    "name": "calcom",
    "title": "Cal.com",
    "oneLiner": "Book, list and manage scheduling on Cal.com.",
    "category": "Scheduling",
    "sideEffect": "write-reversible",
    "tier": "official",
    "author": "Krelvan",
    "kind": "mcp",
    "mcp": {
      "name": "calcom",
      "command": "npx",
      "args": [
        "-y",
        "@calcom/cal-mcp@latest"
      ],
      "defaultSideEffect": "write-reversible",
      "env": {
        "CAL_API_KEY": "{{secret:CALCOM_API_KEY}}"
      }
    },
    "secretRefs": [
      "CALCOM_API_KEY"
    ],
    "sourceUrl": "https://github.com/calcom/cal-mcp"
  },
  {
    "name": "vapi",
    "title": "Vapi",
    "oneLiner": "Build and trigger AI voice agents and phone calls.",
    "category": "Voice",
    "sideEffect": "write-irreversible",
    "tier": "official",
    "author": "Krelvan",
    "kind": "mcp",
    "mcp": {
      "name": "vapi",
      "command": "npx",
      "args": [
        "-y",
        "@vapi-ai/mcp-server"
      ],
      "defaultSideEffect": "write-irreversible",
      "env": {
        "VAPI_TOKEN": "{{secret:VAPI_TOKEN}}"
      }
    },
    "secretRefs": [
      "VAPI_TOKEN"
    ],
    "sourceUrl": "https://github.com/VapiAI/mcp-server"
  },
  {
    "name": "elevenlabs",
    "title": "ElevenLabs",
    "oneLiner": "Text-to-speech, voice cloning and audio for agents.",
    "category": "Voice",
    "sideEffect": "write-reversible",
    "tier": "official",
    "author": "Krelvan",
    "kind": "mcp",
    "mcp": {
      "name": "elevenlabs",
      "command": "uvx",
      "args": [
        "elevenlabs-mcp"
      ],
      "defaultSideEffect": "write-reversible",
      "env": {
        "ELEVENLABS_API_KEY": "{{secret:ELEVENLABS_API_KEY}}"
      }
    },
    "secretRefs": [
      "ELEVENLABS_API_KEY"
    ],
    "sourceUrl": "https://github.com/elevenlabs/elevenlabs-mcp"
  },
  {
    "name": "resend",
    "title": "Resend",
    "oneLiner": "Send transactional email + scheduled reminders.",
    "category": "Messaging",
    "sideEffect": "message-human",
    "tier": "official",
    "author": "Krelvan",
    "kind": "mcp",
    "mcp": {
      "name": "resend",
      "command": "npx",
      "args": [
        "-y",
        "resend-mcp"
      ],
      "defaultSideEffect": "message-human",
      "env": {
        "RESEND_API_KEY": "{{secret:RESEND_API_KEY}}"
      }
    },
    "secretRefs": [
      "RESEND_API_KEY"
    ],
    "sourceUrl": "https://github.com/resend/resend-mcp"
  },
  {
    "name": "google_workspace",
    "title": "Google Workspace",
    "oneLiner": "Gmail, Calendar, Sheets and Drive in one connector.",
    "category": "Productivity",
    "sideEffect": "write-reversible",
    "tier": "official",
    "author": "Krelvan",
    "kind": "mcp",
    "mcp": {
      "name": "google_workspace",
      "command": "uvx",
      "args": [
        "workspace-mcp"
      ],
      "defaultSideEffect": "write-reversible",
      "env": {
        "GOOGLE_OAUTH_CLIENT_ID": "{{secret:GOOGLE_CLIENT_ID}}",
        "GOOGLE_OAUTH_CLIENT_SECRET": "{{secret:GOOGLE_CLIENT_SECRET}}"
      }
    },
    "secretRefs": [
      "GOOGLE_CLIENT_ID",
      "GOOGLE_CLIENT_SECRET"
    ],
    "sourceUrl": "https://github.com/taylorwilsdon/google_workspace_mcp"
  },
  {
    "name": "filesystem",
    "title": "Filesystem",
    "oneLiner": "Give an agent scoped read/write access to a local folder.",
    "category": "Dev",
    "sideEffect": "write-reversible",
    "tier": "official",
    "author": "Krelvan",
    "kind": "mcp",
    "mcp": {
      "name": "filesystem",
      "command": "npx",
      "args": [
        "-y",
        "@modelcontextprotocol/server-filesystem",
        "./data/agent-workspace"
      ],
      "defaultSideEffect": "write-reversible"
    },
    "sourceUrl": "https://github.com/modelcontextprotocol/servers/tree/main/src/filesystem"
  },
  {
    "name": "pipedream",
    "title": "Pipedream (3,000+ apps)",
    "oneLiner": "One connector \u2192 3,000+ apps with managed per-user OAuth.",
    "category": "Meta",
    "sideEffect": "write-irreversible",
    "tier": "community",
    "author": "Krelvan",
    "kind": "mcp",
    "mcp": {
      "name": "pipedream",
      "command": "npx",
      "args": [
        "-y",
        "mcp-remote",
        "https://mcp.pipedream.com/{{secret:PIPEDREAM_USER}}/{{secret:PIPEDREAM_APP}}"
      ],
      "defaultSideEffect": "write-irreversible",
      "env": {
        "PIPEDREAM_CLIENT_ID": "{{secret:PIPEDREAM_CLIENT_ID}}",
        "PIPEDREAM_CLIENT_SECRET": "{{secret:PIPEDREAM_CLIENT_SECRET}}"
      }
    },
    "secretRefs": [
      "PIPEDREAM_CLIENT_ID",
      "PIPEDREAM_CLIENT_SECRET",
      "PIPEDREAM_USER",
      "PIPEDREAM_APP"
    ],
    "sourceUrl": "https://pipedream.com/docs/connect/mcp"
  },
  {
    "name": "composio",
    "title": "Composio (500+ tools)",
    "oneLiner": "One connector \u2192 500+ tools with managed auth (open-source, self-hostable).",
    "category": "Meta",
    "sideEffect": "write-irreversible",
    "tier": "community",
    "author": "Krelvan",
    "kind": "mcp",
    "mcp": {
      "name": "composio",
      "command": "npx",
      "args": [
        "-y",
        "mcp-remote",
        "https://mcp.composio.dev/composio/server/{{secret:COMPOSIO_SERVER_ID}}"
      ],
      "defaultSideEffect": "write-irreversible"
    },
    "secretRefs": [
      "COMPOSIO_SERVER_ID"
    ],
    "sourceUrl": "https://github.com/ComposioHQ/composio"
  },
  {
    "name": "sendgrid.send",
    "title": "SendGrid Email",
    "oneLiner": "Send an email via SendGrid.",
    "category": "Messaging",
    "sideEffect": "message-human",
    "tier": "official",
    "author": "Krelvan",
    "kind": "yaml",
    "yaml": "name: sendgrid.send\ndescription: Send an email through SendGrid.\nsideEffect: message-human\nestimateCents: 1\nhttp:\n  url: \"https://api.sendgrid.com/v3/mail/send\"\n  method: POST\n  headers:\n    Authorization: \"Bearer {{secret:SENDGRID_API_KEY}}\"\n    Content-Type: \"application/json\"\n  body:\n    personalizations:\n      - to:\n          - email: \"{{input.to}}\"\n    from:\n      email: \"{{input.from}}\"\n    subject: \"{{input.subject}}\"\n    content:\n      - type: \"text/plain\"\n        value: \"{{input.body}}\"\ninput:\n  to: { type: string, required: true }\n  from: { type: string, required: true }\n  subject: { type: string, required: true }\n  body: { type: string, required: true }\nsuccessCodes: [200, 202]\n",
    "secretRefs": [
      "SENDGRID_API_KEY"
    ],
    "sourceUrl": "https://docs.sendgrid.com/api-reference/mail-send/mail-send"
  },
  {
    "name": "pipedrive.create_deal",
    "title": "Pipedrive Deal",
    "oneLiner": "Create a deal in Pipedrive CRM.",
    "category": "CRM",
    "sideEffect": "write-reversible",
    "tier": "official",
    "author": "Krelvan",
    "kind": "yaml",
    "yaml": "name: pipedrive.create_deal\ndescription: Create a new deal in Pipedrive.\nsideEffect: write-reversible\nestimateCents: 1\nhttp:\n  url: \"https://api.pipedrive.com/v1/deals?api_token={{secret:PIPEDRIVE_API_TOKEN}}\"\n  method: POST\n  headers:\n    Content-Type: \"application/json\"\n  body:\n    title: \"{{input.title}}\"\n    value: \"{{input.value}}\"\n    currency: \"{{input.currency}}\"\ninput:\n  title: { type: string, required: true }\n  value: { type: string, required: false }\n  currency: { type: string, required: false }\nresponseField: data\nsuccessCodes: [200, 201]\n",
    "secretRefs": [
      "PIPEDRIVE_API_TOKEN"
    ],
    "sourceUrl": "https://developers.pipedrive.com/docs/api/v1"
  },
  {
    "name": "mailchimp.add_subscriber",
    "title": "Mailchimp Subscriber",
    "oneLiner": "Add or update a subscriber on a Mailchimp list.",
    "category": "Marketing",
    "sideEffect": "write-reversible",
    "tier": "official",
    "author": "Krelvan",
    "kind": "yaml",
    "yaml": "name: mailchimp.add_subscriber\ndescription: Add a subscriber to a Mailchimp audience (list).\nsideEffect: write-reversible\nestimateCents: 1\nhttp:\n  url: \"https://{{input.dc}}.api.mailchimp.com/3.0/lists/{{input.list_id}}/members\"\n  method: POST\n  headers:\n    Authorization: \"Bearer {{secret:MAILCHIMP_API_KEY}}\"\n    Content-Type: \"application/json\"\n  body:\n    email_address: \"{{input.email}}\"\n    status: \"subscribed\"\ninput:\n  dc: { type: string, required: true, description: \"Mailchimp data-center prefix, e.g. us21\" }\n  list_id: { type: string, required: true }\n  email: { type: string, required: true }\nsuccessCodes: [200, 201]\n",
    "secretRefs": [
      "MAILCHIMP_API_KEY"
    ],
    "sourceUrl": "https://mailchimp.com/developer/marketing/api/list-members/"
  },
  {
    "name": "klaviyo.track_event",
    "title": "Klaviyo Event",
    "oneLiner": "Track a customer event in Klaviyo.",
    "category": "Marketing",
    "sideEffect": "write-reversible",
    "tier": "official",
    "author": "Krelvan",
    "kind": "yaml",
    "yaml": "name: klaviyo.track_event\ndescription: Send a customer event to Klaviyo.\nsideEffect: write-reversible\nestimateCents: 1\nhttp:\n  url: \"https://a.klaviyo.com/api/events/\"\n  method: POST\n  headers:\n    Authorization: \"Klaviyo-API-Key {{secret:KLAVIYO_API_KEY}}\"\n    revision: \"2024-10-15\"\n    Content-Type: \"application/json\"\n  body:\n    data:\n      type: \"event\"\n      attributes:\n        metric:\n          data:\n            type: \"metric\"\n            attributes:\n              name: \"{{input.event}}\"\n        profile:\n          data:\n            type: \"profile\"\n            attributes:\n              email: \"{{input.email}}\"\ninput:\n  event: { type: string, required: true }\n  email: { type: string, required: true }\nsuccessCodes: [200, 202]\n",
    "secretRefs": [
      "KLAVIYO_API_KEY"
    ],
    "sourceUrl": "https://developers.klaviyo.com/en/reference/create_event"
  },
  {
    "name": "buffer.create_post",
    "title": "Buffer Post",
    "oneLiner": "Queue a social post via Buffer.",
    "category": "Marketing",
    "sideEffect": "write-reversible",
    "tier": "official",
    "author": "Krelvan",
    "kind": "yaml",
    "yaml": "name: buffer.create_post\ndescription: Add a post to a Buffer profile's queue.\nsideEffect: write-reversible\nestimateCents: 1\nhttp:\n  url: \"https://api.bufferapp.com/1/updates/create.json?access_token={{secret:BUFFER_ACCESS_TOKEN}}\"\n  method: POST\n  headers:\n    Content-Type: \"application/json\"\n  body:\n    text: \"{{input.text}}\"\n    profile_ids:\n      - \"{{input.profile_id}}\"\ninput:\n  text: { type: string, required: true }\n  profile_id: { type: string, required: true }\nsuccessCodes: [200]\n",
    "secretRefs": [
      "BUFFER_ACCESS_TOKEN"
    ],
    "sourceUrl": "https://buffer.com/developers/api"
  },
  {
    "name": "pack.sales-stack",
    "title": "Sales Stack",
    "oneLiner": "Everything for an AI SDR: find leads, enrich, write outreach, log to CRM.",
    "category": "Packs",
    "sideEffect": "write-reversible",
    "tier": "official",
    "author": "Krelvan",
    "kind": "pack",
    "connectors": [
      "apollo",
      "hubspot",
      "calcom",
      "sendgrid.send"
    ]
  },
  {
    "name": "pack.support-stack",
    "title": "Support Stack",
    "oneLiner": "RAG support bot: knowledge base + ticketing + payments lookups.",
    "category": "Packs",
    "sideEffect": "write-reversible",
    "tier": "official",
    "author": "Krelvan",
    "kind": "pack",
    "connectors": [
      "qdrant",
      "firecrawl",
      "slack",
      "stripe"
    ]
  },
  {
    "name": "pack.voice-stack",
    "title": "Voice Stack",
    "oneLiner": "AI voice receptionist: calls, speech, and booking.",
    "category": "Packs",
    "sideEffect": "write-irreversible",
    "tier": "official",
    "author": "Krelvan",
    "kind": "pack",
    "connectors": [
      "vapi",
      "elevenlabs",
      "calcom"
    ]
  },
  {
    "name": "pack.ops-stack",
    "title": "Ops Stack",
    "oneLiner": "Inbox triage, meeting notes, and team notifications.",
    "category": "Packs",
    "sideEffect": "write-reversible",
    "tier": "official",
    "author": "Krelvan",
    "kind": "pack",
    "connectors": [
      "google_workspace",
      "notion",
      "slack"
    ]
  },
];

// Fetch the live registry; fall back to the bundled seed if unreachable, slow, or empty.
// The remote fetch is TIMEOUT-GUARDED (2.5s): a slow or hung GitHub never leaves the
// marketplace blank — the user always sees the full bundled catalog instead of an empty
// page. The seed is also MERGED in, so the remote can only ADD to (never shrink) the
// catalog if it happens to be missing entries the build shipped with.
export async function loadRegistry(): Promise<{ entries: CatalogEntry[]; source: "remote" | "bundled" }> {
  if (REGISTRY_URL) {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 2500);
      const res = await fetch(REGISTRY_URL, { cache: "no-store", signal: ctrl.signal });
      clearTimeout(timer);
      if (res.ok) {
        const data = await res.json() as { capabilities?: CatalogEntry[] } | CatalogEntry[];
        const remote = Array.isArray(data) ? data : (data.capabilities ?? []);
        if (remote.length > 0) {
          // Union remote + seed by name (remote wins), so a thin remote can't hide bundled entries.
          const byName = new Map<string, CatalogEntry>();
          for (const e of REGISTRY_SEED) byName.set(e.name, e);
          for (const e of remote) if (e && e.name) byName.set(e.name, e);
          return { entries: [...byName.values()], source: "remote" };
        }
      }
    } catch { /* timeout / offline / parse error → bundled seed */ }
  }
  return { entries: REGISTRY_SEED, source: "bundled" };
}
