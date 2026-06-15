# Krelvan Registry

The capability marketplace for [Krelvan](https://github.com/sreenathmmenon/krelvan) —
distributed as a Git repo, not a hosted website. This is the "own your ecosystem"
model: the registry **is** this repository.

A Krelvan install's **Discover** tab fetches `index.json` from here (raw URL), so the
marketplace is live, forkable, and self-hostable. Point any install at your own fork:

```
NEXT_PUBLIC_KRELVAN_REGISTRY_URL=https://raw.githubusercontent.com/<you>/krelvan-registry/main/index.json
```

## What's in the registry

Each entry in `index.json` is a real, installable capability. Two kinds:

- **`yaml`** — an HTTP API wrapped as a capability (no code). The `yaml` field is the
  full capability definition; installing pipes it straight into the running Krelvan.
- **`mcp`** — a Model Context Protocol server. The `mcp` field is the connection
  config; every tool the server exposes becomes a capability.

Every entry declares its **side-effect class** (`read`, `write-reversible`,
`write-irreversible`, `spend`, `message-human`, `identity-mutation`) so Krelvan can
show — before you install — exactly what it can touch and when it will pause for
your approval.

## Free vs paid

- **Free** entries omit `price` / `licenseUrl`.
- **Paid** entries carry `price` (display) and `licenseUrl` (where to get a key). The
  capability still installs for free; it needs the user's own API key (a `secretRef`)
  to run. This is how authors monetize without Krelvan touching the money.

## Official vs community

- **`tier: "official"`** — reviewed and signed by Krelvan. One-click install.
- **`tier: "community"`** — published by anyone via PR. Installing requires an explicit
  "I understand the risks" acknowledgement.

## Publish a capability (the WordPress-style model)

1. Fork this repo.
2. Add an entry to `index.json` (copy an existing one; set `tier: "community"`).
3. Open a Pull Request. CI validates the YAML / MCP config.
4. Merged → it appears in every Krelvan install's Discover tab.

No account, no gatekeeper, no separate marketplace server — just a Git repo anyone
can read, fork, and contribute to.

## Entry schema

| field | required | notes |
|---|---|---|
| `name` | yes | unique machine name, e.g. `weather.fetch` |
| `title` | yes | display name |
| `oneLiner` | yes | one-sentence description |
| `category` | yes | Research / Connectors / Messaging / Payments / … |
| `sideEffect` | yes | one of the six classes |
| `tier` | yes | `official` \| `community` |
| `author` | yes | who maintains it |
| `kind` | yes | `yaml` \| `mcp` |
| `secretRefs` | no | env keys the capability needs |
| `price`, `licenseUrl` | no | paid entries only |
| `sourceUrl` | no | where the source lives |
| `yaml` | yaml kind | the full capability definition |
| `mcp` | mcp kind | the MCP connection config |
