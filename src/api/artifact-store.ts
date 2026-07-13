/**
 * Krelvan artifacts — the customer's *consume* side.
 *
 * Every completed non-chat run produces zero or one named, typed Artifact: the finished
 * output (a brief, a digest, a reply) as a first-class, rendered, shareable object. The
 * Inbox is a feed over these; run records stay one click behind ("how this was made").
 *
 * This store is modeled directly on RunRegistry (same atomicWrite persistence to
 * `data/artifacts.json`; migrate to SQLite later alongside the runs migration — not a
 * blocker). It is registered on KrelvanRuntime next to `runRegistry`.
 *
 * Invariants (consistent with the rest of the API layer):
 *   - Integer timestamps only (Date.now() — this is the impure adapter layer, not core).
 *   - Read/archive state lives server-side here (replacing the old localStorage keys).
 *   - Share tokens: 256-bit random, shown ONCE at mint; only the SHA-256 HASH is stored,
 *     verified constant-time — exactly the discipline in trigger-store.ts / auth.ts. A
 *     public reader is resolved by hashing the presented token and matching, never by
 *     storing or logging the plaintext.
 */

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { readFileSync, existsSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getLogger } from "../core/observability/logger.js";

const log = getLogger("artifact-store");

function atomicWrite(dest: string, content: string): void {
  const tmp = `${dest}.tmp`;
  writeFileSync(tmp, content, "utf8");
  renameSync(tmp, dest);
}

function sha256Hex(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex");
}

/** "art_" + 12 base64url chars (9 random bytes → 12 chars, url-safe, no padding). */
function newArtifactId(): string {
  return `art_${randomBytes(9).toString("base64url")}`;
}

export type ArtifactFormat = "markdown" | "text";

export interface ArtifactRecord {
  id: string;
  agentId: string;
  agentName: string;
  runId: string;
  /** present when the run was scheduler-fired (see Workstream C attribution). */
  scheduleId?: string;
  /** ≤ 120 chars, plain text. */
  title: string;
  /** the full output. */
  body: string;
  /** markdown is the default when the agent declares output via output_map. */
  format: ArtifactFormat;
  createdAt: number;
  /** server-side archive state (replaces the old localStorage ARCHIVED_KEY). */
  archived: boolean;
  /** server-side read state (replaces the old localStorage READ_KEY). */
  readAt?: number;
  /** sha256 hex of the live share token; absent = private (never public). */
  shareTokenHash?: string;
  /** shown on the agent's public feed when true (default false). Owner-controlled (B4). */
  published?: boolean;
}

/** Fields accepted when creating an artifact (ids/timestamps are assigned by the store). */
export interface ArtifactInput {
  agentId: string;
  agentName: string;
  runId: string;
  scheduleId?: string;
  title: string;
  body: string;
  format: ArtifactFormat;
}

/** Filter for list(). All fields optional; newest-first. */
export interface ArtifactQuery {
  agentId?: string;
  /** the run that produced the artifact (there is at most one). */
  runId?: string;
  archived?: boolean;
  /** case-insensitive substring over title+body. */
  q?: string;
  /** keyset pagination: only artifacts created strictly before this ms timestamp. */
  before?: number;
  limit?: number;
}

const TITLE_MAX = 120;

export class ArtifactStore {
  private artifacts = new Map<string, ArtifactRecord>();
  /** runId → artifactId, so re-folding/re-serving a run never creates a duplicate. */
  private byRun = new Map<string, string>();
  /** Monotonic insertion counter — a stable tiebreaker so two artifacts created within the
   *  same Date.now() millisecond still sort deterministically (last-created first). */
  private seq = 0;
  private readonly order = new Map<string, number>();
  private readonly path: string;

  constructor(dataDir: string) {
    this.path = join(dataDir, "artifacts.json");
    this.load();
  }

  private load(): void {
    if (!existsSync(this.path)) return;
    try {
      const raw = JSON.parse(readFileSync(this.path, "utf8")) as ArtifactRecord[];
      // Persisted in insertion order (Map values). Re-assign the monotonic seq in that
      // same order so the in-memory tiebreaker matches what was on disk.
      for (const a of raw) {
        this.artifacts.set(a.id, a);
        this.byRun.set(a.runId, a.id);
        this.order.set(a.id, this.seq++);
      }
    } catch (err) {
      log.warn({ err }, "failed to load artifacts.json — starting fresh");
    }
  }

  private persist(): void {
    atomicWrite(this.path, JSON.stringify([...this.artifacts.values()], null, 2));
  }

  /**
   * Create an artifact for a completed run. Idempotent by runId: if this run already has
   * an artifact, the existing record is returned unchanged (re-folding or re-serving a
   * run must not duplicate). Titles are clamped to TITLE_MAX chars, plain text.
   */
  create(input: ArtifactInput): ArtifactRecord {
    const existingId = this.byRun.get(input.runId);
    if (existingId) {
      const existing = this.artifacts.get(existingId);
      if (existing) return existing;
    }
    const title = input.title.length > TITLE_MAX ? `${input.title.slice(0, TITLE_MAX - 1)}…` : input.title;
    const record: ArtifactRecord = {
      id: newArtifactId(),
      agentId: input.agentId,
      agentName: input.agentName,
      runId: input.runId,
      ...(input.scheduleId ? { scheduleId: input.scheduleId } : {}),
      title,
      body: input.body,
      format: input.format,
      createdAt: Date.now(),
      archived: false,
    };
    this.artifacts.set(record.id, record);
    this.byRun.set(record.runId, record.id);
    this.order.set(record.id, this.seq++);
    this.persist();
    return record;
  }

  get(id: string): ArtifactRecord | undefined {
    return this.artifacts.get(id);
  }

  getByRun(runId: string): ArtifactRecord | undefined {
    const id = this.byRun.get(runId);
    return id ? this.artifacts.get(id) : undefined;
  }

  /** Newest-first, filtered. Chat runs never create artifacts, so nothing to exclude here. */
  list(query: ArtifactQuery = {}): ArtifactRecord[] {
    const q = query.q?.trim().toLowerCase();
    let out = [...this.artifacts.values()].filter((a) => {
      if (query.agentId && a.agentId !== query.agentId) return false;
      if (query.runId && a.runId !== query.runId) return false;
      if (query.archived !== undefined && a.archived !== query.archived) return false;
      if (query.before !== undefined && a.createdAt >= query.before) return false;
      if (q && !(`${a.title}\n${a.body}`.toLowerCase().includes(q))) return false;
      return true;
    });
    out.sort((a, b) => b.createdAt - a.createdAt || (this.order.get(b.id) ?? 0) - (this.order.get(a.id) ?? 0));
    if (query.limit !== undefined && query.limit >= 0) out = out.slice(0, query.limit);
    return out;
  }

  /** Patch archive/read state. Returns the updated record, or undefined if absent. */
  update(id: string, patch: { archived?: boolean; read?: boolean }): ArtifactRecord | undefined {
    const a = this.artifacts.get(id);
    if (!a) return undefined;
    if (patch.archived !== undefined) a.archived = patch.archived;
    if (patch.read !== undefined) {
      if (patch.read) { if (a.readAt === undefined) a.readAt = Date.now(); }
      else delete a.readAt;
    }
    this.persist();
    return a;
  }

  delete(id: string): boolean {
    const a = this.artifacts.get(id);
    if (!a) return false;
    this.artifacts.delete(id);
    this.byRun.delete(a.runId);
    this.order.delete(id);
    this.persist();
    return true;
  }

  /**
   * Mint (or rotate) a public share token for an artifact. Returns the PLAINTEXT token
   * ONCE — only its hash is stored; rotating invalidates the previous link. Returns
   * undefined if the artifact doesn't exist.
   */
  mintShare(id: string): string | undefined {
    const a = this.artifacts.get(id);
    if (!a) return undefined;
    const plaintext = randomBytes(32).toString("base64url");
    a.shareTokenHash = sha256Hex(plaintext);
    this.persist();
    return plaintext;
  }

  /** Revoke an artifact's share link. Returns true if a link existed. */
  revokeShare(id: string): boolean {
    const a = this.artifacts.get(id);
    if (!a || a.shareTokenHash === undefined) return false;
    delete a.shareTokenHash;
    this.persist();
    return true;
  }

  /**
   * Resolve the shared artifact for a presented token, constant-time. Returns the record
   * or undefined. The caller is responsible for projecting it to the public shape (never
   * exposing runId or internal ids).
   */
  resolveShare(token: string | undefined): ArtifactRecord | undefined {
    if (!token) return undefined;
    const presented = Buffer.from(sha256Hex(token), "hex");
    let match: ArtifactRecord | undefined;
    // Constant-time over every artifact that has a live token: compare all, never
    // short-circuit on the first mismatch (no timing signal about which/whether matched).
    for (const a of this.artifacts.values()) {
      if (a.shareTokenHash === undefined) continue;
      const stored = Buffer.from(a.shareTokenHash, "hex");
      if (presented.length === stored.length && timingSafeEqual(presented, stored)) match = a;
    }
    return match;
  }
}
