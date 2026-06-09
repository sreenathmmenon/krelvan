import type { Metadata } from "next";
import "./globals.css";
import NavClient from "./NavClient";

export const metadata: Metadata = {
  title: "Genesis — own your agents",
  description: "Describe an outcome. Get an agent you own.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <NavClient />
        <main>{children}</main>
      </body>
    </html>
  );
}
