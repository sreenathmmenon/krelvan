import type { Metadata } from "next";
import { Inter, JetBrains_Mono, Space_Grotesk } from "next/font/google";
import "./globals.css";
import NavClient from "./NavClient";
import SiteFooter from "./SiteFooter";

// Self-hosted via next/font (no render-blocking @import, no FOUT/layout shift). A distinct
// DISPLAY family (Space Grotesk — geometric, characterful) gives the hero + wordmark a real
// typographic signature instead of Inter-everywhere.
const sans = Inter({ subsets: ["latin"], weight: ["300", "400", "500", "600", "700"], variable: "--font-sans-next", display: "swap" });
const mono = JetBrains_Mono({ subsets: ["latin"], weight: ["400", "500"], variable: "--font-mono-next", display: "swap" });
const display = Space_Grotesk({ subsets: ["latin"], weight: ["500", "600", "700"], variable: "--font-display-next", display: "swap" });

export const metadata: Metadata = {
  title: "Krelvan — own your agents",
  description: "Describe an outcome. Get an agent you own.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${sans.variable} ${mono.variable} ${display.variable}`}>
      <body>
        <a href="#main" className="skip-link">Skip to content</a>
        <NavClient />
        <main id="main" tabIndex={-1}>{children}</main>
        <SiteFooter />
      </body>
    </html>
  );
}
