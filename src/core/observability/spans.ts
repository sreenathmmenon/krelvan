/**
 * Structured spans for Krelvan runs — a lightweight OTEL-compatible trace model.
 *
 * Rather than requiring a full OTEL SDK dependency, we define a minimal span
 * interface and emit structured JSON-serializable records. A real production
 * deployment wires an OTELSpanExporter adapter behind SpanSink; the default
 * sink writes to the structured logger.
 *
 * Spans model:
 *   run     — covers engine.run() start to finish
 *   node    — covers a single node's body execution (enter → conclude)
 *   effect  — covers one supervisor.run() call (request → result)
 *   fold    — covers a single fold() call (for hot-path profiling)
 *
 * Each span has:
 *   traceId     — the run id (so all spans for a run correlate)
 *   spanId      — monotone id within the trace
 *   parentId    — nested span hierarchy
 *   startMs     — wall-clock start (Date.now())
 *   durationMs  — filled in at end()
 *   status      — "ok" | "error"
 *   attributes  — typed key/value pairs
 */

import { getLogger } from "./logger.js";

const log = getLogger("spans");

// ── Types ─────────────────────────────────────────────────────────────────────

export type SpanStatus = "ok" | "error";

export interface SpanRecord {
  traceId: string;
  spanId: string;
  parentId: string | null;
  name: string;
  startMs: number;
  durationMs: number;
  status: SpanStatus;
  attributes: Record<string, string | number | boolean | null>;
}

/** Sink receives completed span records. Default: log them. Override for OTEL export. */
export interface SpanSink {
  emit(span: SpanRecord): void;
}

const defaultSink: SpanSink = {
  emit(span) {
    log.info({ span }, `span:${span.name} ${span.durationMs}ms ${span.status}`);
  },
};

// ── Active span handle ────────────────────────────────────────────────────────

export class ActiveSpan {
  /** Public so Tracer can read spanId for nesting without unsafe casts. */
  readonly spanId: string;
  private readonly startMs: number;
  private readonly attrs: Record<string, string | number | boolean | null>;
  private ended = false;

  constructor(
    private readonly meta: Omit<SpanRecord, "durationMs" | "status" | "attributes">,
    private readonly sink: SpanSink,
    attrs: Record<string, string | number | boolean | null> = {},
  ) {
    this.spanId = meta.spanId;
    this.startMs = meta.startMs;
    this.attrs = { ...attrs };
  }

  /** Add or update attributes before ending. */
  set(attrs: Record<string, string | number | boolean | null>): this {
    Object.assign(this.attrs, attrs);
    return this;
  }

  end(attrs?: Record<string, string | number | boolean | null>, status: SpanStatus = "ok"): void {
    if (this.ended) return;
    this.ended = true;
    if (attrs) Object.assign(this.attrs, attrs);
    this.sink.emit({ ...this.meta, attributes: { ...this.attrs }, durationMs: Date.now() - this.startMs, status });
  }

  endError(err: Error, attrs?: Record<string, string | number | boolean | null>): void {
    this.end({ ...attrs, error: err.message }, "error");
  }
}

// ── Tracer ────────────────────────────────────────────────────────────────────

let spanCounter = 0;

function nextSpanId(): string {
  return `s${(++spanCounter).toString(36).padStart(4, "0")}`;
}

export class Tracer {
  // rootSpanId is assigned in the constructor from the traceId so that
  // startNode/startEffect/startFold work correctly even before startRun() is
  // called (e.g. in resume paths or tests that skip the run span).
  private rootSpanId: string;
  /** Set to the active node's spanId when inside a node body; null otherwise. */
  private currentNodeSpanId: string | null = null;

  constructor(
    private readonly traceId: string,
    private readonly sink: SpanSink = defaultSink,
  ) {
    // Use traceId as the root span ID so children are always parented correctly.
    // startRun() overwrites this with the actual run span's generated ID.
    this.rootSpanId = `root:${traceId}`;
  }

  private start(name: string, parentId: string | null, attrs: Record<string, string | number | boolean | null> = {}): ActiveSpan {
    const spanId = nextSpanId();
    return new ActiveSpan({ traceId: this.traceId, spanId, parentId, name, startMs: Date.now() }, this.sink, attrs);
  }

  /** Top-level span: one per engine.run() call. */
  startRun(manifestName: string): ActiveSpan {
    const span = this.start("run", null, { manifest: manifestName });
    this.rootSpanId = span.spanId;
    return span;
  }

  /** Span for a single node's execution (enter → conclude). Call endNode() when done. */
  startNode(nodeId: string): ActiveSpan {
    const span = this.start(`node:${nodeId}`, this.rootSpanId, { nodeId });
    this.currentNodeSpanId = span.spanId;
    return span;
  }

  /** Clear the current node context. Must be called after the node span ends. */
  endNode(): void {
    this.currentNodeSpanId = null;
  }

  /**
   * Span for a single capability effect (request → result).
   * Parents to the active node span when inside a node body, else to the run span.
   * estimateCents is preserved as null when genuinely unknown (not coerced to 0).
   */
  startEffect(nodeId: string, capability: string, estimateCents: number | null): ActiveSpan {
    const attrs: Record<string, string | number | boolean | null> = {
      nodeId,
      capability,
      estimateCents,
    };
    return this.start(`effect:${capability}`, this.currentNodeSpanId ?? this.rootSpanId, attrs);
  }

  /** Span for one fold() call — useful for profiling I/O overhead. */
  startFold(): ActiveSpan {
    return this.start("fold", this.rootSpanId);
  }
}

// ── No-op tracer for tests / disabled observability ───────────────────────────
// NoopTracer does NOT share a singleton span — each call creates a fresh
// (but truly no-op) ActiveSpan so the `ended` flag never bleeds between calls.

const NOOP_SINK: SpanSink = { emit: () => {} };

function noopSpan(): ActiveSpan {
  return new ActiveSpan(
    { traceId: "", spanId: "", parentId: null, name: "", startMs: 0 },
    NOOP_SINK,
  );
}

export class NoopTracer extends Tracer {
  constructor() { super("", NOOP_SINK); }
  override startRun(_: string): ActiveSpan { return noopSpan(); }
  override startNode(_: string): ActiveSpan { return noopSpan(); }
  override endNode(): void {}
  override startEffect(_n: string, _c: string, _e: number | null): ActiveSpan { return noopSpan(); }
  override startFold(): ActiveSpan { return noopSpan(); }
}
