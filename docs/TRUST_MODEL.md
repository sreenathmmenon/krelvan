# The Krelvan Trust Model — what the ledger proves, and what it doesn't

Krelvan's core claim is that an agent run is **provable**: every step is signed into an
append-only, content-addressed, hash-chained ledger you can verify offline. This document
states precisely what that buys you, where its limits are, and how each limit is addressed —
because a trust claim that hides its own boundaries isn't one.

## The sharpest objection first

> *"A ledger the runtime signs about itself proves the record wasn't altered after the
> fact — not that the record was true when it was written."*

This is correct, and it applies to every self-attested audit system (ours included).
Krelvan's answer is not to deny it but to layer defenses so the gap between "recorded"
and "true" is as small as we can honestly make it — and to say exactly where the
residual gap sits.

## Layer 1 — What the signed ledger proves outright

For an Ed25519 ledger, given only the event log and the public keys, a third party can
verify **offline** (`npx krelvan verify <proof.json>`):

- **Integrity** — every event's id is the content-address of its canonical preimage;
  any payload edit is detected (`HashMismatch`).
- **Order & completeness** — the preimage includes `prev` and `offset`; reordering,
  insertion, offset gaps, and (with a signed checkpoint) tail truncation are detected.
- **Non-repudiation** — signatures verify against the issuer's public key; forgery
  requires the private key. A bundle re-signed by someone else fails when the verifier
  pins the issuer's real key (`--key`).
- **Replayability** — the run's state is a pure fold of these events; the same log
  folds to the same state, deterministically.

What this rules out: retroactive editing. An operator cannot quietly rewrite what an
agent did, insert a flattering step, drop an embarrassing one, or truncate the ending —
not without every verifier seeing it.

## Layer 2 — Capture-time honesty (narrowing "recorded" vs "true")

The record is written by the runtime, so the runtime's own honesty is layered:

- **Plugins never sign their own results.** The Supervisor invokes the plugin and
  co-signs the *observed* `EffectResult`. A capability cannot author its own history.
- **Cost is supervisor-metered.** Every LLM completion through the shared client is
  measured from provider-reported token usage inside the supervisor's meter scope, and
  settlement is `max(pluginClaim, metered)` — a plugin can raise its declared cost, but
  can never under-report metered spend to slip past a budget ceiling. The claim and the
  meter are stored as separate fields, so which one settled is itself auditable.
- **Deny-by-default admission.** A node can only invoke capabilities its signed
  manifest grants; admission decisions (including denials) are ledger events.
- **Key-role separation.** Orchestration events are signed by the owner key; effect
  results by the supervisor key. Signing keys have validity windows and epochs.
- **No-eval control flow.** Edge conditions are a restricted, depth-bounded AST — the
  recorded routing decision is the only routing that can have happened.

## Layer 3 — The residual gap, stated plainly

Two things this core does **not** yet prove, and how we treat them until it does:

1. **A plugin's own I/O is self-reported.** Work a plugin does through its own network
   stack (e.g. a raw call to a paid API) is invisible to the cost meter and its output
   is what the plugin returned. The supervisor records it as an observation of the
   plugin's behavior — which is exactly what it is. The production answer is a
   sandboxed egress proxy (all plugin I/O brokered and independently observed);
   until that ships we do not claim independent verification of third-party plugin I/O.
2. **The instance operator holds the signing keys.** An operator who controls the
   host and both keys could run a parallel doctored ledger from the start (not edit an
   existing one — that stays detectable). Mitigations available today: publish your
   public keys out-of-band (so counterparties pin them), export proof bundles to the
   counterparty at run time (a receiver who already holds the bundle can't be given a
   different history later). Roadmap: **external anchoring** — periodically publishing
   ledger checkpoint hashes to an independent witness (a transparency log, a public
   timestamping service, or a counterparty), which converts "trust the operator's
   keys" into "trust that the operator can't rewrite anything older than the last
   anchor." Receiver-attested receipts (the counterparty co-signs what it received)
   are the strongest form and compose naturally with the existing bundle format.

## What we will not claim

- Not "unhackable," not "zero-trust," not "blockchain."
- Not "required by the EU AI Act" — Article 12 requires record-keeping, not
  cryptographic immutability. We think tamper-evidence is the *right* way to keep
  records; the law does not (yet) mandate our way.
- Not independent verification of third-party plugin I/O — see Layer 3, until the
  egress proxy ships.

If you find a hole in any of the properties claimed in Layers 1–2, that's a bug —
please report it.
