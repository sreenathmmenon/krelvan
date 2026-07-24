import path from "node:path";

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
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
