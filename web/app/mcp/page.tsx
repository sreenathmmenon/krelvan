"use client";
import { useState, useEffect } from "react";
import {
  listMcpServers, connectMcpServer, disconnectMcpServer,
  type McpServerRecord, type McpServerConfig,
} from "../../lib/api";

const EXAMPLES: { label: string; config: Partial<McpServerConfig> }[] = [
  {
    label: "GitHub",
    config: {
      name: "github",
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-github"],
      env: { GITHUB_PERSONAL_ACCESS_TOKEN: "" },
    },
  },
  {
    label: "Filesystem",
    config: {
      name: "filesystem",
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"],
    },
  },
  {
    label: "Slack",
    config: {
      name: "slack",
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-slack"],
      env: { SLACK_BOT_TOKEN: "", SLACK_TEAM_ID: "" },
    },
  },
  {
    label: "HTTP server",
    config: {
      name: "my-mcp-server",
      url: "http://localhost:8080",
    },
  },
];

export default function McpPage() {
  const [servers, setServers] = useState<McpServerRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [showConnect, setShowConnect] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [connectError, setConnectError] = useState<string | null>(null);
  const [connectedTools, setConnectedTools] = useState<string[] | null>(null);

  // Form state
  const [name, setName] = useState("");
  const [transport, setTransport] = useState<"stdio" | "http">("stdio");
  const [command, setCommand] = useState("");
  const [args, setArgs] = useState("");
  const [url, setUrl] = useState("");
  const [envPairs, setEnvPairs] = useState("");
  const [estimateCents, setEstimateCents] = useState("5");

  async function reload() {
    try { setServers(await listMcpServers()); }
    catch { /* API might not be up yet */ }
    finally { setLoading(false); }
  }

  useEffect(() => { void reload(); }, []);

  function applyExample(ex: Partial<McpServerConfig>) {
    setName(ex.name ?? "");
    if (ex.url) {
      setTransport("http");
      setUrl(ex.url);
      setCommand("");
      setArgs("");
    } else {
      setTransport("stdio");
      setCommand(ex.command ?? "");
      setArgs((ex.args ?? []).join(" "));
      setUrl("");
    }
    if (ex.env) {
      setEnvPairs(Object.entries(ex.env).map(([k, v]) => `${k}=${v}`).join("\n"));
    } else {
      setEnvPairs("");
    }
  }

  async function connect(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;
    setConnecting(true);
    setConnectError(null);
    setConnectedTools(null);

    const env: Record<string, string> = {};
    for (const line of envPairs.split("\n")) {
      const eq = line.indexOf("=");
      if (eq > 0) {
        const k = line.slice(0, eq).trim();
        const v = line.slice(eq + 1).trim();
        if (k) env[k] = v;
      }
    }

    const config: McpServerConfig = {
      name: name.trim(),
      estimateCents: parseInt(estimateCents) || 5,
      ...(transport === "http"
        ? { url: url.trim() }
        : {
            command: command.trim(),
            args: args.trim() ? args.trim().split(/\s+/) : [],
            ...(Object.keys(env).length > 0 ? { env } : {}),
          }),
    };

    try {
      const result = await connectMcpServer(config);
      setConnectedTools(result.tools);
      await reload();
      setShowConnect(false);
      // Reset form
      setName(""); setCommand(""); setArgs(""); setUrl(""); setEnvPairs(""); setEstimateCents("5");
    } catch (err) {
      setConnectError((err as Error).message);
    } finally {
      setConnecting(false);
    }
  }

  async function disconnect(serverName: string) {
    try {
      await disconnectMcpServer(serverName);
      await reload();
    } catch (err) {
      alert((err as Error).message);
    }
  }

  return (
    <div className="container" style={{ paddingTop: "var(--s7)", paddingBottom: "var(--s9)" }}>

      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: "var(--s6)" }}>
        <div>
          <h1 className="h1" style={{ marginBottom: "var(--s2)" }}>MCP Servers</h1>
          <p className="soft" style={{ fontSize: 14, margin: 0 }}>
            Connect any MCP server — every tool it exposes becomes a capability your agents can use.
          </p>
        </div>
        <button className="btn btn-primary" onClick={() => { setShowConnect(!showConnect); setConnectError(null); setConnectedTools(null); }}>
          {showConnect ? "Cancel" : "+ Connect server"}
        </button>
      </div>

      {/* connect panel */}
      {showConnect && (
        <div className="card" style={{ padding: "var(--s5)", marginBottom: "var(--s6)" }}>
          <h2 className="h3" style={{ marginBottom: "var(--s3)" }}>Connect MCP Server</h2>

          {/* quick examples */}
          <div style={{ marginBottom: "var(--s4)" }}>
            <p className="micro" style={{ marginBottom: "var(--s2)" }}>Quick start:</p>
            <div style={{ display: "flex", gap: "var(--s2)", flexWrap: "wrap" }}>
              {EXAMPLES.map(ex => (
                <button
                  key={ex.label}
                  type="button"
                  onClick={() => applyExample(ex.config)}
                  style={{
                    fontSize: 12, padding: "3px 10px",
                    border: "1px solid var(--line)", borderRadius: "var(--r-pill)",
                    background: "var(--surface-sunken)", cursor: "pointer", color: "var(--ink-soft)",
                  }}
                >
                  {ex.label}
                </button>
              ))}
            </div>
          </div>

          <form onSubmit={connect}>
            {/* name */}
            <div style={{ marginBottom: "var(--s4)" }}>
              <label className="micro" style={{ display: "block", marginBottom: "var(--s2)" }}>Server name</label>
              <input
                value={name}
                onChange={e => setName(e.target.value)}
                placeholder="e.g. github, stripe, my-internal-api"
                style={{ width: "100%", padding: "var(--s2) var(--s3)", border: "1px solid var(--line)", borderRadius: "var(--r)", fontSize: 13, color: "var(--ink)", background: "var(--surface)" }}
              />
            </div>

            {/* transport toggle */}
            <div style={{ marginBottom: "var(--s4)", display: "flex", gap: "var(--s2)" }}>
              {(["stdio", "http"] as const).map(t => (
                <button
                  key={t}
                  type="button"
                  onClick={() => setTransport(t)}
                  style={{
                    padding: "var(--s2) var(--s4)", border: "1.5px solid",
                    borderColor: transport === t ? "var(--brand)" : "var(--line)",
                    borderRadius: "var(--r)", background: transport === t ? "var(--brand-tint)" : "none",
                    color: transport === t ? "var(--brand)" : "var(--ink-muted)",
                    fontSize: 13, fontWeight: 500, cursor: "pointer",
                  }}
                >
                  {t === "stdio" ? "Local process (stdio)" : "Remote HTTP server"}
                </button>
              ))}
            </div>

            {transport === "stdio" ? (
              <>
                <div style={{ marginBottom: "var(--s4)" }}>
                  <label className="micro" style={{ display: "block", marginBottom: "var(--s2)" }}>Command</label>
                  <input
                    value={command}
                    onChange={e => setCommand(e.target.value)}
                    placeholder="e.g. npx or /usr/local/bin/my-mcp-server"
                    style={{ width: "100%", padding: "var(--s2) var(--s3)", border: "1px solid var(--line)", borderRadius: "var(--r)", fontSize: 13, fontFamily: "var(--font-mono)", color: "var(--ink)", background: "var(--surface)" }}
                  />
                </div>
                <div style={{ marginBottom: "var(--s4)" }}>
                  <label className="micro" style={{ display: "block", marginBottom: "var(--s2)" }}>Arguments (space-separated)</label>
                  <input
                    value={args}
                    onChange={e => setArgs(e.target.value)}
                    placeholder="-y @modelcontextprotocol/server-github"
                    style={{ width: "100%", padding: "var(--s2) var(--s3)", border: "1px solid var(--line)", borderRadius: "var(--r)", fontSize: 13, fontFamily: "var(--font-mono)", color: "var(--ink)", background: "var(--surface)" }}
                  />
                </div>
                <div style={{ marginBottom: "var(--s4)" }}>
                  <label className="micro" style={{ display: "block", marginBottom: "var(--s2)" }}>Environment variables (KEY=VALUE, one per line)</label>
                  <textarea
                    value={envPairs}
                    onChange={e => setEnvPairs(e.target.value)}
                    placeholder={"GITHUB_PERSONAL_ACCESS_TOKEN=ghp_xxx\nANOTHER_KEY=value"}
                    rows={4}
                    style={{ width: "100%", padding: "var(--s3)", border: "1px solid var(--line)", borderRadius: "var(--r)", fontSize: 12, fontFamily: "var(--font-mono)", color: "var(--ink)", background: "var(--surface-sunken)", resize: "vertical" }}
                  />
                </div>
              </>
            ) : (
              <div style={{ marginBottom: "var(--s4)" }}>
                <label className="micro" style={{ display: "block", marginBottom: "var(--s2)" }}>Server URL</label>
                <input
                  value={url}
                  onChange={e => setUrl(e.target.value)}
                  placeholder="http://localhost:8080"
                  style={{ width: "100%", padding: "var(--s2) var(--s3)", border: "1px solid var(--line)", borderRadius: "var(--r)", fontSize: 13, fontFamily: "var(--font-mono)", color: "var(--ink)", background: "var(--surface)" }}
                />
              </div>
            )}

            <div style={{ marginBottom: "var(--s4)", maxWidth: 200 }}>
              <label className="micro" style={{ display: "block", marginBottom: "var(--s2)" }}>Cost estimate (¢ per call)</label>
              <input
                type="number"
                value={estimateCents}
                onChange={e => setEstimateCents(e.target.value)}
                min={0}
                style={{ width: "100%", padding: "var(--s2) var(--s3)", border: "1px solid var(--line)", borderRadius: "var(--r)", fontSize: 13, color: "var(--ink)", background: "var(--surface)" }}
              />
            </div>

            {connectError && (
              <div style={{ marginBottom: "var(--s4)", padding: "var(--s3) var(--s4)", background: "var(--danger-tint)", borderRadius: "var(--r)", fontSize: 13, color: "var(--danger)" }}>
                {connectError}
              </div>
            )}

            <div style={{ display: "flex", gap: "var(--s3)", justifyContent: "flex-end" }}>
              <button type="button" className="btn btn-ghost" onClick={() => setShowConnect(false)}>Cancel</button>
              <button type="submit" className="btn btn-primary" disabled={!name.trim() || connecting}>
                {connecting ? "Connecting…" : "Connect"}
              </button>
            </div>
          </form>
        </div>
      )}

      {/* success toast */}
      {connectedTools && (
        <div style={{ marginBottom: "var(--s5)", padding: "var(--s4)", background: "var(--ok-tint)", borderRadius: "var(--r)", border: "1px solid var(--ok)" }}>
          <p style={{ fontWeight: 600, color: "var(--ok)", marginBottom: "var(--s2)", fontSize: 13 }}>
            Connected — {connectedTools.length} tool{connectedTools.length !== 1 ? "s" : ""} available
          </p>
          <div style={{ display: "flex", flexWrap: "wrap", gap: "var(--s2)" }}>
            {connectedTools.map(t => (
              <span key={t} style={{ fontSize: 11, padding: "2px 8px", background: "white", borderRadius: "var(--r-pill)", border: "1px solid var(--ok)", fontFamily: "var(--font-mono)" }}>
                {t}
              </span>
            ))}
          </div>
        </div>
      )}

      {loading && <p className="soft small">Loading…</p>}

      {/* servers list */}
      {!loading && servers.length === 0 && !showConnect && (
        <div style={{ padding: "var(--s7)", textAlign: "center", border: "1.5px dashed var(--line-strong)", borderRadius: "var(--r)", color: "var(--ink-muted)" }}>
          <p style={{ fontSize: 14, marginBottom: "var(--s3)" }}>No MCP servers connected.</p>
          <p style={{ fontSize: 13 }}>
            Connect GitHub, Slack, Stripe, Notion, or any service with an MCP server.
            Every tool becomes a capability your agents can use instantly.
          </p>
        </div>
      )}

      {servers.length > 0 && (
        <div style={{ display: "flex", flexDirection: "column", gap: "var(--s4)" }}>
          {servers.map(server => (
            <div key={server.name} className="card" style={{ padding: "var(--s5)" }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: "var(--s4)" }}>
                <div style={{ display: "flex", alignItems: "center", gap: "var(--s3)" }}>
                  <div style={{
                    width: 10, height: 10, borderRadius: "50%",
                    background: server.connected ? "var(--ok)" : "var(--ink-muted)",
                    flexShrink: 0,
                  }} />
                  <div>
                    <div style={{ fontWeight: 600, fontSize: 14 }}>{server.name}</div>
                    <div className="small muted">{server.tools.length} tool{server.tools.length !== 1 ? "s" : ""}</div>
                  </div>
                </div>
                <button
                  onClick={() => void disconnect(server.name)}
                  style={{ fontSize: 12, padding: "3px 10px", border: "1px solid var(--line)", borderRadius: "var(--r)", background: "none", cursor: "pointer", color: "var(--danger)" }}
                >
                  Disconnect
                </button>
              </div>

              {server.tools.length > 0 && (
                <div style={{ display: "flex", flexWrap: "wrap", gap: "var(--s2)" }}>
                  {server.tools.map(t => (
                    <span key={t} style={{
                      fontSize: 11, padding: "2px 8px",
                      background: "var(--surface-sunken)",
                      borderRadius: "var(--r-pill)",
                      fontFamily: "var(--font-mono)",
                      color: "var(--brand)",
                      border: "1px solid var(--line)",
                    }}>
                      {t}
                    </span>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
