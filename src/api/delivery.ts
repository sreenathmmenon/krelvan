/**
 * Output delivery layer — "deliver output to →".
 *
 * When a run completes, its human-facing output can be pushed to the destinations the
 * customer chose for that agent: their email, Slack, Telegram, or any webhook (which
 * bridges to WhatsApp/SMS/social/their own tools). Every channel is a pluggable TARGET
 * that reuses the SAME send-capability plugins the engine uses — delivery is just
 * invoking that plugin with the run's output as input. New channels (LinkedIn, WhatsApp,
 * SMS, …) plug in here or ship as marketplace connectors on the same rails.
 *
 * This is fire-and-forget and best-effort: a delivery failure NEVER fails the run (the
 * output already landed in the Inbox). Each attempt is logged so the customer can see it.
 */
import type { CapabilityPlugin, EffectCall } from "../core/capability/capability.js";
import { emailSendCapability } from "../core/plugins/email-send.js";
import { slackSendCapability } from "../core/plugins/slack-send.js";
import { telegramSendCapability } from "../core/plugins/telegram-send.js";
import { notifyWebhookCapability } from "../core/plugins/notify-webhook.js";
import { getLogger } from "../core/observability/logger.js";

const log = getLogger("delivery");

/** The channels shipped built-in. Everything else is a webhook or a marketplace connector. */
export type DeliveryChannel =
  | "inbox" | "email" | "slack" | "telegram" | "webhook"
  | "sms" | "whatsapp" | "twitter" | "linkedin" | "discord";

/** One destination a customer chose for an agent's output. */
export interface DeliveryTarget {
  channel: DeliveryChannel;
  /** Per-channel destination config (email `to`, telegram `chat_id`, webhook `url`, …). */
  config?: Record<string, string>;
}

export interface DeliveryOutcome {
  channel: DeliveryChannel;
  ok: boolean;
  detail?: string;
}

/** A completed run's human-facing output, ready to deliver. */
export interface DeliveryPayload {
  agentName: string;
  runId: string;
  /** The headline / one-line result. */
  title: string;
  /** The full output text (may equal title). */
  body: string;
}

/** Channels served by an existing send-plugin (reuse the engine's transport). */
const CHANNEL_PLUGIN: Partial<Record<DeliveryChannel, CapabilityPlugin>> = {
  email: emailSendCapability,
  slack: slackSendCapability,
  telegram: telegramSendCapability,
  webhook: notifyWebhookCapability,
  discord: notifyWebhookCapability, // Discord accepts a plain webhook POST ({ content })
};

/**
 * Channels served by a direct provider API call. Each is a small adapter on the same rails:
 * take the output, shape the provider's request, POST it (via safeFetch — SSRF-guarded).
 * Keys come from the target config (customer paste) or env, never hardcoded.
 */
const DIRECT_CHANNELS = new Set<DeliveryChannel>(["sms", "whatsapp", "twitter", "linkedin"]);

async function sendDirect(channel: DeliveryChannel, p: DeliveryPayload, cfg: Record<string, string>): Promise<DeliveryOutcome> {
  const { safeFetch } = await import("../core/plugins/safe-fetch.js");
  const text = `${p.agentName}: ${p.body}`;
  try {
    if (channel === "sms" || channel === "whatsapp") {
      // Twilio: POST Messages.json with Basic auth (Account SID : Auth Token), form-encoded.
      const sid = cfg["account_sid"] ?? process.env["KRELVAN_TWILIO_SID"] ?? "";
      const token = cfg["auth_token"] ?? process.env["KRELVAN_TWILIO_TOKEN"] ?? "";
      const from = cfg["from"] ?? process.env["KRELVAN_TWILIO_FROM"] ?? "";
      const to = cfg["to"] ?? "";
      if (!sid || !token || !from || !to) return { channel, ok: false, detail: "needs Twilio account_sid, auth_token, from and to — add them in Secrets / the channel config" };
      const pfx = channel === "whatsapp" ? "whatsapp:" : "";
      const form = new URLSearchParams({ To: `${pfx}${to}`, From: `${pfx}${from}`, Body: text.slice(0, 1500) });
      const resp = await safeFetch(`https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(sid)}/Messages.json`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", authorization: `Basic ${Buffer.from(`${sid}:${token}`).toString("base64")}` },
        body: form.toString(),
      });
      return { channel, ok: resp.ok, detail: resp.ok ? "delivered" : `Twilio returned ${resp.status}` };
    }
    if (channel === "twitter") {
      // X API v2: POST /2/tweets with an OAuth2 user bearer token. Post ≤ 280 chars.
      const bearer = cfg["bearer_token"] ?? process.env["KRELVAN_X_BEARER"] ?? "";
      if (!bearer) return { channel, ok: false, detail: "needs an X (Twitter) bearer_token — add it in the channel config / Secrets" };
      const resp = await safeFetch("https://api.twitter.com/2/tweets", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${bearer}` },
        body: JSON.stringify({ text: p.body.slice(0, 280) }),
      });
      return { channel, ok: resp.ok, detail: resp.ok ? "posted" : `X returned ${resp.status}` };
    }
    if (channel === "linkedin") {
      // LinkedIn UGC: POST /v2/ugcPosts with a member bearer token + the author URN.
      const bearer = cfg["bearer_token"] ?? process.env["KRELVAN_LINKEDIN_BEARER"] ?? "";
      const authorUrn = cfg["author_urn"] ?? process.env["KRELVAN_LINKEDIN_URN"] ?? "";
      if (!bearer || !authorUrn) return { channel, ok: false, detail: "needs a LinkedIn bearer_token and author_urn (urn:li:person:…) — add them in the channel config" };
      const resp = await safeFetch("https://api.linkedin.com/v2/ugcPosts", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${bearer}`, "X-Restli-Protocol-Version": "2.0.0" },
        body: JSON.stringify({
          author: authorUrn,
          lifecycleState: "PUBLISHED",
          specificContent: { "com.linkedin.ugc.ShareContent": { shareCommentary: { text: p.body.slice(0, 2900) }, shareMediaCategory: "NONE" } },
          visibility: { "com.linkedin.ugc.MemberNetworkVisibility": "PUBLIC" },
        }),
      });
      return { channel, ok: resp.ok, detail: resp.ok ? "posted" : `LinkedIn returned ${resp.status}` };
    }
    return { channel, ok: false, detail: "unknown direct channel" };
  } catch (err) {
    return { channel, ok: false, detail: (err as Error)?.message ?? "send error" };
  }
}

/** Shape the payload into the input keys each channel's plugin expects. */
function inputFor(channel: DeliveryChannel, p: DeliveryPayload, cfg: Record<string, string>): Record<string, unknown> {
  const heading = `${p.agentName}: ${p.title}`;
  switch (channel) {
    case "email":
      return { to: cfg["to"] ?? "", subject: `${p.agentName} — ${p.title}`.slice(0, 120), body: p.body, from: cfg["from"] };
    case "slack":
      return { text: `*${p.agentName}*\n${p.body}`, ...(cfg["webhook_url"] ? { webhook_url: cfg["webhook_url"] } : {}), ...(cfg["channel"] ? { channel: cfg["channel"] } : {}) };
    case "telegram":
      return { text: `<b>${escapeHtml(p.agentName)}</b>\n${escapeHtml(p.body)}`, ...(cfg["chat_id"] ? { chat_id: cfg["chat_id"] } : {}) };
    case "webhook":
      // notify_webhook posts input.payload as the JSON body — put the full output there.
      return { url: cfg["url"] ?? "", payload: { agent: p.agentName, title: p.title, output: p.body, runId: p.runId } };
    case "discord":
      // Discord incoming webhooks accept { content } — send it as the webhook payload.
      return { url: cfg["url"] ?? "", payload: { content: `**${p.agentName}**\n${p.body}`.slice(0, 1900) } };
    default:
      return {};
  }
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * Deliver a completed run's output to every chosen target. Best-effort: returns an
 * outcome per target and never throws. `inbox` is a no-op here (the run already appears
 * in the Inbox); it exists so a customer can explicitly pick "just the inbox".
 */
export async function deliver(targets: DeliveryTarget[], payload: DeliveryPayload): Promise<DeliveryOutcome[]> {
  const outcomes: DeliveryOutcome[] = [];
  for (const t of targets) {
    if (t.channel === "inbox") { outcomes.push({ channel: "inbox", ok: true, detail: "in the Inbox" }); continue; }
    // Direct-API channels (SMS/WhatsApp/X/LinkedIn) — a small provider adapter on the same rails.
    if (DIRECT_CHANNELS.has(t.channel)) { outcomes.push(await sendDirect(t.channel, payload, t.config ?? {})); continue; }
    const plugin = CHANNEL_PLUGIN[t.channel];
    if (!plugin) { outcomes.push({ channel: t.channel, ok: false, detail: "unknown channel" }); continue; }
    try {
      const call: EffectCall = {
        nodeId: `deliver:${t.channel}`,
        capability: plugin.name,
        input: inputFor(t.channel, payload, t.config ?? {}),
      } as EffectCall;
      const res = await plugin.invoke(call);
      const out = (res.output ?? {}) as Record<string, unknown>;
      // Each channel plugin signals success with its own key: email/slack/telegram → sent,
      // notify_webhook → notified. A missing key/creds returns the false form.
      const ok = out["sent"] === true || out["ok"] === true || out["delivered"] === true || out["notified"] === true;
      outcomes.push({ channel: t.channel, ok, detail: ok ? "delivered" : String(out["error"] ?? out["reason"] ?? "not configured — add the channel's key/URL in Secrets") });
    } catch (err) {
      outcomes.push({ channel: t.channel, ok: false, detail: (err as Error)?.message ?? "delivery error" });
    }
  }
  log.info({ runId: payload.runId, agent: payload.agentName, outcomes: outcomes.map(o => `${o.channel}:${o.ok ? "ok" : "fail"}`) }, "output delivered");
  return outcomes;
}

/** Validate a deliverTo array coming from the API — drops malformed entries. */
export function sanitizeTargets(raw: unknown): DeliveryTarget[] {
  if (!Array.isArray(raw)) return [];
  const valid: DeliveryChannel[] = ["inbox", "email", "slack", "telegram", "webhook", "sms", "whatsapp", "twitter", "linkedin", "discord"];
  const out: DeliveryTarget[] = [];
  for (const r of raw) {
    if (!r || typeof r !== "object") continue;
    const ch = (r as { channel?: unknown }).channel;
    if (typeof ch !== "string" || !valid.includes(ch as DeliveryChannel)) continue;
    const cfgRaw = (r as { config?: unknown }).config;
    const config: Record<string, string> = {};
    if (cfgRaw && typeof cfgRaw === "object") {
      for (const [k, v] of Object.entries(cfgRaw as Record<string, unknown>)) {
        if (typeof v === "string" && v.length <= 2000) config[k] = v;
      }
    }
    out.push({ channel: ch as DeliveryChannel, config });
  }
  // dedupe by channel (last wins), cap at a sane number
  const byChannel = new Map<DeliveryChannel, DeliveryTarget>();
  for (const t of out) byChannel.set(t.channel, t);
  return [...byChannel.values()].slice(0, 8);
}
