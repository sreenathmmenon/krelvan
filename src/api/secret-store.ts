/**
 * SecretStore — customer-managed secrets for a self-hosted Krelvan.
 *
 * Why this exists: a capability references a secret by name (e.g.
 * `{{secret:vercel-deploy-hook}}`). The secret is the CUSTOMER'S — their deploy
 * hook, their API key, deploying into THEIR account. They must be able to set it
 * from the UI on their own instance, not by SSHing in to edit env vars.
 *
 * Storage: encrypted at rest with AES-256-GCM. The key lives in `secret.key`
 * inside the data dir (chmod 600), generated once. This keeps `secrets.json` from
 * being plaintext if the data dir is backed up or snapshotted. It is NOT a claim
 * of protection against an attacker who already has the data dir + key — that is
 * the self-hoster's machine boundary to defend.
 *
 * Resolution order at run time: a set secret wins; otherwise fall back to an env
 * var of the same name (so existing env-based config keeps working).
 *
 * Security: values are never logged and never returned in full by list() — only a
 * masked preview. The plaintext is returned only to the secret broker's resolve().
 */

import { join } from "node:path";
import { existsSync, readFileSync, writeFileSync, renameSync, chmodSync } from "node:fs";
import { randomBytes, createCipheriv, createDecipheriv } from "node:crypto";
import { getLogger } from "../core/observability/logger.js";

const log = getLogger("secret-store");

const ALG = "aes-256-gcm";

export interface SecretMeta {
  /** the secret's name — matches a capability's {{secret:name}} ref */
  name: string;
  /** masked preview, e.g. "https://api.ver…a1b2" — never the full value */
  preview: string;
  updatedAt: number;
}

interface StoredSecret {
  name: string;
  /** base64(iv) : base64(authTag) : base64(ciphertext) */
  enc: string;
  updatedAt: number;
}

function maskValue(value: string): string {
  const v = value.trim();
  if (v.length <= 8) return "•".repeat(Math.max(v.length, 4));
  return `${v.slice(0, 6)}…${v.slice(-4)}`;
}

export class SecretStore {
  private secrets = new Map<string, StoredSecret>();
  private readonly path: string;
  private readonly key: Buffer;

  constructor(dataDir: string) {
    this.path = join(dataDir, "secrets.json");
    this.key = this.loadOrCreateKey(join(dataDir, "secret.key"));
    this.load();
  }

  private loadOrCreateKey(keyPath: string): Buffer {
    if (existsSync(keyPath)) {
      return Buffer.from(readFileSync(keyPath, "utf8").trim(), "hex");
    }
    const key = randomBytes(32);
    writeFileSync(keyPath, key.toString("hex"), "utf8");
    try { chmodSync(keyPath, 0o600); } catch { /* best-effort on platforms without chmod */ }
    log.info({}, "generated new secret-store encryption key");
    return key;
  }

  private load(): void {
    if (!existsSync(this.path)) return;
    try {
      const raw = JSON.parse(readFileSync(this.path, "utf8")) as StoredSecret[];
      for (const s of raw) this.secrets.set(s.name, s);
      log.info({ count: this.secrets.size }, "loaded secrets from disk");
    } catch (err) {
      log.warn({ err }, "failed to load secrets.json — starting fresh");
    }
  }

  private persist(): void {
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, JSON.stringify([...this.secrets.values()], null, 2), "utf8");
    renameSync(tmp, this.path);
    try { chmodSync(this.path, 0o600); } catch { /* best-effort */ }
  }

  private encrypt(plaintext: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv(ALG, this.key, iv);
    const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();
    return `${iv.toString("base64")}:${tag.toString("base64")}:${ct.toString("base64")}`;
  }

  private decrypt(enc: string): string | undefined {
    try {
      const [ivB, tagB, ctB] = enc.split(":");
      if (!ivB || !tagB || !ctB) return undefined;
      const decipher = createDecipheriv(ALG, this.key, Buffer.from(ivB, "base64"));
      decipher.setAuthTag(Buffer.from(tagB, "base64"));
      return Buffer.concat([decipher.update(Buffer.from(ctB, "base64")), decipher.final()]).toString("utf8");
    } catch (err) {
      log.warn({ err }, "failed to decrypt a secret (key changed?)");
      return undefined;
    }
  }

  /** Set (create or replace) a secret. Empty/whitespace values are rejected. */
  set(name: string, value: string): { ok: true; meta: SecretMeta } | { ok: false; error: string } {
    const n = name.trim();
    if (!n) return { ok: false, error: "name is required" };
    if (!/^[a-zA-Z0-9_.-]+$/.test(n)) return { ok: false, error: "name may contain only letters, digits, dot, dash, underscore" };
    if (!value || !value.trim()) return { ok: false, error: "value is required" };
    const record: StoredSecret = { name: n, enc: this.encrypt(value.trim()), updatedAt: Date.now() };
    this.secrets.set(n, record);
    this.persist();
    return { ok: true, meta: { name: n, preview: maskValue(value), updatedAt: record.updatedAt } };
  }

  delete(name: string): boolean {
    const existed = this.secrets.delete(name);
    if (existed) this.persist();
    return existed;
  }

  has(name: string): boolean {
    return this.secrets.has(name) || process.env[name] !== undefined;
  }

  /** Public metadata only — never the plaintext. */
  list(): SecretMeta[] {
    return [...this.secrets.values()]
      .map(s => ({ name: s.name, preview: this.previewOf(s), updatedAt: s.updatedAt }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  private previewOf(s: StoredSecret): string {
    const v = this.decrypt(s.enc);
    return v ? maskValue(v) : "•••• (unreadable)";
  }

  /**
   * Resolve a secret to its plaintext for the broker. A stored secret wins;
   * otherwise fall back to an env var of the same name.
   */
  resolve(name: string): string | undefined {
    const stored = this.secrets.get(name);
    if (stored) {
      const v = this.decrypt(stored.enc);
      if (v !== undefined) return v;
    }
    return process.env[name];
  }
}
