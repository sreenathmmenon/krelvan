// Page guard: app pages require a session cookie. Unauthenticated page loads are redirected
// to /login (which itself bounces to /setup on a brand-new install). The proxy (/proxy/api/*)
// enforces its own session gate, so it's allowlisted here; static assets and the auth pages
// are public. The marketing homepage ("/") is also public — it is the public face of the
// product (a visitor must be able to read the pitch and download the sample proof without an
// account); its embedded live builder/agents/runs degrade gracefully when logged out because
// the data calls go through the self-gated proxy, which simply returns 401 (swallowed).
import { NextResponse, type NextRequest } from "next/server";
import { readSessionCookie } from "./lib/cookie";

const PUBLIC_PATHS = new Set(["/", "/login", "/setup", "/faq"]);

export function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;

  // Allowlist: the proxy (self-gated), the auth pages, Next internals, static files.
  if (
    pathname.startsWith("/proxy") ||
    pathname.startsWith("/_next") ||
    pathname.startsWith("/favicon") ||
    pathname.includes(".") || // static assets (.css/.js/.svg/.png …)
    PUBLIC_PATHS.has(pathname)
  ) {
    return NextResponse.next();
  }

  if (!readSessionCookie((n) => req.cookies.get(n)?.value)) {
    const url = req.nextUrl.clone();
    url.pathname = "/login";
    url.search = ""; // don't leak the original query into the login URL
    return NextResponse.redirect(url);
  }
  return NextResponse.next();
}

export const config = {
  // Run on everything except Next internals (handled in the body too, belt-and-braces).
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
