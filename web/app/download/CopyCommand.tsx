"use client";

import { useState } from "react";

export function CopyCommand({ command }: { command: string }) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");

  async function copy() {
    try {
      await navigator.clipboard.writeText(command);
      setState("copied");
      window.setTimeout(() => setState("idle"), 1800);
    } catch {
      setState("failed");
    }
  }

  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "minmax(0, 1fr) auto",
        alignItems: "stretch",
        borderRadius: "var(--radius)",
        overflow: "hidden",
        background: "var(--ink)",
      }}
    >
      <pre
        className="mono"
        style={{
          margin: 0,
          padding: "var(--s4)",
          overflowX: "auto",
          color: "var(--canvas)",
          fontSize: 13,
          lineHeight: 1.6,
          whiteSpace: "pre-wrap",
          overflowWrap: "anywhere",
          wordBreak: "break-word",
        }}
      >
        <code>{command}</code>
      </pre>
      <button
        type="button"
        onClick={() => void copy()}
        aria-label="Copy command"
        className="btn btn-sm"
        style={{
          alignSelf: "center",
          marginRight: "var(--s3)",
          background: "var(--surface)",
          color: "var(--ink)",
          borderColor: "transparent",
        }}
      >
        {state === "copied" ? "Copied" : state === "failed" ? "Select text" : "Copy"}
      </button>
    </div>
  );
}
