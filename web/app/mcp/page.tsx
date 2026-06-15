"use client";

// The standalone MCP page was merged into Capabilities → Connectors (a connector
// IS a capability source). This route now redirects there so old links keep working.
import { useEffect } from "react";

export default function McpRedirect() {
  useEffect(() => {
    window.location.replace("/capabilities#connectors");
  }, []);
  return (
    <div className="container" style={{ paddingTop: "var(--s9)", paddingBottom: "var(--s9)", textAlign: "center" }}>
      <p className="soft">Connectors now live in{" "}
        <a href="/capabilities#connectors" style={{ color: "var(--brand)", fontWeight: 600 }}>Capabilities</a>.
      </p>
    </div>
  );
}
