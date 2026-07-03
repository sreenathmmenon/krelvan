/**
 * safe-fetch — SSRF-safe HTTP for the agent-invokable builtin plugins
 * (http_get, http_post, notify_webhook).
 *
 * The problem this closes: `assertPublicUrl(url)` resolves DNS and blocks private /
 * link-local / cloud-metadata IPs for the INITIAL url — but `fetch`'s default
 * `redirect: "follow"` then re-resolves and follows 3xx redirects ITSELF, unchecked. A
 * public host that 302-redirects to `http://169.254.169.254/…` would sail straight past
 * the one-time guard and leak cloud credentials in the response body. This is the exact
 * SSRF-via-redirect class the EgressBroker already defends on the credential path; this
 * helper brings the same discipline to the three builtin plugins that call fetch directly.
 *
 * Every hop (including the first) is re-vetted with `assertPublicUrl`, redirects are
 * followed MANUALLY (never `redirect: "follow"`), the hop count is bounded, and on a
 * cross-host redirect any Authorization/Cookie header is dropped so a secret minted for
 * host A never travels to host B.
 */
import { assertPublicUrl } from "./ssrf-guard.js";

const MAX_REDIRECTS = 5;

export interface SafeFetchInit {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  signal?: AbortSignal;
  /** Injected for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
}

/**
 * Fetch `rawUrl` with SSRF protection across redirects. Resolves to the final Response.
 * Throws (with a descriptive message) if any hop targets a private/metadata address, an
 * off-limits redirect is attempted, or the redirect budget is exceeded. Callers should
 * treat a throw as a soft `{ ok: false, error }` result (as the plugins already do).
 */
export async function safeFetch(rawUrl: string, init: SafeFetchInit = {}): Promise<Response> {
  const doFetch = init.fetchImpl ?? fetch;
  const method = (init.method ?? "GET").toUpperCase();

  let currentUrl = rawUrl;
  let currentHost = hostOf(currentUrl);
  let hopHeaders: Record<string, string> = { ...(init.headers ?? {}) };
  let hops = 0;

  for (;;) {
    // Re-vet EVERY hop (the first url included) — re-resolves DNS and blocks private/metadata.
    await assertPublicUrl(currentUrl);

    const resp = await doFetch(currentUrl, {
      method,
      headers: hopHeaders,
      redirect: "manual", // never auto-follow; we vet each hop ourselves
      ...(init.body !== undefined && method !== "GET" && method !== "HEAD" ? { body: init.body } : {}),
      ...(init.signal ? { signal: init.signal } : {}),
    });

    // Not a redirect → final response.
    if (resp.status < 300 || resp.status >= 400) return resp;
    const location = resp.headers.get("location");
    if (!location) return resp; // 3xx with no Location — treat as final

    if (++hops > MAX_REDIRECTS) {
      throw new Error(`too many redirects (>${MAX_REDIRECTS})`);
    }

    let next: URL;
    try { next = new URL(location, currentUrl); } catch { throw new Error("invalid redirect target"); }
    const nextHost = next.hostname.replace(/^\[|\]$/g, "").toLowerCase();

    // Cross-host redirect → drop Authorization/Cookie so a per-host secret can't leak.
    if (nextHost !== currentHost) {
      const stripped: Record<string, string> = {};
      for (const [k, v] of Object.entries(hopHeaders)) {
        const lk = k.toLowerCase();
        if (lk === "authorization" || lk === "cookie") continue;
        stripped[k] = v;
      }
      hopHeaders = stripped;
    }
    currentUrl = next.toString();
    currentHost = nextHost;
  }
}

function hostOf(u: string): string {
  try { return new URL(u).hostname.replace(/^\[|\]$/g, "").toLowerCase(); } catch { return ""; }
}
