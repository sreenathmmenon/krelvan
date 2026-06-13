import type { ManifestNode, ManifestEdge } from "./api";

export interface NodePos { x: number; y: number; w: number; h: number; }

export interface LayoutOptions {
  nodeW?: number;
  nodeH?: number;
  hGap?: number;
  vGap?: number;
}

const DEFAULTS = { nodeW: 196, nodeH: 108, hGap: 100, vGap: 64 };

export function layoutGraph(
  nodes: ManifestNode[],
  edges: ManifestEdge[],
  entry: string,
  opts: LayoutOptions = {},
): Map<string, NodePos> {
  const { nodeW, nodeH, hGap, vGap } = { ...DEFAULTS, ...opts };

  const layer = new Map<string, number>();
  const visited = new Set<string>();

  function visit(id: string, depth: number) {
    if (!visited.has(id) || (layer.get(id) ?? 0) < depth) {
      layer.set(id, depth);
      visited.add(id);
      for (const e of edges) if (e.from === id) visit(e.to, depth + 1);
    }
  }
  visit(entry, 0);
  for (const n of nodes) if (!layer.has(n.id)) layer.set(n.id, 0);

  const byLayer = new Map<number, string[]>();
  for (const n of nodes) {
    const l = layer.get(n.id)!;
    if (!byLayer.has(l)) byLayer.set(l, []);
    byLayer.get(l)!.push(n.id);
  }

  const maxLayer = Math.max(0, ...[...layer.values()]);
  const positions = new Map<string, NodePos>();
  for (let l = 0; l <= maxLayer; l++) {
    const col = byLayer.get(l) ?? [];
    col.forEach((id, rowIdx) => {
      positions.set(id, {
        x: l * (nodeW + hGap),
        y: rowIdx * (nodeH + vGap),
        w: nodeW,
        h: nodeH,
      });
    });
  }
  return positions;
}

export function graphBounds(positions: Map<string, NodePos>, hGap = DEFAULTS.hGap, vGap = DEFAULTS.vGap) {
  let maxX = 0, maxY = 0;
  for (const p of positions.values()) {
    maxX = Math.max(maxX, p.x + p.w);
    maxY = Math.max(maxY, p.y + p.h);
  }
  return { w: maxX + hGap * 2, h: maxY + vGap * 2 };
}

export function edgePath(from: NodePos, to: NodePos): string {
  const x1 = from.x + from.w;
  const y1 = from.y + from.h / 2;
  const x2 = to.x;
  const y2 = to.y + to.h / 2;
  const cx = (x1 + x2) / 2;
  return `M ${x1} ${y1} C ${cx} ${y1}, ${cx} ${y2}, ${x2} ${y2}`;
}
