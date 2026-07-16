/**
 * A human-readable STRUCTURED diff between two agent manifests. Used by the visible
 * self-improvement loop: when a run fails and Krelvan proposes a corrected agent, the owner sees
 * exactly what changed — which steps/tools/edges were added, removed, or altered — before they
 * accept and run it. Pure; no I/O.
 */
import type { Manifest, ManifestNode, ManifestEdge } from "../core/manifest/manifest.js";

export interface NodeChange {
  id: string;
  /** what changed on an existing node, in plain phrases (e.g. "gained tool: rag.search"). */
  changes: string[];
}

export interface FieldChange {
  field: string;
  before: string;
  after: string;
}

export interface ManifestDiff {
  /** true when the two manifests are structurally identical (nothing to show). */
  identical: boolean;
  addedNodes: { id: string; role: string; capabilities: string[] }[];
  removedNodes: { id: string; role: string }[];
  changedNodes: NodeChange[];
  addedEdges: { from: string; to: string }[];
  removedEdges: { from: string; to: string }[];
  /** top-level field changes: entry node, budget ceiling, visit cap, name. */
  fieldChanges: FieldChange[];
}

function capNames(n: ManifestNode): string[] {
  return n.capabilities.map(c => c.name).sort();
}

function edgeKey(e: ManifestEdge): string {
  return `${e.from}→${e.to}`;
}

/** Compute a structured, order-insensitive diff from `before` to `after`. */
export function diffManifests(before: Manifest, after: Manifest): ManifestDiff {
  const beforeNodes = new Map(before.nodes.map(n => [n.id, n]));
  const afterNodes = new Map(after.nodes.map(n => [n.id, n]));

  const addedNodes = after.nodes
    .filter(n => !beforeNodes.has(n.id))
    .map(n => ({ id: n.id, role: n.role, capabilities: capNames(n) }));

  const removedNodes = before.nodes
    .filter(n => !afterNodes.has(n.id))
    .map(n => ({ id: n.id, role: n.role }));

  const changedNodes: NodeChange[] = [];
  for (const n of after.nodes) {
    const prev = beforeNodes.get(n.id);
    if (!prev) continue; // added, handled above
    const changes: string[] = [];
    if (prev.role !== n.role) changes.push(`role: "${prev.role}" → "${n.role}"`);
    if (prev.autonomy !== n.autonomy) changes.push(`autonomy: ${prev.autonomy} → ${n.autonomy}`);
    const prevCaps = new Set(capNames(prev));
    const nextCaps = new Set(capNames(n));
    for (const c of nextCaps) if (!prevCaps.has(c)) changes.push(`gained tool: ${c}`);
    for (const c of prevCaps) if (!nextCaps.has(c)) changes.push(`removed tool: ${c}`);
    if (changes.length) changedNodes.push({ id: n.id, changes });
  }

  const beforeEdges = new Set(before.edges.map(edgeKey));
  const afterEdges = new Set(after.edges.map(edgeKey));
  const addedEdges = after.edges.filter(e => !beforeEdges.has(edgeKey(e))).map(e => ({ from: e.from, to: e.to }));
  const removedEdges = before.edges.filter(e => !afterEdges.has(edgeKey(e))).map(e => ({ from: e.from, to: e.to }));

  const fieldChanges: FieldChange[] = [];
  if (before.entry !== after.entry) fieldChanges.push({ field: "entry step", before: before.entry, after: after.entry });
  if (before.name !== after.name) fieldChanges.push({ field: "name", before: before.name, after: after.name });
  if (before.maxNodeVisits !== after.maxNodeVisits) fieldChanges.push({ field: "max step visits", before: String(before.maxNodeVisits), after: String(after.maxNodeVisits) });

  const identical =
    addedNodes.length === 0 && removedNodes.length === 0 && changedNodes.length === 0 &&
    addedEdges.length === 0 && removedEdges.length === 0 && fieldChanges.length === 0;

  return { identical, addedNodes, removedNodes, changedNodes, addedEdges, removedEdges, fieldChanges };
}
