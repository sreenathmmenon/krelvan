# Genesis — Extension Model

*How developers, companies, and enterprises build their own capabilities and plug
them into Genesis.*

*Read ARCHITECTURE.md first for the full system context.*

---

## The idea in one paragraph

Genesis is built to be owned, not rented. That means the integrations — the tools
your agents use to reach the real world — must be ownable too. A company's internal
API, an enterprise's proprietary data system, a developer's custom tool: none of
them should require touching Genesis core, waiting for a maintainer, or giving data
to a third party. You implement one interface, register it, and your capability has
the full backing of the Genesis trust model — budget enforcement, audit trail,
approval gates, secret isolation — automatically.

---

## Three kinds of people, three formats

The right format depends on who is building the extension:

| Who | What they want | Format | Complexity |
|---|---|---|---|
| Developer / company | Connect internal API, custom logic | TypeScript file | One interface, 4 methods |
| Ops / power user | Wrap a REST API, configure a webhook | YAML file | No code at all |
| Workflow designer | Share a pre-built agent workflow | JSON manifest file | Pure data, no code |

These are not tiers of quality — they are genuinely different tools for different
jobs. A company's internal auth flow needs TypeScript. A simple HTTP webhook needs
nothing more than YAML. A shareable workflow blueprint is just a signed JSON file.

---

## Three extension points

| Extension type | Interface | What it does |
|---|---|---|
| **Capability** | `CapabilityPlugin` (TS) or `.yaml` file | A tool an agent can call |
| **Channel** | `ChannelAdapter` | How humans talk to agents |
| **Manifest template** | `SignedManifest` (JSON) | A pre-built agent workflow |

Most extensions are capabilities. A channel is only needed if you want a new way
for humans to send or receive messages. A template is just a shareable manifest.

---

## Path A — TypeScript capability (for developers)

### The interface (the whole contract)

```typescript
// src/core/capability/capability.ts

interface CapabilityPlugin {
  readonly name: string;          // "crm.lookup", "stripe.charge"
  readonly sideEffect: SideEffectClass;
  estimateCents(call: EffectCall): number;
  invoke(call: EffectCall): Promise<{ output: unknown; claimedCostCents: number }>;
}
```

Four members. That is the entire contract. Budget enforcement, approval gating,
audit logging, secret isolation, and crash-safe replay are all handled by Genesis
automatically — you do not implement any of that.

### Side-effect classes

This is the most important decision when building a capability. It drives approval
gates, replay behaviour, and the assurance level required to authorize the effect.

| Class | Meaning | Examples |
|---|---|---|
| `"read"` | No state change; safe to re-run | web search, DB query, file read |
| `"write-reversible"` | Changes state, can be undone | update a draft, set a flag |
| `"write-irreversible"` | Permanent change | delete a record, publish a post |
| `"spend"` | Moves money | Stripe charge, crypto transfer |
| `"message-human"` | Sends a message to a person | email, Slack, Telegram, SMS |
| `"identity-mutation"` | Changes who someone is | create/delete user, change role |

When in doubt, go higher. Declaring something `"read"` when it is
`"write-irreversible"` bypasses safety gates. The architecture enforces admission
and approval based on what you declare — so be honest.

### A real example

A company connecting their internal CRM:

```typescript
// capabilities/crm-lookup.ts
import type { CapabilityPlugin, EffectCall } from '../core/capability/capability.js';

export const CrmLookupPlugin: CapabilityPlugin = {
  name: 'crm.lookup',
  sideEffect: 'read',
  estimateCents: () => 0,

  async invoke(call: EffectCall) {
    const { customerId } = call.input as { customerId: string };
    const response = await fetch(`https://crm.internal/customers/${customerId}`, {
      headers: { Authorization: `Bearer ${process.env.CRM_TOKEN}` },
    });
    const data = await response.json();
    return { output: data, claimedCostCents: 0 };
  },
};
```

Register it when you set up the `Supervisor`:

```typescript
import { Supervisor } from '../core/capability/capability.js';
import { CrmLookupPlugin } from './capabilities/crm-lookup.js';

const plugins = new Map([
  ['crm.lookup', CrmLookupPlugin],
]);
const supervisor = new Supervisor(plugins);
```

Grant it in the agent manifest:

```json
{
  "id": "support-agent",
  "capabilities": [
    { "name": "crm.lookup", "sideEffect": "read", "budgetCents": 0 }
  ]
}
```

If an agent tries to call `crm.lookup` without declaring it, the admission gate
denies it before your `invoke` is ever called. You never check authorisation inside
the plugin — the architecture does it for you.

### Testing

The plugin is a plain TypeScript object. Unit-test it directly:

```typescript
import { CrmLookupPlugin } from './capabilities/crm-lookup.js';
import assert from 'node:assert/strict';

// mock fetch, then:
const result = await CrmLookupPlugin.invoke({
  nodeId: 'test-node',
  capability: 'crm.lookup',
  input: { customerId: 'cust_123' },
});
assert.equal(result.claimedCostCents, 0);
```

No Genesis runtime needed for unit tests.

---

## Path B — YAML capability (for ops / power users)

### When to use this

Use a YAML file when your capability is an HTTP call to an existing API. No
TypeScript required. Drop the file in your `capabilities/` directory and Genesis
picks it up at startup.

This covers the majority of real-world integrations — most things agents need to
do are "call this endpoint with these headers and return the result."

### The YAML schema

```yaml
# capabilities/my-api.yaml

# required fields
name: my-service.fetch          # machine name: [a-z][a-z0-9._-]*
description: Fetch data from My Service
sideEffect: read                # one of the six side-effect classes (see above)
estimateCents: 0                # integer cents; 0 = free

http:
  url: https://api.myservice.com/data
  method: GET                   # GET | POST | PUT | PATCH | DELETE
  headers:
    Authorization: "Bearer {{secret:my-service-key}}"   # secret reference
    X-Custom-Header: "static-value"

# optional: declare what the agent passes in (for docs + validation)
input:
  resourceId:
    type: string
    required: true
    description: The resource to fetch

# optional: declare what comes back (for docs + canvas UI)
output:
  name:
    type: string
  status:
    type: string

# optional: extract a nested field from the response JSON
responseField: data.resource    # dot-path only — no brackets, no eval (EXT-03)

# optional: which HTTP status codes count as success (default: 200, 201, 204)
successCodes:
  - 200
  - 201
```

### Referencing inputs and secrets

Two interpolation patterns are supported inside string values. Nothing else.
No eval, no arbitrary expressions.

**`{{input.field}}`** — substituted with the value the agent passes at call time:
```yaml
url: https://api.example.com/customers/{{input.customerId}}
```

**`{{secret:name}}`** — substituted with a scoped token from the secret broker.
The plugin never sees the underlying credential, only a short-lived token:
```yaml
headers:
  Authorization: "Bearer {{secret:stripe-key}}"
```

Secrets are registered once at startup by the operator:
```typescript
broker.setSecret('stripe-key', process.env.STRIPE_SECRET_KEY!);
```

### A POST example with a body

```yaml
name: webhook.notify
description: POST an event notification to a webhook
sideEffect: write-reversible
estimateCents: 0

http:
  url: https://hooks.mycompany.com/events
  method: POST
  headers:
    Authorization: "Bearer {{secret:webhook-secret}}"
  body:
    event: "{{input.eventName}}"
    userId: "{{input.userId}}"
    timestamp: "{{input.ts}}"

input:
  eventName:
    type: string
    required: true
  userId:
    type: string
    required: true
  ts:
    type: string

successCodes:
  - 200
  - 202
```

### Validation

The YAML loader validates every file before the Supervisor accepts it.
All errors are caught at load time, not at run time.

| Rule | What is checked |
|---|---|
| EXT-01 | `sideEffect` must be one of the six known classes |
| EXT-02 | All `{{secret:name}}` references are extracted and reported so the broker can verify they are registered |
| EXT-03 | `responseField` must be a simple dot-path (`data.items`) — no brackets, no semicolons, no eval-able content |
| EXT-04 | `estimateCents` must be a non-negative integer (no floats — ledger invariant) |

Example error output:
```
capabilities/my-api.yaml: 3 validation errors
  sideEffect: must be one of: read, write-reversible, write-irreversible, spend, message-human, identity-mutation
  estimateCents: must be a non-negative integer (cents)
  responseField: must be a simple dot-path — letters, digits, underscores, dots only (EXT-03)
```

Genesis refuses to start if any capability file fails validation. The error is
loud — it names the file and every field — so there is no ambiguity about what
needs to be fixed.

### How it is implemented

The YAML loader lives at `src/core/extensions/yaml-capability.ts`. It:

1. **Parses** the YAML text into a plain object (built-in parser, no third-party dep)
2. **Validates** it against the schema (`validateYamlCapability`)
3. **Compiles** it into a live `CapabilityPlugin` (`compileYamlCapability`)
4. **Returns** `{ ok, plugin, secretRefs }` — the secret refs let the broker
   check all required credentials are registered before the first run

The compiled plugin is indistinguishable from a TypeScript plugin to the Supervisor.
It goes into the same `Map<string, CapabilityPlugin>`, runs through the same
admission gate, gets the same audit trail.

**Tested**: 39 tests covering parsing, all four EXT guards, interpolation, HTTP
invocation, responseField extraction, error cases. All passing (`npm test`).

---

## Path C — JSON manifest template (for workflow designers)

A template is a `SignedManifest` JSON file — a pre-built agent workflow someone
has already run and wants to share. No code. Import it into any Genesis install.

```json
{
  "manifest": {
    "version": 1,
    "name": "weekly-competitor-brief",
    "intent": "Every Monday, research the top competitors and send a brief",
    "entry": "researcher",
    "runBudgetCents": 80,
    "maxNodeVisits": 3,
    "nodes": [
      {
        "id": "researcher",
        "role": "search for competitor news",
        "autonomy": "full",
        "capabilities": [
          { "name": "web_search", "sideEffect": "read", "budgetCents": 50 }
        ]
      },
      {
        "id": "writer",
        "role": "write the brief",
        "autonomy": "full",
        "capabilities": [
          { "name": "compose", "sideEffect": "read", "budgetCents": 20 }
        ]
      },
      {
        "id": "sender",
        "role": "send to Slack",
        "autonomy": "act-with-veto",
        "capabilities": [
          { "name": "slack.send", "sideEffect": "message-human", "budgetCents": 10 }
        ]
      }
    ],
    "edges": [
      { "from": "researcher", "to": "writer" },
      { "from": "writer", "to": "sender" }
    ]
  },
  "id": "sha256:abc123…",
  "provenance": { "intent": "…", "principalKind": "owner", "principalId": "owner-1", "compiledAt": 1748908800 },
  "sig": { "keyId": "compiler", "epoch": 1, "signedAt": 1748908800, "value": "…" }
}
```

When someone imports a template:

1. The manifest is validated structurally
2. Capability monotonicity runs against the importing owner's principal — if the
   template requests `"spend"` and this owner hasn't allowed `"spend"`, import is
   rejected
3. The signature is verified (provenance is intact)
4. The owner re-signs when they deploy — their install, their authority

Import via CLI: `genesis import ./weekly-brief.manifest.json`
Import via UI: Templates → Import → drag the file

---

## Secrets: how credentials reach your plugin

**Secrets never touch plugins directly.** This is structural — the secret broker
mints short-lived, scoped tokens for specific destinations. Your plugin receives
a token valid for exactly one destination and one TTL, not the underlying credential.

```typescript
// at startup — operator registers real secrets
broker.setSecret('stripe.com', process.env.STRIPE_SECRET_KEY!);
broker.setSecret('crm.internal', process.env.CRM_API_KEY!);

// at call time — plugin asks for a scoped token
const token = broker.mint('stripe.com', allowedDestinations, now(), 60);
if (!token) throw new Error('access denied');
// token.token is a short-lived opaque string — NOT the underlying secret
```

For YAML capabilities, `{{secret:name}}` handles this automatically. For
TypeScript plugins, you call `broker.mint()` yourself. In both cases the plugin
never calls `broker.setSecret()` — that is for the operator only.

---

## What every plugin gets for free

When you implement a capability — TypeScript or YAML — the following is automatic:

**Budget enforcement.** Your `estimateCents` is reserved before `invoke` is called.
If the run is near its ceiling, the call is denied. You cannot cause overspend.
After `invoke` returns, `claimedCostCents` is settled. This is the
reserve-then-settle model.

**Approval gating.** If the node's `autonomy` is `"suggest"` or `"act-with-veto"`
and your `sideEffect` class requires approval, the engine parks the run and waits
for a human — before your plugin runs. You implement nothing for this.

**Audit trail.** Every call produces three ledger events: `AdmissionDecision`,
`EffectRequested`, `EffectResult`. The audit exists regardless of what your plugin
does or does not log.

**Supervisor co-signing.** The `EffectResult` event is signed by the supervisor's
key, not yours. Your `claimedCostCents` is recorded as an explicitly-untrusted
claim. Even if your plugin reports a wrong cost, the discrepancy is on record.

**Crash-safe replay.** If the process dies after your plugin runs but before the
result is durably appended, the engine detects the crash hole on resume and halts
rather than re-running your plugin. If the result was already appended, it is
re-served — your plugin is not called again.

**Counterfactual safety.** A "what if" replay never calls any plugin. It only
plans what would re-gate through admission — so a counterfactual branch can never
accidentally re-spend money or re-send messages.

---

## What a plugin structurally cannot do

These are not conventions. They are enforced by the architecture:

- **Cannot call an ungranted capability** — admission gate denies before `invoke`
- **Cannot overspend** — budget ceiling enforced before dispatch
- **Cannot self-sign its result** — supervisor signs `EffectResult`, not the plugin
- **Cannot access ungranted secrets** — broker's egress allowlist + scoped tokens
- **Cannot bypass the approval gate** — kernel decides before engine calls plugin
- **Cannot re-run after a crash** — idempotency is a ledger property
- **Cannot hide its actions** — audit trail exists regardless
- **Cannot widen capability grants** — monotonicity enforced at compile time

---

## Packaging and distribution

### Private (company / enterprise)

No packaging. Implement the interface, add to your config file, done. It never
leaves your network.

```typescript
// genesis.config.ts
import { CrmLookupPlugin } from './capabilities/crm-lookup.js';
import { SalesforcePlugin } from './capabilities/salesforce.js';

export const capabilities = [CrmLookupPlugin, SalesforcePlugin];
// YAML files in capabilities/ are loaded automatically
```

### Community (sharing with others)

Publish an npm package under the `genesis-capability-*` or `genesis-channel-*`
naming convention:

```
genesis-capability-stripe
genesis-capability-salesforce
genesis-capability-github
genesis-channel-discord
```

Declare it in `package.json` so Genesis can auto-discover it:

```json
{
  "name": "genesis-capability-stripe",
  "genesis": {
    "capabilities": ["./dist/index.js"]
  }
}
```

Install = activation. Uninstall = gone. No manual registration.

---

## Summary: which path to use

```
Need custom logic, auth flow, binary protocol, internal SDK?
  → TypeScript plugin (Path A)

Wrapping a REST API, HTTP webhook, or simple JSON endpoint?
  → YAML file (Path B) — no code required

Sharing a workflow blueprint with someone else?
  → Export the SignedManifest JSON (Path C)

Building an integration others can install?
  → npm package (genesis-capability-*) containing TypeScript or YAML files
```

---

*Last updated: 2026-06-06*
*Implementation status:*
*  - `CapabilityPlugin` interface: built, tested (src/core/capability/capability.ts)*
*  - YAML loader + validator: built, 39 tests passing (src/core/extensions/yaml-capability.ts)*
*  - SignedManifest / compiler: built, tested (src/core/compiler/compiler.ts)*
*  - Plugin lifecycle (install/enable/disable/uninstall): built, end-to-end verified*
*    - Types: src/core/plugins/types.ts*
*    - Ports: src/core/plugins/ports.ts*
*    - SQLite registry: src/infrastructure/plugins/sqlite-plugin-repository.ts*
*    - YAML loader strategy: src/infrastructure/plugins/yaml-plugin-loader.ts*
*    - TypeScript loader strategy: src/infrastructure/plugins/typescript-plugin-loader.ts (v1 stub)*
*    - PluginFactory: src/core/plugins/plugin-factory.ts*
*    - PluginActivator (startup): src/core/plugins/plugin-activator.ts*
*    - PluginLifecycleService (Facade): src/core/plugins/lifecycle-service.ts*
*    - Supervisor: immutable snapshot swap, estimate() returns null for absent plugins*
*    - Real YAML plugin: capabilities/web-fetch.yaml*
*    - Real YAML plugin: capabilities/notify-webhook.yaml*
*    - Real TypeScript plugin: capabilities/text-transform.ts*
*    - End-to-end demo: npm run demo:plugins*
*  - Plugin loader (npm auto-discovery): not yet built*
*  - Channel adapter (Telegram/Slack): not yet built*
