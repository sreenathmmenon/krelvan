// Same-origin API proxy.
//
// The browser calls /proxy/api/... (same origin — no CORS). This server-side route
// forwards to the real Krelvan API and injects the bearer token from a SERVER-ONLY
// env var (KRELVAN_AUTH_TOKEN — never NEXT_PUBLIC_, so it never reaches the browser).
// This keeps the token off the client entirely and removes the cross-origin surface.

import { type NextRequest } from "next/server";

const API_ORIGIN = process.env["KRELVAN_API_ORIGIN"] ?? "http://localhost:3201";
const AUTH_TOKEN = process.env["KRELVAN_AUTH_TOKEN"] ?? "";

export const dynamic = "force-dynamic";

async function forward(req: NextRequest, path: string[]): Promise<Response> {
  const search = req.nextUrl.search; // preserves ?query
  const target = `${API_ORIGIN}/${path.join("/")}${search}`;

  const headers = new Headers();
  // copy content-type / accept; drop hop-by-hop + host
  const ct = req.headers.get("content-type");
  if (ct) headers.set("content-type", ct);
  const accept = req.headers.get("accept");
  if (accept) headers.set("accept", accept);
  if (AUTH_TOKEN) headers.set("authorization", `Bearer ${AUTH_TOKEN}`);

  const method = req.method.toUpperCase();
  const body = method === "GET" || method === "HEAD" ? undefined : await req.arrayBuffer();

  const upstream = await fetch(target, {
    method,
    headers,
    body,
    // don't let fetch follow redirects across the proxy boundary
    redirect: "manual",
  }).catch((e) => {
    return new Response(JSON.stringify({ error: `proxy: cannot reach API (${(e as Error).message})` }), {
      status: 502,
      headers: { "content-type": "application/json" },
    });
  });

  // stream the upstream response back unchanged (incl. SSE)
  const respHeaders = new Headers(upstream.headers);
  respHeaders.delete("access-control-allow-origin"); // same-origin now; no CORS needed
  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: respHeaders,
  });
}

type Ctx = { params: Promise<{ path: string[] }> };

export async function GET(req: NextRequest, ctx: Ctx)    { return forward(req, (await ctx.params).path); }
export async function POST(req: NextRequest, ctx: Ctx)   { return forward(req, (await ctx.params).path); }
export async function PUT(req: NextRequest, ctx: Ctx)    { return forward(req, (await ctx.params).path); }
export async function PATCH(req: NextRequest, ctx: Ctx)  { return forward(req, (await ctx.params).path); }
export async function DELETE(req: NextRequest, ctx: Ctx) { return forward(req, (await ctx.params).path); }
