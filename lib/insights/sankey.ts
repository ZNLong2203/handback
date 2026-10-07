/**
 * A small Sankey layout for the "Where the deposits went" widget. AG Charts'
 * Sankey series is Enterprise-only, so the widget draws its own SVG from this
 * geometry. Pure: links in, nodes and bands out.
 *
 * Nodes go in columns by depth (a node with no incoming link is depth 0, the
 * others one past their deepest source), stacked top to bottom in `order`
 * when given, by size otherwise. A node's height is the larger of what flows
 * in and what flows out, so money is never drawn out of nothing.
 */

export type SankeyLink = { from: string; to: string; value: number };

export type LaidNode = { id: string; depth: number; x: number; y: number; height: number; value: number; inValue: number; outValue: number };
export type LaidLink = SankeyLink & {
  /** Band edges: top of the band where it leaves the source and where it enters the target. */
  sy: number;
  ty: number;
  /** Band thickness. */
  width: number;
  x0: number;
  x1: number;
  path: string;
};

export type SankeyLayout = { nodes: LaidNode[]; links: LaidLink[]; width: number; height: number };

export function layoutSankey(
  input: SankeyLink[],
  size: { width: number; height: number },
  opts: { nodeWidth?: number; gap?: number; order?: readonly string[]; minNodeHeight?: number } = {},
): SankeyLayout {
  const nodeWidth = opts.nodeWidth ?? 12;
  const gap = opts.gap ?? 14;
  const minH = opts.minNodeHeight ?? 0;
  // Merge duplicate links and drop empty ones and self-loops.
  const merged = new Map<string, SankeyLink>();
  for (const l of input) {
    if (!(l.value > 0) || l.from === l.to) continue;
    const key = `${l.from}\u0000${l.to}`;
    const prev = merged.get(key);
    merged.set(key, { from: l.from, to: l.to, value: (prev?.value ?? 0) + l.value });
  }
  const links = [...merged.values()];
  const ids = [...new Set(links.flatMap((l) => [l.from, l.to]))];
  if (ids.length === 0) return { nodes: [], links: [], width: size.width, height: size.height };

  // Depth: longest path from a source, ignoring cycles.
  const depth = new Map<string, number>(ids.map((id) => [id, 0]));
  for (let pass = 0; pass < ids.length; pass++) {
    let changed = false;
    for (const l of links) {
      const d = (depth.get(l.from) ?? 0) + 1;
      if (d > (depth.get(l.to) ?? 0) && d < ids.length) {
        depth.set(l.to, d);
        changed = true;
      }
    }
    if (!changed) break;
  }
  const inValue = (id: string) => links.filter((l) => l.to === id).reduce((s, l) => s + l.value, 0);
  const outValue = (id: string) => links.filter((l) => l.from === id).reduce((s, l) => s + l.value, 0);
  const columns = Math.max(...depth.values()) + 1;
  const rank = (id: string) => {
    const i = opts.order?.indexOf(id) ?? -1;
    return i < 0 ? Number.MAX_SAFE_INTEGER : i;
  };

  const byColumn: string[][] = Array.from({ length: columns }, () => []);
  for (const id of ids) byColumn[depth.get(id)!].push(id);
  for (const col of byColumn) col.sort((a, b) => rank(a) - rank(b) || Math.max(inValue(b), outValue(b)) - Math.max(inValue(a), outValue(a)) || a.localeCompare(b));

  // One scale for every column, the largest at which each column fits. A
  // small node still gets minNodeHeight, so its label has room; its bands
  // keep their true width inside it.
  const nodeValue = (id: string) => Math.max(inValue(id), outValue(id));
  const columnHeight = (col: string[], k: number) => col.reduce((sum, id) => sum + Math.max(minH, nodeValue(id) * k), 0) + gap * Math.max(0, col.length - 1);
  const fits = (k: number) => byColumn.every((col) => columnHeight(col, k) <= size.height + 1e-6);
  let lo = 0;
  let hi = Math.min(...byColumn.map((col) => (size.height - gap * Math.max(0, col.length - 1)) / Math.max(1e-9, col.reduce((sum, id) => sum + nodeValue(id), 0))));
  if (!fits(hi)) {
    for (let i = 0; i < 40; i++) {
      const mid = (lo + hi) / 2;
      if (fits(mid)) lo = mid;
      else hi = mid;
    }
    hi = lo;
  }
  const scale = Math.max(0, hi);
  const step = columns > 1 ? (size.width - nodeWidth) / (columns - 1) : 0;

  const nodes = new Map<string, LaidNode>();
  byColumn.forEach((col, c) => {
    let y = (size.height - columnHeight(col, scale)) / 2;
    for (const id of col) {
      const value = nodeValue(id);
      const height = Math.max(minH, value * scale);
      nodes.set(id, { id, depth: c, x: c * step, y, height, value, inValue: inValue(id), outValue: outValue(id) });
      y += height + gap;
    }
  });

  // Bands leave each source and enter each target in the order of the other end, top to bottom.
  const outOffset = new Map<string, number>();
  const inOffset = new Map<string, number>();
  const order = (id: string) => nodes.get(id)!.y;
  const sorted = [...links].sort((a, b) => order(a.from) - order(b.from) || order(a.to) - order(b.to));
  const laid: LaidLink[] = [];
  for (const l of [...sorted].sort((a, b) => order(a.to) - order(b.to) || order(a.from) - order(b.from))) {
    const s = nodes.get(l.from)!;
    const t = nodes.get(l.to)!;
    const width = l.value * scale;
    // Bands are centred in a node drawn taller than the money through it.
    if (!outOffset.has(l.from)) outOffset.set(l.from, (s.height - s.outValue * scale) / 2);
    if (!inOffset.has(l.to)) inOffset.set(l.to, (t.height - t.inValue * scale) / 2);
    const sy = s.y + outOffset.get(l.from)!;
    const ty = t.y + inOffset.get(l.to)!;
    outOffset.set(l.from, outOffset.get(l.from)! + width);
    inOffset.set(l.to, inOffset.get(l.to)! + width);
    const x0 = s.x + nodeWidth;
    const x1 = t.x;
    laid.push({ ...l, sy, ty, width, x0, x1, path: bandPath(x0, sy, x1, ty, width) });
  }
  // Keep the input's order for rendering, so the legend and keys stay stable.
  const keyed = new Map(laid.map((l) => [`${l.from}\u0000${l.to}`, l]));
  return { nodes: [...nodes.values()], links: links.map((l) => keyed.get(`${l.from}\u0000${l.to}`)!), width: size.width, height: size.height };
}

/** A filled band between two vertical edges, curved with cubic Béziers. */
export function bandPath(x0: number, y0: number, x1: number, y1: number, w: number): string {
  const mx = (x0 + x1) / 2;
  const r = (n: number) => Math.round(n * 100) / 100;
  return [
    `M${r(x0)},${r(y0)}`,
    `C${r(mx)},${r(y0)} ${r(mx)},${r(y1)} ${r(x1)},${r(y1)}`,
    `L${r(x1)},${r(y1 + w)}`,
    `C${r(mx)},${r(y1 + w)} ${r(mx)},${r(y0 + w)} ${r(x0)},${r(y0 + w)}`,
    "Z",
  ].join(" ");
}
