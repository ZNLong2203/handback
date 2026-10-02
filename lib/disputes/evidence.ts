import { createHash } from "node:crypto";
import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFImage, type PDFPage, type RGB } from "pdf-lib";
import { formatUsd } from "@/lib/money";
import { canonicalJson } from "@/lib/rentals/audit";
import { counterDecision, customerAnswer, KIND_LABEL, reasonLabel, utc, type EvidenceFacts, type EvidenceFinding } from "./facts";
import type { Narrative } from "./narrative";

/**
 * The one-page evidence pack. Pure and deterministic: the same facts,
 * narrative and photos always give the same bytes (fixed metadata dates
 * from the facts, no random ids), so a pack's SHA-256 identifies its
 * content. The photos are embedded byte for byte, so an image extracted
 * from the PDF hashes to the SHA-256 printed under it.
 */
export const PACK_VERSION = "Handback evidence pack v1";

export type PackPhotos = { pickup: Uint8Array | null; returned: Uint8Array | null };

export const sha256Hex = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
export const factsSha = (facts: EvidenceFacts) => sha256Hex(canonicalJson(facts));
export const packFileName = (facts: EvidenceFacts) => `${facts.rental.id}-evidence.pdf`;

const W = 612;
const H = 792;
const M = 36;
const CONTENT = W - 2 * M;
const hex = (h: string) => rgb(parseInt(h.slice(0, 2), 16) / 255, parseInt(h.slice(2, 4), 16) / 255, parseInt(h.slice(4, 6), 16) / 255);
const C = {
  ink: hex("1d1b2f"),
  soft: hex("3d3b52"),
  muted: hex("6b6a7a"),
  line: hex("d8d1c5"),
  paper: hex("faf7f2"),
  brand: hex("3730a3"),
  held: hex("b7791f"),
  released: hex("1f7a4d"),
  charged: hex("c2462b"),
  note: hex("475569"),
  white: rgb(1, 1, 1),
};

type Fonts = { regular: PDFFont; bold: PDFFont; mono: PDFFont };

const charsets = new WeakMap<PDFFont, Set<number>>();
/** Standard PDF fonts only cover WinAnsi; map what we can and replace the rest, never throw. */
function clean(font: PDFFont, s: string): string {
  let set = charsets.get(font);
  if (!set) charsets.set(font, (set = new Set(font.getCharacterSet())));
  const mapped = s
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, "-")
    .replace(/…/g, "...")
    .replace(/→/g, "->")
    .replace(/\s+/g, " ");
  return [...mapped].map((ch) => (set.has(ch.codePointAt(0)!) ? ch : "?")).join("");
}

function wrap(font: PDFFont, size: number, text: string, width: number, maxLines = Infinity): string[] {
  const words = clean(font, text).split(" ").filter(Boolean);
  const lines: string[] = [];
  let line = "";
  for (const word of words) {
    const next = line ? `${line} ${word}` : word;
    if (font.widthOfTextAtSize(next, size) <= width) {
      line = next;
      continue;
    }
    if (line) lines.push(line);
    line = word;
    // A single token wider than the column (a hash, a long id): break it by characters.
    while (font.widthOfTextAtSize(line, size) > width) {
      let cut = line.length - 1;
      while (cut > 1 && font.widthOfTextAtSize(line.slice(0, cut), size) > width) cut--;
      lines.push(line.slice(0, cut));
      line = line.slice(cut);
    }
  }
  if (line) lines.push(line);
  if (lines.length <= maxLines) return lines;
  const kept = lines.slice(0, maxLines);
  let last = `${kept[maxLines - 1]}...`;
  while (font.widthOfTextAtSize(last, size) > width && last.length > 3) last = `${last.slice(0, -4)}...`;
  kept[maxLines - 1] = last;
  return kept;
}

class Sheet {
  constructor(
    readonly page: PDFPage,
    readonly f: Fonts,
  ) {}

  /** Draws one line with its top edge at `top` (measured from the top of the page). */
  text(s: string, x: number, top: number, size: number, font: PDFFont = this.f.regular, color: RGB = C.ink) {
    this.page.drawText(clean(font, s), { x, y: H - top - size * 0.82, size, font, color });
  }

  lines(lines: string[], x: number, top: number, size: number, lead: number, font: PDFFont = this.f.regular, color: RGB = C.ink): number {
    lines.forEach((l, i) => this.text(l, x, top + i * lead, size, font, color));
    return lines.length * lead;
  }

  rule(top: number) {
    this.page.drawLine({ start: { x: M, y: H - top }, end: { x: W - M, y: H - top }, thickness: 0.6, color: C.line });
  }

  box(x: number, top: number, w: number, h: number, opts: { fill?: RGB; border?: RGB; width?: number; dash?: number[] }) {
    this.page.drawRectangle({
      x,
      y: H - top - h,
      width: w,
      height: h,
      color: opts.fill,
      borderColor: opts.border,
      borderWidth: opts.border ? (opts.width ?? 1) : 0,
      borderDashArray: opts.dash,
    });
  }
}

function findingColor(f: EvidenceFinding): RGB {
  if (f.proposed && f.staff === "keep") return f.charged ? C.charged : C.muted;
  return f.kind === "pre_existing" ? C.held : C.note;
}

function drawPhoto(s: Sheet, img: PDFImage | null, x: number, top: number, w: number, h: number, findings: EvidenceFinding[], which: "before" | "after") {
  s.box(x, top, w, h, { fill: C.paper, border: C.line, width: 0.6 });
  if (!img) {
    s.text("No photo recorded", x + 10, top + h / 2 - 4, 8, s.f.regular, C.muted);
    return;
  }
  const scale = Math.min(w / img.width, h / img.height);
  const iw = img.width * scale;
  const ih = img.height * scale;
  const ix = x + (w - iw) / 2;
  const itop = top + (h - ih) / 2;
  s.page.drawImage(img, { x: ix, y: H - itop - ih, width: iw, height: ih });
  for (const f of findings) {
    const b = which === "before" ? f.boxBefore : f.boxAfter;
    if (!b) continue;
    const [ymin, xmin, ymax, xmax] = b;
    const color = findingColor(f);
    const bx = ix + (xmin / 1000) * iw;
    const btop = itop + (ymin / 1000) * ih;
    s.box(bx, btop, ((xmax - xmin) / 1000) * iw, ((ymax - ymin) / 1000) * ih, {
      border: color,
      width: 1.6,
      dash: which === "before" && f.kind === "missing" ? [3, 2] : undefined,
    });
    s.page.drawCircle({ x: bx, y: H - btop, size: 5.2, color, borderColor: C.white, borderWidth: 0.8 });
    const label = String(f.n);
    s.text(label, bx - s.f.bold.widthOfTextAtSize(label, 6) / 2, btop - 3, 6, s.f.bold, C.white);
  }
}

const COLS = [
  { key: "n", label: "#", w: 14 },
  { key: "what", label: "What the photos show", w: 192 },
  { key: "price", label: "Shop price list", w: 106 },
  { key: "amount", label: "Amount", w: 46 },
  { key: "customer", label: "Customer", w: 100 },
  { key: "counter", label: "Counter", w: 82 },
] as const;

function findingCells(f: EvidenceFinding, answeredAt: string | null) {
  return {
    n: String(f.n),
    what: `${KIND_LABEL[f.kind]}: ${f.item}. ${f.description}`,
    price: f.price ? f.price.label : "No entry",
    amount: f.price ? (f.charged ? formatUsd(f.price.cents) : `${formatUsd(f.price.cents)} not charged`) : "-",
    customer: customerAnswer(f, answeredAt),
    counter: counterDecision(f),
  };
}

const TABLE_SIZE = 6.8;
const TABLE_LEAD = 8.4;

function measureRows(fonts: Fonts, facts: EvidenceFacts, maxLines: number) {
  return facts.findings.map((f) => {
    const cells = findingCells(f, facts.inspection?.answeredAt ?? null);
    const wrapped = Object.fromEntries(COLS.map((c) => [c.key, wrap(fonts.regular, TABLE_SIZE, cells[c.key], c.w - 6, maxLines)])) as Record<(typeof COLS)[number]["key"], string[]>;
    const lines = Math.max(...Object.values(wrapped).map((l) => l.length));
    return { f, wrapped, height: lines * TABLE_LEAD + 5 };
  });
}

export async function renderEvidencePdf(facts: EvidenceFacts, narrative: Narrative, photos: PackPhotos): Promise<Uint8Array> {
  const pdf = await PDFDocument.create({ updateMetadata: false });
  const at = new Date(facts.asOf);
  pdf.setTitle(`Evidence pack: rental ${facts.rental.id}${facts.dispute ? `, PayPal dispute ${facts.dispute.id}` : ""}`);
  pdf.setAuthor(facts.shop);
  pdf.setSubject("Rental condition record for a PayPal dispute");
  pdf.setKeywords([facts.rental.id, ...(facts.dispute ? [facts.dispute.id] : [])]);
  pdf.setCreator(PACK_VERSION);
  pdf.setProducer("Handback");
  pdf.setLanguage("en-US");
  pdf.setCreationDate(at);
  pdf.setModificationDate(at);

  const fonts: Fonts = {
    regular: await pdf.embedFont(StandardFonts.Helvetica),
    bold: await pdf.embedFont(StandardFonts.HelveticaBold),
    mono: await pdf.embedFont(StandardFonts.Courier),
  };
  const [pickupImg, returnImg] = await Promise.all([photos.pickup ? pdf.embedJpg(photos.pickup) : null, photos.returned ? pdf.embedJpg(photos.returned) : null]);
  const s = new Sheet(pdf.addPage([W, H]), fonts);
  const { regular, bold, mono } = fonts;
  const usd = (c: number | null) => (c === null ? "-" : formatUsd(c));

  // ── Header
  let y = M;
  s.text("HANDBACK EVIDENCE PACK", M, y, 7, bold, C.brand);
  y += 11;
  s.text(facts.dispute ? `PayPal dispute ${facts.dispute.id}` : `Rental ${facts.rental.id}`, M, y, 16, bold);
  y += 21;
  s.text(`Rental ${facts.rental.id} · ${facts.rental.item} · ${facts.shop}`, M, y, 8.5, regular, C.soft);
  y += 12;
  y += s.lines(
    wrap(regular, 7, `Prepared from Handback's records as of ${utc(facts.asOf)}. Each value below was recorded when it happened, by the counter, the customer's own phone, the AI comparison or PayPal; nothing was typed in for this dispute.`, CONTENT),
    M,
    y,
    7,
    9,
    regular,
    C.muted,
  );
  y += 4;
  s.rule(y);
  y += 8;

  // ── Key facts, two columns
  const d = facts.dispute;
  const p = facts.paypal;
  const left: [string, string][] = [
    ["Customer", facts.rental.customer],
    ["Rental", `${facts.rental.startDate} to ${facts.rental.endDate} (${facts.rental.days} day${facts.rental.days === 1 ? "" : "s"})`],
    ["Dispute", d ? `${reasonLabel(d.reason)} · ${usd(d.amountCents)}${d.openedAt ? ` · opened ${utc(d.openedAt)}` : ""}` : "None recorded"],
    ["Disputed transaction", d?.transactionId ?? "-"],
  ];
  const right: [string, string][] = [
    ["Rental fee", `${usd(facts.money.feeCents)}${p.feeCaptureId ? ` · capture ${p.feeCaptureId}` : ""}`],
    ["Deposit hold", `${usd(facts.money.heldCents)}${p.authorizationId ? ` · authorization ${p.authorizationId}` : ""}`],
    ["Settlement", p.settlementCaptureId ? `${usd(facts.money.capturedCents)} captured · capture ${p.settlementCaptureId}` : facts.money.settledAt ? "Hold released, nothing captured" : "Not settled"],
    ["Booking order", p.bookingOrderId ?? "-"],
  ];
  const colW = (CONTENT - 16) / 2;
  const rowsTop = y;
  for (const [i, [label, value]] of left.entries()) {
    s.text(label.toUpperCase(), M, rowsTop + i * 21, 6, bold, C.muted);
    s.lines(wrap(regular, 8, value, colW, 1), M, rowsTop + i * 21 + 8, 8, 10);
  }
  for (const [i, [label, value]] of right.entries()) {
    s.text(label.toUpperCase(), M + colW + 16, rowsTop + i * 21, 6, bold, C.muted);
    s.lines(wrap(regular, 8, value, colW, 1), M + colW + 16, rowsTop + i * 21 + 8, 8, 10);
  }
  y = rowsTop + 4 * 21 + 4;

  // ── Measure what follows the photos, so the photos take the space that is left
  const narrativeLines = narrative.paragraphs.map((para) => wrap(regular, 7.8, para.text, CONTENT - 16));
  const narrativeHeight = 30 + narrativeLines.reduce((h, l) => h + l.length * 10 + 4, 0);
  const footerHeight = 52;
  const moneyHeight = 24;
  const captionHeight = 34;
  const tableHeight = (rs: ReturnType<typeof measureRows>) => 13 + (rs.length ? rs.reduce((h, r) => h + r.height, 0) : 16) + 6;
  // Everything on the page except the photos and the table.
  const fixed = y + 8 + captionHeight + 10 + moneyHeight + 4 + narrativeHeight + footerHeight + M;
  // Photos get what is left, up to 196 pt; with many findings the table
  // drops to one line a cell, then to as many rows as fit.
  let rows = measureRows(fonts, facts, 3);
  let photoH = Math.min(196, H - fixed - tableHeight(rows));
  let hidden = 0;
  if (photoH < 110) {
    rows = measureRows(fonts, facts, 1);
    while (rows.length > 1 && H - fixed - tableHeight(rows) - 12 < 90) {
      rows = rows.slice(0, -1);
      hidden += 1;
    }
    photoH = Math.max(90, Math.min(196, H - fixed - tableHeight(rows) - (hidden ? 12 : 0)));
  }

  // ── Photos
  y += 8;
  const photoW = (CONTENT - 12) / 2;
  drawPhoto(s, pickupImg, M, y, photoW, photoH, facts.findings, "before");
  drawPhoto(s, returnImg, M + photoW + 12, y, photoW, photoH, facts.findings, "after");
  y += photoH + 5;
  const captions: [string, string, string | null][] = [
    [
      "At pickup",
      facts.pickup ? `Taken ${utc(facts.pickup.takenAt)}${facts.pickup.acknowledgedAt ? ` · confirmed by the customer ${utc(facts.pickup.acknowledgedAt)}` : " · not confirmed by the customer"}` : "No pickup photo",
      facts.pickup?.sha256 ?? null,
    ],
    ["At return", facts.returned ? `Taken ${utc(facts.returned.takenAt)}` : "No return photo", facts.returned?.sha256 ?? null],
  ];
  captions.forEach(([title, line, sha], i) => {
    const x = M + i * (photoW + 12);
    s.text(title, x, y, 7.5, bold);
    s.lines(wrap(regular, 6.6, line, photoW, 1), x, y + 10, 6.6, 8, regular, C.soft);
    if (sha) s.text(`sha256 ${sha}`, x, y + 20, 5.6, mono, C.muted);
  });
  y += captionHeight + 10;

  // ── Findings
  let x = M;
  for (const c of COLS) {
    s.text(c.label.toUpperCase(), x + (c.key === "amount" ? c.w - 3 - bold.widthOfTextAtSize(c.label.toUpperCase(), 5.8) : 0), y, 5.8, bold, C.muted);
    x += c.w;
  }
  y += 9;
  s.rule(y);
  y += 4;
  if (rows.length === 0) {
    s.text("Nothing changed between the photos: no findings.", M, y + 2, 7.5, regular, C.soft);
    y += 16;
  }
  for (const r of rows) {
    x = M;
    for (const c of COLS) {
      const lines = r.wrapped[c.key];
      const color = c.key === "amount" && r.f.charged ? C.charged : c.key === "n" ? findingColor(r.f) : C.ink;
      const font = c.key === "n" || (c.key === "amount" && r.f.charged) ? bold : regular;
      lines.forEach((l, i) => {
        const lx = c.key === "amount" ? x + c.w - 3 - font.widthOfTextAtSize(l, TABLE_SIZE) : x;
        s.text(l, lx, y + i * TABLE_LEAD, TABLE_SIZE, font, color);
      });
      x += c.w;
    }
    y += r.height;
    s.rule(y - 3);
  }
  if (hidden) {
    s.text(`${hidden} more finding${hidden === 1 ? "" : "s"} not shown for space.`, M, y, 6.6, regular, C.muted);
    y += 12;
  }
  y += 6;

  // ── Money
  const m = facts.money;
  s.box(M, y, CONTENT, moneyHeight - 4, { fill: C.paper });
  const money = [
    `Deposit held ${usd(m.heldCents)}`,
    `captured ${usd(m.capturedCents ?? 0)}`,
    `released ${usd(m.releasedCents ?? 0)}`,
    ...(m.extraCents ? [`charged above the deposit ${usd(m.extraCents)}`] : []),
    `rental fee ${usd(m.feeCents)} paid at booking`,
  ].join(" · ");
  s.text("MONEY ON PAYPAL", M + 8, y + 7, 6, bold, C.muted);
  s.text(money, M + 78, y + 6, 7.6, regular, C.ink);
  y += moneyHeight + 4;

  // ── Summary
  s.text("Summary", M, y, 9, bold);
  const source =
    narrative.source === "gemini"
      ? `Written by ${narrative.model} from the facts in this pack. Before printing, every number and id in it was checked against the facts it cites.`
      : `Built from fixed sentences out of the facts in this pack.${narrative.note ? ` ${narrative.note}` : ""}`;
  y += 12;
  y += s.lines(wrap(regular, 6.4, source, CONTENT), M, y, 6.4, 8, regular, C.muted);
  y += 4;
  for (const lines of narrativeLines) {
    s.box(M, y - 1, 2, lines.length * 10, { fill: C.brand });
    y += s.lines(lines, M + 10, y, 7.8, 10, regular, C.soft) + 4;
  }

  // ── Footer, anchored to the bottom margin
  let fy = H - M - footerHeight + 6;
  s.rule(fy - 6);
  const a = facts.audit;
  s.text(
    `Audit log: ${a.entries} entries, each a SHA-256 over canonical JSON that includes the previous entry's hash. Recomputed for this pack: ${a.intact ? "intact" : `broken at entry ${a.brokenAtSeq}`}.`,
    M,
    fy,
    6.6,
    a.intact ? regular : bold,
    a.intact ? C.soft : C.charged,
  );
  fy += 9;
  if (a.headHash) s.text(`head ${a.headHash}`, M, fy, 5.8, mono, C.muted);
  fy += 9;
  s.text("Both photos are embedded unchanged: an image extracted from this PDF hashes to the sha256 printed under it.", M, fy, 6.4, regular, C.muted);
  fy += 9;
  s.text(`${PACK_VERSION} · facts ${factsSha(facts)}`, M, fy, 5.8, mono, C.muted);

  return pdf.save();
}

/** The notes sent with the evidence (PayPal allows 2000 characters). */
export function paypalNotes(facts: EvidenceFacts, narrative: Narrative, packSha: string): string {
  const head = `In-store rental ${facts.rental.id} (${facts.rental.item}), ${facts.rental.startDate} to ${facts.rental.endDate}. Attached: ${packFileName(facts)} (SHA-256 ${packSha}), a one-page record of the pickup and return photos, the customer's answers on their own phone and the PayPal settlement, plus the two original photos.`;
  const body = narrative.paragraphs.map((p) => p.text).join(" ");
  const text = `${head}\n\n${body}`;
  if (text.length <= 2000) return text;
  const cut = text.slice(0, 1996);
  return `${cut.slice(0, cut.lastIndexOf(" "))} ...`;
}
