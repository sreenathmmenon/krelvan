"use client";

import { Suspense, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { glyphFor } from "../../lib/glyphs";
import { loadRegistry, type CatalogEntry } from "../../lib/registry";

const REPOSITORY = "https://github.com/sreenathmmenon/krelvan";
const REGISTRY = "https://github.com/sreenathmmenon/krelvan-registry";

function MarketplaceContent() {
  const params = useSearchParams();
  const requested = params.get("entry");
  const [entries, setEntries] = useState<CatalogEntry[]>([]);
  const [query, setQuery] = useState("");
  const [error, setError] = useState(false);

  useEffect(() => {
    void loadRegistry()
      .then((registry) => setEntries(registry.entries))
      .catch(() => setError(true));
  }, []);

  const selected = requested
    ? entries.find((entry) => entry.name === requested) ?? null
    : null;
  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return entries;
    return entries.filter((entry) =>
      [entry.title, entry.name, entry.oneLiner, entry.category, entry.kind]
        .some((value) => value.toLowerCase().includes(needle)),
    );
  }, [entries, query]);

  return (
    <div>
      <section className="page-head">
        <div className="container">
          <p className="micro" style={{ marginBottom: "var(--s3)" }}>Public, read-only registry</p>
          <h1 className="display h1" style={{ maxWidth: "20ch", marginBottom: "var(--s3)" }}>
            Inspect what you can run on <span style={{ color: "var(--brand)" }}>your Krelvan.</span>
          </h1>
          <p className="body-lg soft" style={{ maxWidth: "64ch" }}>
            These entries come from the real Git registry. This website never installs or runs
            them against a shared account; installation happens inside your own Krelvan instance.
          </p>
        </div>
      </section>

      <section className="container" style={{ paddingTop: "var(--s6)", paddingBottom: "var(--s9)" }}>
        <div style={{ display: "flex", gap: "var(--s3)", flexWrap: "wrap", alignItems: "center", marginBottom: "var(--s5)" }}>
          <input
            className="input"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search agents and connectors"
            aria-label="Search registry"
            style={{ maxWidth: 420 }}
          />
          <a className="btn btn-secondary btn-sm" href={REGISTRY}>View registry source →</a>
        </div>

        {selected && (
          <article className="card" style={{ padding: "var(--s5)", marginBottom: "var(--s6)", borderColor: "var(--brand)" }}>
            <div style={{ display: "flex", alignItems: "flex-start", gap: "var(--s3)" }}>
              <span className="home-example__icon" aria-hidden="true">
                <svg viewBox="0 0 16 16" width={18} height={18} fill="none">
                  <path d={glyphFor(selected.name, selected.category, selected.kind)} stroke="currentColor" strokeWidth={1.3} strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </span>
              <div>
                <p className="micro" style={{ marginBottom: "var(--s2)" }}>{selected.kind} · {selected.category}</p>
                <h2 className="h2" style={{ marginBottom: "var(--s2)" }}>{selected.title}</h2>
                <p className="soft" style={{ maxWidth: "66ch", marginBottom: "var(--s4)" }}>{selected.oneLiner}</p>
                <div style={{ display: "flex", gap: "var(--s2)", flexWrap: "wrap" }}>
                  {selected.sourceUrl && <a className="btn btn-secondary btn-sm" href={selected.sourceUrl}>Inspect source →</a>}
                  <a className="btn btn-primary btn-sm" href={`${REPOSITORY}#run-it`}>Run on your machine →</a>
                </div>
              </div>
            </div>
          </article>
        )}

        {error && (
          <div className="empty-state">
            <h2 className="h3">Registry unavailable</h2>
            <p className="soft">The registry could not be loaded. You can inspect it directly on GitHub.</p>
            <a className="btn btn-secondary btn-sm" href={REGISTRY}>Open registry →</a>
          </div>
        )}

        {!error && entries.length === 0 && <p className="soft">Loading the registry…</p>}
        {entries.length > 0 && (
          <>
            <p className="small soft mono" style={{ marginBottom: "var(--s3)" }}>
              {visible.length} {visible.length === 1 ? "entry" : "entries"}
            </p>
            <div className="home-examples">
              {visible.map((entry) => (
                <Link key={entry.name} href={`/marketplace?entry=${encodeURIComponent(entry.name)}`} className="home-example card">
                  <span className="home-example__icon" aria-hidden="true">
                    <svg viewBox="0 0 16 16" width={18} height={18} fill="none">
                      <path d={glyphFor(entry.name, entry.category, entry.kind)} stroke="currentColor" strokeWidth={1.3} strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                  </span>
                  <div style={{ minWidth: 0 }}>
                    <div className="home-example__title">{entry.title}</div>
                    <div className="home-example__desc small soft">{entry.oneLiner}</div>
                    <div className="home-example__cta small">Inspect →</div>
                  </div>
                </Link>
              ))}
            </div>
          </>
        )}
      </section>
    </div>
  );
}

export default function MarketplacePage() {
  return (
    <Suspense fallback={<div className="container" style={{ paddingTop: "var(--s9)" }}><p className="soft">Loading the registry…</p></div>}>
      <MarketplaceContent />
    </Suspense>
  );
}
