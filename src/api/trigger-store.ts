/**
 * Krelvan webhook trigger tokens — the inbound/interactive path.
 *
 * An agent can be given a per-agent webhook token so an EXTERNAL system (a form, a
 * Slack/GitHub webhook via a relay, an IFTTT-style automation, a cron on another box)
 * can start a run by POSTing to `/api/triggers/:agentId` with the token — WITHOUT a
 * browser login/CSRF. The request body becomes the run's initialState.
 *
 * Security model (same discipline as auth.ts / secret-store.ts):
 *   - Token is 256-bit random, shown ONCE at creation; only its SHA-256 HASH is persisted.
 *   - Verification is constant-time over hashes.
 *   - One token per agent (rotating mints a new one and invalidates the old).
 *   - The route is rate-limited and the token, never logged.
 * This is machine-to-machine auth scoped to ONE agent — strictly weaker than the admin
 * session, and it can ONLY start that agent's run (no data read, no config change).
 */

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { readFileSync, writeFileSync, existsSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { getLogger } from "../core/observability/logger.js";

const log = getLogger("trigger-store");

function sha256Hex(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex");
}

interface TriggerRecord {
  /** the agent this token triggers */
  agentId: string;
  /** sha256(token) — the only form we keep */
  tokenHash: string;
  createdAt: number;
}

export class TriggerStore {
  private byAgent = new Map<string, TriggerRecord>();
  private readonly path: string;

  constructor(dataDir: string) {
    this.path = join(dataDir, "triggers.json");
    this.load();
  }

  private load(): void {
    if (!existsSync(this.path)) return;
    try {
      const raw = JSON.parse(readFileSync(this.path, "utf8")) as TriggerRecord[];
      for (const t of raw) this.byAgent.set(t.agentId, t);
    } catch (err) {
      log.warn({ err }, "failed to load triggers.json — starting fresh");
    }
  }

  private persist(): void {
    try {
      writeFileSync(this.path, JSON.stringify([...this.byAgent.values()], null, 2), "utf8");
      try { chmodSync(this.path, 0o600); } catch { /* best-effort */ }
    } catch (err) {
      log.warn({ err }, "could not persist triggers.json");
    }
  }

  /** True if this agent currently has a trigger token. */
  has(agentId: string): boolean {
    return this.byAgent.has(agentId);
  }

  /**
   * Mint (or rotate) the token for an agent. Returns the PLAINTEXT token ONCE — it is
   * never stored or retrievable again. Rotating invalidates the previous token.
   */
  mint(agentId: string): string {
    const plaintext = randomBytes(32).toString("base64url");
    this.byAgent.set(agentId, { agentId, tokenHash: sha256Hex(plaintext), createdAt: Date.now() });
    this.persist();
    return plaintext;
  }

  /** Remove an agent's trigger token (disables its webhook). */
  revoke(agentId: string): boolean {
    const existed = this.byAgent.delete(agentId);
    if (existed) this.persist();
    return existed;
  }

  /** Constant-time check that `token` is the live token for `agentId`. */
  verify(agentId: string, token: string | undefined): boolean {
    if (!token) return false;
    const rec = this.byAgent.get(agentId);
    if (!rec) return false;
    const presented = Buffer.from(sha256Hex(token), "hex");
    const stored = Buffer.from(rec.tokenHash, "hex");
    if (presented.length !== stored.length) return false;
    return timingSafeEqual(presented, stored);
  }
}
