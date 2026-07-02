// Shared edge-geometry helpers for the three graph render sites: the agent detail
// page, the MiniGraph/FullMiniGraph previews (_builder.tsx), and the canvas.
//
// All three use the same layered ("Sugiyama-lite") layout: a node's x is
// column * (nodeW + gap), so column order is monotone in x. Two edge families:
//
//   FORWARD edge  — target in a later column. Drawn as the classic cubic that
//                   exits the source's right-center and enters the target's
//                   left-center.
//   BACK edge     — target column <= source column (an evaluator-optimizer loop,
//                   e.g. judge -> answer when verdict == "revise"). Drawn as a
//                   deliberate arc through a clear horizontal "lane" above or
//                   below the node rows, entering the target through its top or
//                   bottom edge so the arrowhead lands flat and the retry loop
//                   reads as a loop instead of a mangled backwards curve.
//
// Lane choice per back-edge: prefer the lane ABOVE the rows when both endpoints
// are the topmost node of their column (their vertical exits are clear), else
// BELOW when both are bottom-most. When one endpoint's vertical is blocked by a
// neighbour in the same column, that endpoint exits/enters sideways through the
// (always empty) column gap instead of punching through the neighbour.

import type { ManifestExpr } from "./api";

export interface Box { x: number; y: number; w: number; h: number; }

export interface EdgeGeom {
  /** SVG path data */
  d: string;
  /** true when this edge points at the same or an earlier column */
  back: boolean;
  /** where a back-edge's lane runs; "forward" / "right" edges have no lane */
  side: "forward" | "above" | "below" | "right";
  /** start point of the path (source anchor) — condition dots render here */
  sx: number; sy: number;
  /** approximate midpoint of the curve — label anchor */
  midX: number; midY: number;
  /** lane y for back-edges routed above/below; callers extend bounds to include it */
  laneY: number | null;
}

/** True when the edge points at the same or an earlier column (a loop/retry edge). */
export function isBackEdge(from: Box, to: Box): boolean {
  return to.x <= from.x;
}

function cubic(p0: [number, number], c1: [number, number], c2: [number, number], p1: [number, number]) {
  return {
    d: `M ${p0[0]} ${p0[1]} C ${c1[0]} ${c1[1]}, ${c2[0]} ${c2[1]}, ${p1[0]} ${p1[1]}`,
    // de Casteljau at t = 0.5 — good enough as a label anchor
    midX: (p0[0] + 3 * c1[0] + 3 * c2[0] + p1[0]) / 8,
    midY: (p0[1] + 3 * c1[1] + 3 * c2[1] + p1[1]) / 8,
  };
}

/**
 * Compute the render geometry for one edge. `all` is every node box in the graph
 * (used to find clear lanes for back-edges); `clearance` is how far the loop lane
 * sits beyond the outermost row, in graph units.
 */
export function edgeGeometry(from: Box, to: Box, all: readonly Box[], clearance = 28): EdgeGeom {
  if (!isBackEdge(from, to)) {
    const sx = from.x + from.w, sy = from.y + from.h / 2;
    const tx = to.x, ty = to.y + to.h / 2;
    const cx = (sx + tx) / 2;
    const { d, midX, midY } = cubic([sx, sy], [cx, sy], [cx, ty], [tx, ty]);
    return { d, back: false, side: "forward", sx, sy, midX, midY, laneY: null };
  }

  // Same-column edge: a short arc bulging out to the right of the column.
  if (from.x === to.x) {
    const sx = from.x + from.w, sy = from.y + from.h / 2;
    const tx = to.x + to.w, ty = to.y + to.h / 2;
    const bulge = sx + clearance;
    const { d, midX, midY } = cubic([sx, sy], [bulge, sy], [bulge, ty], [tx, ty]);
    return { d, back: true, side: "right", sx, sy, midX, midY, laneY: null };
  }

  // Column clearance: is anything stacked above/below each endpoint in its column?
  let minTop = Infinity, maxBottom = -Infinity;
  let fromClearAbove = true, fromClearBelow = true, toClearAbove = true, toClearBelow = true;
  for (const b of all) {
    minTop = Math.min(minTop, b.y);
    maxBottom = Math.max(maxBottom, b.y + b.h);
    if (b.x === from.x) {
      if (b.y < from.y) fromClearAbove = false;
      if (b.y > from.y) fromClearBelow = false;
    }
    if (b.x === to.x) {
      if (b.y < to.y) toClearAbove = false;
      if (b.y > to.y) toClearBelow = false;
    }
  }

  const above: boolean =
    (fromClearAbove && toClearAbove) ? true :
    (fromClearBelow && toClearBelow) ? false :
    // Mixed: pick the lane the TARGET can be entered through cleanly; the source
    // will exit sideways through the column gap if its own vertical is blocked.
    toClearBelow ? false : toClearAbove ? true : false;

  const laneY = above ? minTop - clearance : maxBottom + clearance;

  const srcClear = above ? fromClearAbove : fromClearBelow;
  const tgtClear = above ? toClearAbove : toClearBelow;

  // Source anchor: top/bottom center when clear, else right edge (into the gap).
  const sx = srcClear ? from.x + from.w / 2 : from.x + from.w;
  const sy = srcClear ? (above ? from.y : from.y + from.h) : from.y + from.h / 2;
  // Target anchor: top/bottom center when clear, else left edge (from the gap).
  const tx = tgtClear ? to.x + to.w / 2 : to.x;
  const ty = tgtClear ? (above ? to.y : to.y + to.h) : to.y + to.h / 2;

  const c1: [number, number] = srcClear ? [sx, laneY] : [sx + clearance, laneY];
  const c2: [number, number] = tgtClear ? [tx, laneY] : [tx - clearance, laneY];
  const { d, midX, midY } = cubic([sx, sy], c1, c2, [tx, ty]);
  return { d, back: true, side: above ? "above" : "below", sx, sy, midX, midY, laneY };
}

/** Render a manifest edge condition as a short human-readable string. */
export function edgeConditionLabel(expr: ManifestExpr, depth = 0): string {
  if (depth > 3) return "…";
  switch (expr.op) {
    case "const": return expr.value === null ? "null" : String(expr.value);
    case "var":   return expr.key;
    case "eq":    return `${edgeConditionLabel(expr.left, depth + 1)} = ${edgeConditionLabel(expr.right, depth + 1)}`;
    case "ne":    return `${edgeConditionLabel(expr.left, depth + 1)} ≠ ${edgeConditionLabel(expr.right, depth + 1)}`;
    case "lt":    return `${edgeConditionLabel(expr.left, depth + 1)} < ${edgeConditionLabel(expr.right, depth + 1)}`;
    case "lte":   return `${edgeConditionLabel(expr.left, depth + 1)} ≤ ${edgeConditionLabel(expr.right, depth + 1)}`;
    case "gt":    return `${edgeConditionLabel(expr.left, depth + 1)} > ${edgeConditionLabel(expr.right, depth + 1)}`;
    case "gte":   return `${edgeConditionLabel(expr.left, depth + 1)} ≥ ${edgeConditionLabel(expr.right, depth + 1)}`;
    case "and":   return expr.clauses.map(c => edgeConditionLabel(c, depth + 1)).join(" & ");
    case "or":    return expr.clauses.map(c => edgeConditionLabel(c, depth + 1)).join(" | ");
    case "not":   return `!${edgeConditionLabel(expr.clause, depth + 1)}`;
  }
}
