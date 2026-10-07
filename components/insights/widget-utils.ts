"use client";

import { useCallback, useEffect, useState } from "react";

/** The element's content size, kept current with a ResizeObserver (widgets resize with the layout). */
export function useSize<T extends HTMLElement>(): [{ width: number; height: number }, (el: T | null) => void] {
  const [el, setEl] = useState<T | null>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  useEffect(() => {
    if (!el) return;
    const measure = () => setSize({ width: el.clientWidth, height: el.clientHeight });
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [el]);
  return [size, useCallback((node: T | null) => setEl(node), [])];
}

/** Dollars as the dashboard shows them when Studio's formatter is not at hand. */
export const money = (dollars: number) => dollars.toLocaleString("en-US", { style: "currency", currency: "USD" });

/** A date value as Studio's data engine returns it: a Date, epoch milliseconds or an ISO string. */
export function toMs(v: unknown): number | null {
  if (v instanceof Date) return v.getTime();
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v) {
    const t = Date.parse(v);
    return Number.isNaN(t) ? null : t;
  }
  return null;
}
