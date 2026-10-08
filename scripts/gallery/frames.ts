/**
 * Building blocks for the slide templates: the page shell with the app's
 * brand tokens and fonts, browser and phone frames that show a crop of a
 * capture, and small labels. Everything is plain HTML and CSS rendered by
 * Chromium at 2400x1600.
 */
import type { Box, Shot } from "./shots";

export const W = 2400;
export const H = 1600;

/** The app's tokens (app/globals.css). */
export const C = {
  paper: "#faf7f2",
  card: "#ffffff",
  ink: "#1d1b2f",
  inkSoft: "#3d3b52",
  muted: "#6b6a7a",
  line: "#e9e4dc",
  lineStrong: "#d8d1c5",
  brand: "#3730a3",
  brandSoft: "#eceafd",
  brandInk: "#26217a",
  held: "#b7791f",
  heldInk: "#8a5a12",
  heldSoft: "#fcf3e2",
  released: "#1f7a4d",
  releasedSoft: "#e4f3ea",
  charged: "#c2462b",
  chargedSoft: "#fbe8e2",
  note: "#475569",
  noteSoft: "#eef2f6",
};

const FONTS =
  "https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,500..800&family=Geist:wght@400..700&family=Geist+Mono:wght@400..600&display=block";

const BASE_CSS = `
* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; }
body {
  width: ${W}px; height: ${H}px; overflow: hidden; position: relative;
  background: ${C.paper}; color: ${C.ink};
  font-family: "Geist", ui-sans-serif, system-ui, sans-serif;
  -webkit-font-smoothing: antialiased; font-variant-numeric: tabular-nums;
}
.abs { position: absolute; }
.display { font-family: "Bricolage Grotesque", "Geist", sans-serif; }
.mono { font-family: "Geist Mono", ui-monospace, monospace; }
.eyebrow { font-size: 30px; font-weight: 600; letter-spacing: 0.14em; text-transform: uppercase; color: ${C.brand}; }
.eyebrow b { color: ${C.ink}; font-weight: 600; }
h1 {
  font-family: "Bricolage Grotesque", "Geist", sans-serif; font-weight: 700; font-size: 96px; line-height: 1.03;
  letter-spacing: -0.028em; margin: 26px 0 0; color: ${C.ink}; text-wrap: balance;
}
.lede { font-size: 38px; line-height: 1.42; color: ${C.inkSoft}; margin-top: 34px; text-wrap: pretty; }
.lede strong { color: ${C.ink}; font-weight: 600; }
.chips { display: flex; flex-wrap: wrap; gap: 14px; margin-top: 40px; }
.chip {
  display: inline-flex; align-items: center; gap: 12px; font-size: 25px; line-height: 1; padding: 13px 20px;
  background: ${C.card}; border: 2px solid ${C.line}; border-radius: 999px; color: ${C.inkSoft}; white-space: nowrap;
}
.chip .k { color: ${C.muted}; font-family: "Geist", sans-serif; }
.chip .v { font-family: "Geist Mono", monospace; color: ${C.ink}; font-weight: 500; }
.chip.held { background: ${C.heldSoft}; border-color: #f0dcb4; }
.chip.released { background: ${C.releasedSoft}; border-color: #c4e3d1; }
.chip.charged { background: ${C.chargedSoft}; border-color: #f1c9bd; }
.chip.brand { background: ${C.brandSoft}; border-color: #d6d2fa; }
.dot { width: 14px; height: 14px; border-radius: 50%; display: inline-block; }
.footer { position: absolute; left: 120px; right: 120px; bottom: 52px; display: flex; align-items: center; justify-content: space-between; }
.brandmark { display: flex; align-items: center; gap: 16px; font-family: "Bricolage Grotesque", sans-serif; font-weight: 700; font-size: 34px; letter-spacing: -0.02em; }
.source { font-size: 24px; color: ${C.muted}; text-align: right; max-width: 1500px; line-height: 1.35; }
.source b { color: ${C.inkSoft}; font-weight: 600; }

.browser {
  background: ${C.card}; border-radius: 22px; overflow: hidden; border: 2px solid ${C.lineStrong};
  box-shadow: 0 2px 4px rgb(29 27 47 / 0.06), 0 40px 90px -30px rgb(29 27 47 / 0.38);
}
.browser .bar { height: 58px; background: #f1ece4; display: flex; align-items: center; gap: 22px; padding: 0 22px; border-bottom: 2px solid ${C.line}; }
.browser .dots { display: flex; gap: 10px; }
.browser .dots i { width: 15px; height: 15px; border-radius: 50%; background: ${C.lineStrong}; display: block; }
.browser .url {
  flex: 1; max-width: 900px; height: 36px; border-radius: 10px; background: ${C.card}; color: ${C.muted};
  font-size: 21px; display: flex; align-items: center; padding: 0 18px; white-space: nowrap; overflow: hidden;
}
.window { border-radius: 18px; }
.window .bar { height: 50px; }
.window .url { font-size: 19px; height: 32px; }
.phone {
  background: ${C.ink}; padding: 16px; border-radius: 72px;
  box-shadow: 0 2px 4px rgb(29 27 47 / 0.08), 0 50px 100px -30px rgb(29 27 47 / 0.45), inset 0 0 0 3px #3a3850;
}
.phone .screen { border-radius: 56px; overflow: hidden; background: ${C.paper}; position: relative; }
.shot { position: relative; overflow: hidden; background: ${C.paper}; }
.shot img { position: absolute; display: block; max-width: none; }
.label { font-size: 26px; font-weight: 600; letter-spacing: 0.12em; text-transform: uppercase; color: ${C.muted}; }
`;

export function pageHtml(body: string, css = ""): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin><link rel="stylesheet" href="${FONTS}"><style>${BASE_CSS}${css}</style></head><body>${body}</body></html>`;
}

export const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** The app's logo mark (components/brand.tsx): a hand-off loop. */
export function logoMark(size: number): string {
  return `<svg width="${size}" height="${size}" viewBox="0 0 32 32" aria-hidden="true"><rect width="32" height="32" rx="10" fill="${C.ink}"/><path d="M9 13.5a7 7 0 0 1 12.6-4.2" fill="none" stroke="#fcf3e2" stroke-width="2.6" stroke-linecap="round"/><path d="M22.4 6.6v3.6h-3.6" fill="none" stroke="#fcf3e2" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/><path d="M23 18.5a7 7 0 0 1-12.6 4.2" fill="none" stroke="#7fd0a6" stroke-width="2.6" stroke-linecap="round"/><path d="M9.6 25.4v-3.6h3.6" fill="none" stroke="#7fd0a6" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
}

export type Crop = Box;

/** A crop of a capture (page CSS pixels), scaled to `width` slide pixels. */
export function shotImg(shot: Shot, crop: Crop, width: number, imgBase = "../raw"): string {
  const k = width / crop.w;
  const h = Math.round(crop.h * k);
  return `<div class="shot" style="width:${width}px;height:${h}px"><img src="${imgBase}/${shot.file}" style="width:${(shot.width * k).toFixed(2)}px;left:${(-crop.x * k).toFixed(2)}px;top:${(-crop.y * k).toFixed(2)}px" alt=""></div>`;
}

export function browserFrame(shot: Shot, crop: Crop, width: number, url: string, extraClass = ""): string {
  return `<div class="browser ${extraClass}" style="width:${width}px"><div class="bar"><span class="dots"><i></i><i></i><i></i></span><span class="url">${esc(url)}</span></div>${shotImg(shot, crop, width - 4)}</div>`;
}

export function phoneFrame(shot: Shot, crop: Crop, screenWidth: number): string {
  return `<div class="phone" style="width:${screenWidth + 32}px"><div class="screen">${shotImg(shot, crop, screenWidth)}</div></div>`;
}

/** A label chip: a muted key and a monospaced value (a PayPal id, an amount). */
export function chip(key: string, value: string, tone = ""): string {
  return `<span class="chip ${tone}"><span class="k">${esc(key)}</span><span class="v">${esc(value)}</span></span>`;
}

export function footer(source: string, brand = true): string {
  return `<div class="footer"><div class="brandmark">${brand ? `${logoMark(46)}Handback` : ""}</div><div class="source">${source}</div></div>`;
}

/** A small label above a frame: whose screen this is. */
export function frameLabel(text: string, left: number, top: number): string {
  return `<div class="abs label" style="left:${left}px;top:${top}px">${esc(text)}</div>`;
}

/** Crop helpers: a window `h` tall whose top is `top`, clamped to the page. */
export function windowAt(shot: Shot, x: number, w: number, top: number, h: number): Crop {
  const y = Math.max(0, Math.min(top, shot.height - h));
  return { x, y, w, h: Math.min(h, shot.height) };
}

export function anchor(shot: Shot, name: string): Box {
  const a = shot.anchors[name];
  if (!a) throw new Error(`capture ${shot.file} has no anchor "${name}"; capture again`);
  return a;
}
