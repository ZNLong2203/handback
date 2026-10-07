import { describe, expect, it } from "vitest";
import { bandPath, layoutSankey } from "./sankey";

const flows = [
  { from: "Deposits held", to: "Released", value: 265 },
  { from: "Deposits held", to: "Captured", value: 35 },
  { from: "Captured", to: "Refunded", value: 10 },
  { from: "Captured", to: "Kept", value: 25 },
];

describe("layoutSankey", () => {
  it("puts nodes in columns by depth and conserves money through every node", () => {
    const l = layoutSankey(flows, { width: 600, height: 300 }, { gap: 10 });
    const node = (id: string) => l.nodes.find((n) => n.id === id)!;
    expect(node("Deposits held").depth).toBe(0);
    expect(node("Released").depth).toBe(1);
    expect(node("Captured").depth).toBe(1);
    expect(node("Kept").depth).toBe(2);
    expect(node("Captured")).toMatchObject({ inValue: 35, outValue: 35, value: 35 });
    expect(node("Deposits held").value).toBe(300);
    // Every column fits the height.
    for (const d of [0, 1, 2]) {
      const col = l.nodes.filter((n) => n.depth === d);
      const bottom = Math.max(...col.map((n) => n.y + n.height));
      expect(bottom).toBeLessThanOrEqual(300 + 1e-6);
      expect(Math.min(...col.map((n) => n.y))).toBeGreaterThanOrEqual(-1e-6);
    }
  });

  it("stacks bands inside their nodes without overlap", () => {
    const l = layoutSankey(flows, { width: 600, height: 300 });
    const out = l.links.filter((x) => x.from === "Deposits held").sort((a, b) => a.sy - b.sy);
    expect(out[1].sy).toBeCloseTo(out[0].sy + out[0].width, 6);
    const src = l.nodes.find((n) => n.id === "Deposits held")!;
    expect(out[0].sy).toBeGreaterThanOrEqual(src.y - 1e-6);
    expect(out[1].sy + out[1].width).toBeLessThanOrEqual(src.y + src.height + 1e-6);
  });

  it("gives small nodes a minimum height so their labels fit, and still fits the column", () => {
    const l = layoutSankey([...flows, { from: "Captured", to: "Disputed", value: 0.5 }], { width: 600, height: 240 }, { minNodeHeight: 30, gap: 10 });
    const col = l.nodes.filter((n) => n.depth === 2);
    for (const n of col) expect(n.height).toBeGreaterThanOrEqual(30);
    expect(Math.max(...col.map((n) => n.y + n.height))).toBeLessThanOrEqual(240 + 1e-6);
  });

  it("follows a preferred order, merges duplicate links and drops empty ones", () => {
    const l = layoutSankey(
      [
        { from: "A", to: "Y", value: 5 },
        { from: "A", to: "X", value: 1 },
        { from: "A", to: "X", value: 2 },
        { from: "A", to: "Z", value: 0 },
      ],
      { width: 300, height: 200 },
      { order: ["A", "X", "Y"] },
    );
    expect(l.links).toHaveLength(2);
    expect(l.links.find((x) => x.to === "X")!.value).toBe(3);
    const x = l.nodes.find((n) => n.id === "X")!;
    const y = l.nodes.find((n) => n.id === "Y")!;
    expect(x.y).toBeLessThan(y.y);
    expect(l.nodes.map((n) => n.id)).not.toContain("Z");
  });

  it("returns nothing for no flows, and draws closed band paths", () => {
    expect(layoutSankey([], { width: 100, height: 100 }).nodes).toEqual([]);
    expect(bandPath(0, 0, 100, 50, 10)).toMatch(/^M0,0 C50,0 50,50 100,50 L100,60 C50,60 50,10 0,10 Z$/);
  });
});
