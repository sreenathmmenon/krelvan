/**
 * UI-side view of ledger events — mirrors src/core/ledger/event.ts shapes (the UI
 * reads the same log the engine writes). Plus pure projections that fold events into
 * the canvas / cost / timeline views, exactly like the core's observability layer.
 *
 * The UI NEVER computes state independently — every view here is a fold of `events`.
 * That is the whole point: "what you see is exactly what executed".
 */

export type EventType =
  | "RunStarted"
  | "RunCompleted"
  | "RunFailed"
  | "NodeEntered"
  | "NodeConcluded"
  | "AdmissionDecision"
  | "EffectRequested"
  | "EffectResult"
  | "AwaitRequested"
  | "AwaitResolved";

export interface LedgerEvent {
  id: string; // sha256:…
  offset: number;
  type: EventType;
  nodeId?: string;
  author: string; // who signed it (owner / supervisor)
  ts: number;
  payload: Record<string, unknown>;
}

export interface RunMeta {
  runId: string;
  tenantId: string;
  manifestName: string;
  intent: string;
  status: "running" | "completed" | "failed" | "halted";
  budgetCents: number;
}

export type NodeStatus = "idle" | "running" | "done" | "failed";

export interface CanvasNode {
  id: string;
  status: NodeStatus;
  visits: number;
}

/** Fold events → per-node canvas state. */
export function projectCanvas(events: LedgerEvent[]): CanvasNode[] {
  const map = new Map<string, CanvasNode>();
  for (const e of events) {
    if (!e.nodeId) continue;
    const n = map.get(e.nodeId) ?? { id: e.nodeId, status: "idle" as NodeStatus, visits: 0 };
    if (e.type === "NodeEntered") {
      n.status = "running";
      n.visits += 1;
    } else if (e.type === "NodeConcluded") {
      n.status = "done";
    } else if (e.type === "RunFailed") {
      n.status = "failed";
    }
    map.set(e.nodeId, n);
  }
  return [...map.values()];
}

export interface CostView {
  spentCents: number;
  byEffect: { idem: string; capability: string; costCents: number; author: string }[];
}

/** Fold events → exact integer-cent cost (settled EffectResults). */
export function projectCost(events: LedgerEvent[]): CostView {
  let spent = 0;
  const byEffect: CostView["byEffect"] = [];
  for (const e of events) {
    if (e.type === "EffectResult") {
      const cost = Number(e.payload.costCents ?? 0);
      spent += cost;
      byEffect.push({
        idem: String(e.payload.idem ?? "?"),
        capability: String(e.payload.capability ?? e.payload.cap ?? "effect"),
        costCents: cost,
        author: e.author,
      });
    }
  }
  return { spentCents: spent, byEffect };
}

/** A human-readable line per event (the audit timeline). */
export interface TimelineEntry {
  offset: number;
  scope: string;
  type: EventType;
  author: string;
  detail: string;
  ts: number;
}

export function projectTimeline(events: LedgerEvent[]): TimelineEntry[] {
  return events.map((e) => ({
    offset: e.offset,
    scope: e.nodeId ?? "run",
    type: e.type,
    author: e.author,
    ts: e.ts,
    detail: detailFor(e),
  }));
}

function detailFor(e: LedgerEvent): string {
  switch (e.type) {
    case "RunStarted":
      return `manifest "${String(e.payload.manifest ?? "")}"`;
    case "AdmissionDecision":
      return e.payload.admitted
        ? `admitted ${String(e.payload.capability ?? "")} (reserve ${num(e.payload.reservedCents)}¢)`
        : `DENIED: ${String(e.payload.reason ?? "")}`;
    case "EffectRequested":
      return `${String(e.payload.capability ?? "")} — ${shortIdem(e.payload.idem)}`;
    case "EffectResult":
      return `${num(e.payload.costCents)}¢ · signed by ${e.author}`;
    case "AwaitRequested":
      return `parked for approval (${shortIdem(e.payload.correlationId)})`;
    case "NodeConcluded":
      return "concluded";
    default:
      return "";
  }
}

function num(v: unknown): number {
  return Number(v ?? 0);
}
function shortIdem(v: unknown): string {
  const s = String(v ?? "");
  return s.length > 24 ? s.slice(0, 21) + "…" : s;
}

export function statusPillClass(s: string): string {
  switch (s) {
    case "completed":
    case "done":
      return "pill-ok";
    case "running":
            return "pill-running";
    case "halted":
      return "pill-warn";
    case "failed":
      return "pill-danger";
    default:
      return "pill-neutral";
  }
}

export function fmtCents(c: number): string {
  return `${c}¢`;
}
