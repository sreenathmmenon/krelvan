// Session cookie naming, shared by the proxy (sets it), middleware (reads it), and any
// route that clears it.
//
// Over HTTPS we use the __Host- prefix: the browser then GUARANTEES the cookie is Secure,
// has Path=/, and carries NO Domain attribute — so it cannot be set or overwritten by a
// subdomain or over plain HTTP. This is the strongest binding a session cookie can have.
// The prefix is only valid on Secure cookies, so over plain HTTP (local dev) we fall back
// to the plain name without the prefix.
//
// "Secure" is derived from the deployment being HTTPS: either KRELVAN_SECURE_COOKIES=1 is
// set explicitly, or the public web origin is an https:// URL. An HTTPS deploy therefore
// gets a Secure, __Host- cookie even if the operator forgets the env flag.

const SECURE_ENV = process.env["KRELVAN_SECURE_COOKIES"] === "1";
const ORIGIN_HTTPS = (process.env["KRELVAN_WEB_ORIGIN"] ?? "").startsWith("https://");

export const COOKIE_SECURE = SECURE_ENV || ORIGIN_HTTPS;
export const SESSION_COOKIE = COOKIE_SECURE ? "__Host-krelvan_sid" : "krelvan_sid";

// Both names, so a reader (middleware) still finds the session right after a scheme change
// or when run behind a proxy whose env differs slightly. Set uses SESSION_COOKIE only.
export const SESSION_COOKIE_NAMES = ["__Host-krelvan_sid", "krelvan_sid"] as const;

/** Read the session cookie value regardless of which prefix variant is present. */
export function readSessionCookie(get: (name: string) => string | undefined): string | undefined {
  for (const name of SESSION_COOKIE_NAMES) {
    const v = get(name);
    if (v) return v;
  }
  return undefined;
}
