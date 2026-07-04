# Krelvan Registry

The capability marketplace for [Krelvan](https://github.com/sreenathmmenon/krelvan) —
distributed as a Git repo, not a hosted website. This is the "own your ecosystem"
model: the registry **is** this repository. No account, no gatekeeper, no marketplace
server — just a Git repo anyone can read, fork, and contribute to.

A Krelvan install's **Marketplace** tab fetches `index.json` from here (raw URL), so the
catalog is live, forkable, and self-hostable. Point any install at your own fork:

```
NEXT_PUBLIC_KRELVAN_REGISTRY_URL=https://raw.githubusercontent.com/<you>/krelvan-registry/main/index.json
```

`index.json` is validated against [`schema.json`](./schema.json) — point your editor at it
for autocomplete and inline validation while you author entries.

## What's in the registry

Each entry in `index.json` is a real, installable capability. Five kinds:

- **`template`** — a whole installable **agent**. The `manifest` field is the full
  agent (nodes, edges, seed); installing gives you a ready-to-run, customizable agent.
  A template bundles the `yaml` capabilities its nodes need, so one install brings the
  agent *and* its connectors.
- **`pack`** — a curated **bundle of connectors** installed together (e.g. a "sales
  stack"). The `connectors` field lists what it pulls in.
- **`mcp`** — a **Model Context Protocol server**. The `mcp` field is the connection
  config; every tool the server exposes becomes a capability.
- **`yaml`** — an **HTTP API wrapped as a capability** (no code). The `yaml` field is the
  full definition; installing pipes it straight into the running Krelvan.
- **`builtin`** — a core capability that ships with Krelvan (listed for discovery).

Every entry declares its **side-effect class** (`read`, `write-reversible`,
`write-irreversible`, `spend`, `message-human`, `identity-mutation`) so Krelvan can
show — before you install — exactly what it can touch and when it will pause for
your approval.

## Free vs paid

- **Free** entries omit `price` / `licenseUrl`.
- **Paid** entries carry `price` (display) and `licenseUrl` (where to get a key). The
  capability still installs for free; it needs the user's own API key (a `secretRef`)
  to run. This is how authors monetize without Krelvan touching the money.

## Trust tiers

- **`tier: "official"`** — reviewed and maintained by Krelvan. One-click install.
- **`tier: "verified"`** — a known author, checked once.
- **`tier: "community"`** — published by anyone via PR. Installing requires an explicit
  "I understand the risks" acknowledgement.

## Publish a capability

1. Fork this repo.
2. Add an entry to `index.json` (copy an existing one of the same `kind`; set
   `tier: "community"`). Your editor validates it live against `schema.json`.
3. Open a Pull Request — CI runs [`validate.test.ts`](./validate.test.ts), which checks
   every entry's required fields, side-effect class, and (for templates) that the manifest
   is valid and bundles the yaml capabilities it uses.
4. Merged → it appears in every Krelvan install's Marketplace tab.

## How this file stays honest

`index.json` is **generated from Krelvan's canonical catalog**, not hand-edited in the
core repo. In the Krelvan repo, `scripts/sync-registry.ts` regenerates it from the single
source of truth so the app's catalog and this public registry can never silently drift:

```
npm run registry:sync     # regenerate registry/index.json from the catalog
npm run registry:check    # CI: fail if it's out of date
```

Community PRs to *this* repo are merged here and flow back; the sync guards the core side.

## Entry schema (summary — see `schema.json` for the full contract)

| field | required | notes |
|---|---|---|
| `name` | yes | unique machine name, e.g. `notion`, `publish-and-deploy` |
| `title` | yes | display name |
| `oneLiner` | yes | one-sentence description |
| `category` | yes | Communication / Productivity / Data / Commerce / Research / … |
| `sideEffect` | yes | one of the six classes |
| `tier` | yes | `official` \| `verified` \| `community` |
| `author` | yes | who maintains it |
| `kind` | yes | `template` \| `pack` \| `mcp` \| `yaml` \| `builtin` |
| `secretRefs` | no | keys the capability needs (set in Krelvan → Secrets) |
| `price`, `licenseUrl` | no | paid entries only |
| `sourceUrl` | no | where the source lives |
| `yaml` | yaml kind | the full capability definition |
| `mcp` | mcp kind | the MCP connection config |
| `manifest` | template kind | the full agent (nodes, edges, seed) |
| `capabilities` | template kind | the yaml caps the template bundles |
| `connectors` | pack kind | the connectors the pack installs |
