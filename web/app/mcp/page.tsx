"use client";
import { useState, useEffect } from "react";
import {
  listMcpServers, connectMcpServer, disconnectMcpServer,
  type McpServerRecord, type McpServerConfig,
} from "../../lib/api";

// Preset MCP servers — one click fills the connect form. Power-user page, but the
// common cases (GitHub, Slack, …) shouldn't require remembering the npx incantation.
const EXAMPLES: { label: string; hint: string; config: Partial<McpServerConfig> }[] = [
  {
    label: "GitHub",
    hint: "issues · PRs · repos",
    config: {
      name: "github",
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-github"],
      env: { GITHUB_PERSONAL_ACCESS_TOKEN: "" },
    },
  },
  {
    label: "Filesystem",
    hint: "read · write local files",
    config: {
      name: "filesystem",
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"],
    },
  },
  {
    label: "Slack",
    hint: "channels · messages",
    config: {
      name: "slack",
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-slack"],
      env: { SLACK_BOT_TOKEN: "", SLACK_TEAM_ID: "" },
    },
  },
  {
    label: "HTTP server",
    hint: "any remote endpoint",
    config: {
      name: "my-mcp-server",
      url: "http://localhost:8080",
    },
  },
];

// One row per server in the connected list. Status, transport, and tool chips are
// all rendered with care — these are the capabilities an agent can reach for, so the
// page should read as "here is exactly what your agents can now do".
function ServerCard({ server, onDisconnect }: {
  server: McpServerRecord;
  onDisconnect: (name: string) => Promise<void>;
}) {
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Transport is inferred from the record shape on the wire isn't exposed, so we read
  // it off connection health: a connected server with tools is reachable; otherwise
  // it errored on connect. (No new data path — derived from the record we already have.)
  const ok = server.connected;
  const toolCount = server.tools.length;

  async function disconnect() {
    setBusy(true); setError(null);
    try { await onDisconnect(server.name); }
    catch (e) { setError((e as Error).message); setBusy(false); setConfirm(false); }
  }

  return (
    <div className="card card-hover" style={{ padding: "var(--s5)", display: "flex", flexDirection: "column", gap: "var(--s4)" }}>
      {/* header — name + status (left), actions (right) */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: "var(--s3)" }}>
        <div style={{ display: "flex", alignItems: "center", gap: "var(--s3)", minWidth: 0 }}>
          <span
            className={`status-dot ${ok ? "done" : "failed"}`}
            style={{ marginTop: 5, flexShrink: 0 }}
            aria-hidden="true"
          />
          <div style={{ minWidth: 0 }}>
            <div className="h3 mono text-truncate" style={{ color: "var(--ink)" }}>{server.name}</div>
            <div className="small muted">
              <span className="mono">{toolCount}</span> tool{toolCount !== 1 ? "s" : ""} available
            </div>
          </div>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: "var(--s2)", flexShrink: 0 }}>
          <span className={`badge ${ok ? "badge-done" : "badge-failed"}`}>
            {ok ? "connected" : "error"}
          </span>
        </div>
      </div>

      {/* tools — the actual capabilities this server exposes, as chips */}
      {toolCount > 0 ? (
        <div>
          <p className="micro" style={{ marginBottom: "var(--s2)" }}>Capabilities</p>
          <div style={{ display: "flex", flexWrap: "wrap", gap: "var(--s2)" }}>
            {server.tools.map(t => (
              <span key={t} className="badge badge-neutral mono">{t}</span>
            ))}
          </div>
        </div>
      ) : (
        <p className="small" style={{ color: "var(--ink-muted)", margin: 0 }}>
          {ok ? "Connected, but this server exposes no tools." : "Could not reach this server — check its command, URL, or credentials."}
        </p>
      )}

      {error && (
        <div className="state-error" style={{ padding: "var(--s2) var(--s3)" }}>{error}</div>
      )}

      {/* footer — disconnect with inline confirm */}
      <div style={{ display: "flex", justifyContent: "flex-end", alignItems: "center", marginTop: "auto", paddingTop: "var(--s3)", borderTop: "1px solid var(--line)", gap: "var(--s2)" }}>
        {!confirm ? (
          <button className="btn btn-danger btn-sm" onClick={() => setConfirm(true)}>Disconnect</button>
        ) : (
          <>
            <span className="small" style={{ color: "var(--danger)", fontWeight: 500, marginRight: "var(--s1)" }}>
              Disconnect <span className="mono">{server.name}</span>?
            </span>
            <button className="btn btn-secondary btn-sm" disabled={busy} onClick={() => setConfirm(false)}>Cancel</button>
            <button className="btn btn-danger btn-sm" disabled={busy} onClick={() => void disconnect()}>
              {busy ? "Disconnecting…" : "Yes, disconnect"}
            </button>
          </>
        )}
      </div>
    </div>
  );
}

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
    await disconnectMcpServer(serverName);
    await reload();
  }

  const connectedCount = servers.filter(s => s.connected).length;
  const totalTools = servers.reduce((n, s) => n + s.tools.length, 0);
  const isEmpty = servers.length === 0;

  return (
    <div className="container" style={{ paddingTop: "var(--s7)", paddingBottom: "var(--s9)" }}>

      {/* ── page header ─────────────────────────────────────────────────────── */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: "var(--s4)", marginBottom: "var(--s6)", flexWrap: "wrap" }}>
        <div style={{ minWidth: 0 }}>
          <p className="micro" style={{ marginBottom: "var(--s3)" }}>Connected tools</p>
          <h1 className="h1" style={{ marginBottom: "var(--s2)" }}>Tool servers</h1>
          <p className="body-lg soft" style={{ margin: 0, maxWidth: "56ch" }}>
            Connect any MCP server — GitHub, Slack, your own API. Every tool it exposes
            becomes a capability your agents can use, with the same approval gates and audit trail.
          </p>
        </div>
        <button
          className="btn btn-primary"
          onClick={() => { setShowConnect(!showConnect); setConnectError(null); setConnectedTools(null); }}
        >
          {showConnect ? "Cancel" : "+ Connect server"}
        </button>
      </div>

      {/* ── summary strip ───────────────────────────────────────────────────── */}
      {!loading && !isEmpty && (
        <div className="stat-strip" style={{ marginBottom: "var(--s7)" }}>
          {[
            { label: "servers",        value: String(servers.length) },
            { label: "connected",      value: String(connectedCount) },
            { label: "tools exposed",  value: String(totalTools) },
          ].map(s => (
            <div key={s.label} className="stat-cell">
              <span className="stat-value">{s.value}</span>
              <span className="stat-label">{s.label}</span>
            </div>
          ))}
        </div>
      )}

      {/* ── connect panel ───────────────────────────────────────────────────── */}
      {showConnect && (
        <div className="card" style={{ padding: "var(--s5)", marginBottom: "var(--s7)", maxWidth: 620 }}>
          <h2 className="h3" style={{ marginBottom: "var(--s1)" }}>Connect a tool server</h2>
          <p className="small soft" style={{ margin: "0 0 var(--s4)", lineHeight: 1.6 }}>
            Krelvan starts the server, reads the tools it exposes, and registers each as a
            capability. Pick a preset to fill the form, or configure your own.
          </p>

          {/* quick presets */}
          <div style={{ marginBottom: "var(--s5)" }}>
            <p className="micro" style={{ marginBottom: "var(--s2)" }}>Quick start</p>
            <div style={{ display: "flex", gap: "var(--s2)", flexWrap: "wrap" }}>
              {EXAMPLES.map(ex => (
                <button
                  key={ex.label}
                  type="button"
                  className="chip"
                  onClick={() => applyExample(ex.config)}
                  title={ex.hint}
                >
                  {ex.label}
                </button>
              ))}
            </div>
          </div>

          <form onSubmit={(e) => void connect(e)}>
            <div style={{ display: "flex", flexDirection: "column", gap: "var(--s4)" }}>
              {/* name */}
              <div>
                <label className="label">Server name<span className="req">*</span></label>
                <input
                  className="input"
                  value={name}
                  onChange={e => setName(e.target.value)}
                  placeholder="e.g. github, stripe, my-internal-api"
                />
              </div>

              {/* transport toggle */}
              <div>
                <label className="label">Transport</label>
                <div className="segmented">
                  {(["stdio", "http"] as const).map(t => (
                    <button
                      key={t}
                      type="button"
                      aria-pressed={transport === t}
                      onClick={() => setTransport(t)}
                    >
                      {t === "stdio" ? "Local process" : "Remote HTTP"}
                    </button>
                  ))}
                </div>
                <p className="small" style={{ color: "var(--ink-muted)", marginTop: "var(--s2)", lineHeight: 1.5 }}>
                  {transport === "stdio"
                    ? "Krelvan launches the server as a local process and talks to it over stdio."
                    : "Krelvan connects to an MCP server already running at a URL."}
                </p>
              </div>

              {transport === "stdio" ? (
                <>
                  <div>
                    <label className="label">Command</label>
                    <input
                      className="input input-mono"
                      value={command}
                      onChange={e => setCommand(e.target.value)}
                      placeholder="npx"
                    />
                  </div>
                  <div>
                    <label className="label">Arguments</label>
                    <input
                      className="input input-mono"
                      value={args}
                      onChange={e => setArgs(e.target.value)}
                      placeholder="-y @modelcontextprotocol/server-github"
                    />
                    <p className="small" style={{ color: "var(--ink-muted)", marginTop: "var(--s2)" }}>Space-separated.</p>
                  </div>
                  <div>
                    <label className="label">Environment variables</label>
                    <textarea
                      className="input input-mono"
                      value={envPairs}
                      onChange={e => setEnvPairs(e.target.value)}
                      placeholder={"GITHUB_PERSONAL_ACCESS_TOKEN=ghp_xxx\nANOTHER_KEY=value"}
                      rows={4}
                    />
                    <p className="small" style={{ color: "var(--ink-muted)", marginTop: "var(--s2)" }}>
                      One <span className="mono">KEY=VALUE</span> per line. Stays on your machine.
                    </p>
                  </div>
                </>
              ) : (
                <div>
                  <label className="label">Server URL</label>
                  <input
                    className="input input-mono"
                    value={url}
                    onChange={e => setUrl(e.target.value)}
                    placeholder="http://localhost:8080"
                  />
                </div>
              )}


              {connectError && (
                <div className="state-error">{connectError}</div>
              )}

              <div style={{ display: "flex", gap: "var(--s3)", justifyContent: "flex-end", paddingTop: "var(--s2)", borderTop: "1px solid var(--line)" }}>
                <button type="button" className="btn btn-ghost" onClick={() => setShowConnect(false)}>Cancel</button>
                <button type="submit" className="btn btn-primary" disabled={!name.trim() || connecting}>
                  {connecting ? "Connecting…" : "Connect server"}
                </button>
              </div>
            </div>
          </form>
        </div>
      )}

      {/* ── success banner — tools now available ────────────────────────────── */}
      {connectedTools && (
        <div
          role="status"
          className="card"
          style={{
            marginBottom: "var(--s7)", padding: "var(--s5)",
            background: "var(--brand-tint)", borderColor: "var(--brand-ring)",
            display: "flex", flexDirection: "column", gap: "var(--s3)",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: "var(--s2)" }}>
            <span
              aria-hidden="true"
              style={{
                display: "inline-flex", alignItems: "center", justifyContent: "center",
                width: 22, height: 22, borderRadius: "var(--r-pill)",
                background: "var(--brand)", color: "var(--brand-ink)", fontSize: 13, fontWeight: 700, flexShrink: 0,
              }}
            >✓</span>
            <span className="h3" style={{ color: "var(--brand)" }}>
              Connected — <span className="mono">{connectedTools.length}</span> tool{connectedTools.length !== 1 ? "s" : ""} now available
            </span>
          </div>
          {connectedTools.length > 0 && (
            <div style={{ display: "flex", flexWrap: "wrap", gap: "var(--s2)" }}>
              {connectedTools.map(t => (
                <span key={t} className="badge badge-done mono">{t}</span>
              ))}
            </div>
          )}
        </div>
      )}

      {/* ── loading ─────────────────────────────────────────────────────────── */}
      {loading && (
        <div className="state-loading">
          <span className="spinner" aria-hidden="true" />
          <span>Loading tool servers…</span>
        </div>
      )}

      {/* ── empty ───────────────────────────────────────────────────────────── */}
      {!loading && isEmpty && !showConnect && (
        <div className="state-empty" style={{ padding: "var(--s9) var(--s6)" }}>
          <div aria-hidden="true" style={{ fontSize: 32, marginBottom: "var(--s4)", opacity: 0.5 }}>⇄</div>
          <p className="h3" style={{ marginBottom: "var(--s2)", color: "var(--ink)" }}>No tool servers connected</p>
          <p className="body-lg soft" style={{ maxWidth: "44ch", margin: "0 auto var(--s5)" }}>
            Connect GitHub, Slack, a filesystem, or any service with an MCP server. Every
            tool it exposes becomes a capability your agents can use instantly.
          </p>
          <button className="btn btn-primary" onClick={() => { setShowConnect(true); setConnectError(null); setConnectedTools(null); }}>
            Connect your first server
          </button>
          <div style={{ display: "flex", gap: "var(--s2)", flexWrap: "wrap", justifyContent: "center", marginTop: "var(--s6)" }}>
            {EXAMPLES.map(ex => (
              <button
                key={ex.label}
                type="button"
                className="chip"
                onClick={() => { setShowConnect(true); setConnectError(null); setConnectedTools(null); applyExample(ex.config); }}
                title={ex.hint}
              >
                {ex.label}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* ── connected servers ───────────────────────────────────────────────── */}
      {!loading && !isEmpty && (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(320px, 1fr))", gap: "var(--s5)" }}>
          {servers.map(server => (
            <ServerCard key={server.name} server={server} onDisconnect={disconnect} />
          ))}
        </div>
      )}
    </div>
  );
}
