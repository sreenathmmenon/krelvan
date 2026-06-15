// Side-effect model — the trust centerpiece of the Capabilities page.
// Mirrors the 6 classes in src/core/manifest/manifest.ts and the deterministic
// needsApproval() in src/core/capability/capability.ts, so the UI's "approval
// simulator" matches what the engine actually does.

export type Autonomy = "suggest" | "act-with-veto" | "full";

export interface SideEffectMeta {
  label: string;       // plain-language
  tier: 0 | 1 | 2;     // 0 = reads, 1 = reversible writes, 2 = dangerous
  tone: "neutral" | "info" | "live" | "danger";
}

export const SIDE_EFFECTS: Record<string, SideEffectMeta> = {
  "read":                 { label: "Reads data",            tier: 0, tone: "neutral" },
  "read-write":           { label: "Reads & writes",        tier: 1, tone: "info" },
  "write-reversible":     { label: "Reversible changes",    tier: 1, tone: "info" },
  "write-irreversible":   { label: "Permanent changes",     tier: 2, tone: "danger" },
  "spend":                { label: "Spends money",          tier: 2, tone: "danger" },
  "message-human":        { label: "Messages people",       tier: 1, tone: "live" },
  "identity-mutation":    { label: "Changes access",        tier: 2, tone: "danger" },
};

export function sideEffectMeta(s: string): SideEffectMeta {
  return SIDE_EFFECTS[s] ?? { label: s, tier: 1, tone: "info" };
}

// Token mapping per tone (uses existing globals.css tokens).
export function toneColors(tone: SideEffectMeta["tone"]): { bg: string; fg: string } {
  switch (tone) {
    case "neutral": return { bg: "var(--surface-sunken)", fg: "var(--ink-soft)" };
    case "info":    return { bg: "var(--info-tint)",      fg: "var(--info)" };
    case "live":    return { bg: "var(--live-tint)",      fg: "var(--live)" };
    case "danger":  return { bg: "var(--danger-tint)",    fg: "var(--danger)" };
  }
}

// Deterministic — matches needsApproval() in the engine.
export function needsApproval(autonomy: Autonomy, effect: string): boolean {
  if (effect === "read") return false;
  if (autonomy === "suggest") return true;
  if (autonomy === "act-with-veto") {
    return effect === "write-irreversible" || effect === "spend" || effect === "identity-mutation";
  }
  // full
  return effect === "spend" || effect === "identity-mutation";
}
