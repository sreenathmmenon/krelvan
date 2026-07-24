import path from "node:path";

const securityHeaders = [
  { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=(), usb=()" },
];

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
  // This is a two-package workspace by design (root runtime + web app). Make the tracing
  // boundary explicit so source and packed-customer builds resolve the same root.
  outputFileTracingRoot: path.resolve(import.meta.dirname, ".."),
  // The npm launcher builds this app from node_modules/krelvan/web on a
  // customer's machine. Next skips TypeScript transforms for node_modules by
  // default; explicitly transpile the owning package so the packaged launcher
  // follows the same build path as the source checkout.
  transpilePackages: ["krelvan"],
};
export default nextConfig;
