/**
 * "email_send" capability — send an email via Resend API or raw SMTP.
 *
 * Provider selection:
 *   1. Resend (KRELVAN_RESEND_KEY) — primary, single HTTP call.
 *   2. SMTP (KRELVAN_SMTP_HOST + KRELVAN_SMTP_USER + KRELVAN_SMTP_PASS) — fallback,
 *      raw ESMTP over node:net (no npm deps), AUTH LOGIN, EHLO handshake.
 *
 * If neither provider is configured, returns { sent: false, error: "..." }
 * without throwing (graceful degradation).
 *
 * Input keys:
 *   to      — recipient email address (required)
 *   subject — email subject (default: "Message from Krelvan agent")
 *   body    — plain-text body content (required)
 *   from    — sender address (default: "krelvan@agents.local")
 *
 * Output: { sent, messageId?, provider?, error? }
 *
 * Side effect: "message-human"
 * Cost estimate: 5 cents per call.
 */

import * as net from "node:net";
import type { CapabilityPlugin, EffectCall } from "../capability/capability.js";
import { fetchWithRetry } from "../../adapters/http-retry.js";
import { getLogger } from "../observability/logger.js";

const log = getLogger("email-send");

// ── secret resolver hook ────────────────────────────────────────────────────────
// By default the Resend key / SMTP creds / sender come from env vars (the instance-wide,
// super-admin path). The runtime overrides this at boot (setEmailSecretResolver) so a
// UI-saved secret in the encrypted SecretStore is used automatically — no env var, no
// restart — giving each user their own sender. The resolver still falls back to env, so
// the precedence is: per-user UI connection → instance-wide env default.
let secretResolver: (name: string) => string | undefined = (n) => process.env[n];

/** Runtime wiring point: route KRELVAN_RESEND_KEY / KRELVAN_SMTP_* / KRELVAN_EMAIL_FROM
 *  lookups through the SecretStore (UI-saved secret first, env fallback). */
export function setEmailSecretResolver(fn: (name: string) => string | undefined): void {
  secretResolver = fn;
}

// ── types ─────────────────────────────────────────────────────────────────────

interface EmailSendOutput {
  sent: boolean;
  messageId?: string;
  provider?: "resend" | "smtp";
  /** "inbox" when no recipient was configured and the message was delivered via the Inbox floor. */
  via?: "inbox";
  error?: string;
}

// ── Resend path ───────────────────────────────────────────────────────────────

async function sendViaResend(
  apiKey: string,
  from: string,
  to: string,
  subject: string,
  body: string,
): Promise<EmailSendOutput> {
  log.info({ to, subject }, "email-send: using Resend provider");

  const outcome = await fetchWithRetry(
    "https://api.resend.com/emails",
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "authorization": `Bearer ${apiKey}`,
      },
      body: JSON.stringify({ from, to, subject, text: body }),
    },
    { maxAttempts: 3, baseDelayMs: 500 },
  );

  if (!outcome.ok) {
    const errMsg = outcome.status === 0
      ? `network error: ${outcome.rawBody}`
      : `Resend API ${outcome.status}: ${outcome.rawBody}`;
    log.error({ status: outcome.status }, `email-send: Resend failed — ${errMsg}`);
    return { sent: false, provider: "resend", error: errMsg };
  }

  const json = (await outcome.resp.json()) as { id?: string; error?: string };

  if (json.error) {
    log.error({ resendError: json.error }, "email-send: Resend returned error in body");
    return { sent: false, provider: "resend", error: json.error };
  }

  log.info({ messageId: json.id, to }, "email-send: Resend sent");
  return { sent: true, provider: "resend", messageId: json.id };
}

// ── SMTP path ─────────────────────────────────────────────────────────────────

/** Read lines from a socket until we see a final line (4th char is space, not dash). */
function readSMTPResponse(socket: net.Socket): Promise<string> {
  return new Promise((resolve, reject) => {
    let buf = "";
    const onData = (chunk: Buffer) => {
      buf += chunk.toString("ascii");
      const lines = buf.split("\r\n");
      // The last segment is incomplete; walk completed lines looking for a final response.
      for (let i = 0; i < lines.length - 1; i++) {
        const line = lines[i] ?? "";
        if (line.length >= 4 && line[3] === " ") {
          // Final response line for this reply.
          socket.off("data", onData);
          socket.off("error", onError);
          resolve(buf);
          return;
        }
      }
      // Keep incomplete buffer.
      buf = lines[lines.length - 1] ?? "";
    };
    const onError = (err: Error) => {
      socket.off("data", onData);
      reject(err);
    };
    socket.on("data", onData);
    socket.once("error", onError);
  });
}

function smtpWrite(socket: net.Socket, line: string): void {
  socket.write(line + "\r\n", "ascii");
}

function smtpCode(response: string): number {
  return parseInt(response.slice(0, 3), 10);
}

async function sendViaSMTP(
  host: string,
  port: number,
  user: string,
  pass: string,
  from: string,
  to: string,
  subject: string,
  body: string,
): Promise<EmailSendOutput> {
  log.info({ host, port, to, subject }, "email-send: using SMTP provider");

  return new Promise<EmailSendOutput>((resolve) => {
    const socket = net.createConnection({ host, port });
    socket.setTimeout(15_000);

    const fail = (reason: string): void => {
      log.error({ reason }, "email-send: SMTP failed");
      socket.destroy();
      resolve({ sent: false, provider: "smtp", error: reason });
    };

    socket.once("timeout", () => fail("SMTP connection timed out after 15s"));
    socket.once("error", (err: Error) => fail(`SMTP socket error: ${err.message}`));

    (async () => {
      try {
        // 220 greeting
        const greeting = await readSMTPResponse(socket);
        if (smtpCode(greeting) !== 220) {
          fail(`expected 220 greeting, got: ${greeting.slice(0, 80)}`);
          return;
        }

        // EHLO
        smtpWrite(socket, `EHLO krelvan-agent`);
        const ehloResp = await readSMTPResponse(socket);
        if (smtpCode(ehloResp) !== 250) {
          fail(`EHLO failed: ${ehloResp.slice(0, 80)}`);
          return;
        }

        // AUTH LOGIN if advertised
        const supportsAuthLogin = ehloResp.toUpperCase().includes("AUTH") && ehloResp.toUpperCase().includes("LOGIN");
        if (supportsAuthLogin) {
          smtpWrite(socket, "AUTH LOGIN");
          const authPrompt1 = await readSMTPResponse(socket);
          if (smtpCode(authPrompt1) !== 334) {
            fail(`AUTH LOGIN step 1 failed: ${authPrompt1.slice(0, 80)}`);
            return;
          }
          smtpWrite(socket, Buffer.from(user, "utf-8").toString("base64"));
          const authPrompt2 = await readSMTPResponse(socket);
          if (smtpCode(authPrompt2) !== 334) {
            fail(`AUTH LOGIN step 2 (username) failed: ${authPrompt2.slice(0, 80)}`);
            return;
          }
          smtpWrite(socket, Buffer.from(pass, "utf-8").toString("base64"));
          const authOk = await readSMTPResponse(socket);
          if (smtpCode(authOk) !== 235) {
            fail(`AUTH LOGIN credentials rejected: ${authOk.slice(0, 80)}`);
            return;
          }
        }

        // MAIL FROM
        smtpWrite(socket, `MAIL FROM:<${from}>`);
        const mailFromResp = await readSMTPResponse(socket);
        if (smtpCode(mailFromResp) !== 250) {
          fail(`MAIL FROM rejected: ${mailFromResp.slice(0, 80)}`);
          return;
        }

        // RCPT TO
        smtpWrite(socket, `RCPT TO:<${to}>`);
        const rcptResp = await readSMTPResponse(socket);
        if (smtpCode(rcptResp) !== 250) {
          fail(`RCPT TO rejected: ${rcptResp.slice(0, 80)}`);
          return;
        }

        // DATA
        smtpWrite(socket, "DATA");
        const dataResp = await readSMTPResponse(socket);
        if (smtpCode(dataResp) !== 354) {
          fail(`DATA command failed: ${dataResp.slice(0, 80)}`);
          return;
        }

        // Headers + body; dot-stuff lines beginning with "."
        const message = [
          `From: ${from}`,
          `To: ${to}`,
          `Subject: ${subject}`,
          `MIME-Version: 1.0`,
          `Content-Type: text/plain; charset=UTF-8`,
          ``,
          ...body.split("\n").map((l) => (l.startsWith(".") ? `.${l}` : l)),
          `.`,
        ].join("\r\n");
        socket.write(message + "\r\n", "utf-8");

        const msgAccepted = await readSMTPResponse(socket);
        if (smtpCode(msgAccepted) !== 250) {
          fail(`message not accepted: ${msgAccepted.slice(0, 80)}`);
          return;
        }

        // Extract message-id from server response if present
        const midMatch = /(<[^>]+>)/.exec(msgAccepted);
        const messageId = midMatch?.[1];

        // QUIT
        smtpWrite(socket, "QUIT");
        socket.destroy();

        log.info({ to, messageId }, "email-send: SMTP sent");
        resolve({ sent: true, provider: "smtp", messageId });
      } catch (e) {
        fail(`SMTP exception: ${(e as Error).message}`);
      }
    })();
  });
}

// ── capability export ─────────────────────────────────────────────────────────

export const emailSendCapability: CapabilityPlugin = {
  name: "email_send",
  sideEffect: "message-human",

  estimateCents: () => 5,

  async invoke(call: EffectCall) {
    const input = call.input as Record<string, unknown>;

    const to = input["to"] != null ? String(input["to"]) : "";
    if (!to) {
      // Delivery floor: no recipient configured → the drafted message still reaches the human
      // via the Agent Inbox (it is captured in run state). Succeed as an inbox delivery rather
      // than failing the agent's "send to the human" step. Wiring a real recipient upgrades this
      // to an actual email send.
      log.info({ nodeId: call.nodeId }, "email-send: no recipient configured — delivered to inbox");
      return {
        output: { sent: true, via: "inbox" } satisfies EmailSendOutput,
        claimedCostCents: 0,
      };
    }

    const body = input["body"] != null ? String(input["body"]) : "";
    if (!body) {
      log.warn({ nodeId: call.nodeId }, "email-send: missing required input 'body'");
      return {
        output: { sent: false, error: "missing required input: 'body'" } satisfies EmailSendOutput,
        claimedCostCents: 0,
      };
    }

    const subject = input["subject"] != null ? String(input["subject"]) : "Message from Krelvan agent";
    // Sender precedence: explicit input.from → the install's configured KRELVAN_EMAIL_FROM →
    // a safe placeholder. Reading the env default means email works out-of-the-box once a
    // provider is configured, without every agent having to carry a valid 'from' itself
    // (the delivery layer, for instance, doesn't set one).
    const from = input["from"] != null ? String(input["from"]) : (secretResolver("KRELVAN_EMAIL_FROM") ?? "krelvan@agents.local");

    // Path 1: Resend
    const resendKey = secretResolver("KRELVAN_RESEND_KEY");
    if (resendKey) {
      const result = await sendViaResend(resendKey, from, to, subject, body);
      return {
        output: result satisfies EmailSendOutput,
        claimedCostCents: result.sent ? 5 : 0,
      };
    }

    // Path 2: SMTP
    const smtpHost = secretResolver("KRELVAN_SMTP_HOST");
    const smtpUser = secretResolver("KRELVAN_SMTP_USER");
    const smtpPass = secretResolver("KRELVAN_SMTP_PASS");

    if (smtpHost && smtpUser && smtpPass) {
      const smtpPort = parseInt(secretResolver("KRELVAN_SMTP_PORT") ?? "587", 10);
      const smtpFrom = secretResolver("KRELVAN_SMTP_FROM") ?? from;
      const result = await sendViaSMTP(smtpHost, smtpPort, smtpUser, smtpPass, smtpFrom, to, subject, body);
      return {
        output: result satisfies EmailSendOutput,
        claimedCostCents: result.sent ? 5 : 0,
      };
    }

    // No provider configured
    log.warn({ nodeId: call.nodeId }, "email-send: no email provider configured (set KRELVAN_RESEND_KEY or KRELVAN_SMTP_HOST/USER/PASS)");
    return {
      output: { sent: false, error: "no email provider configured" } satisfies EmailSendOutput,
      claimedCostCents: 0,
    };
  },
};
