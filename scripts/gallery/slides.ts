/**
 * The gallery: one idea per slide, a headline of about eight words, one
 * supporting paragraph, the captures in browser and phone frames, and a
 * caption for Devpost's caption field. Every number here comes from the
 * capture run (manifest facts), README.md, eval/README.md or
 * docs/paypal-sandbox-notes.md; the comments say which.
 */
import { anchor, browserFrame, C, chip, footer, frameLabel, logoMark, pageHtml, phoneFrame, windowAt, type Crop } from "./frames";
import type { Manifest, Shot } from "./shots";

export type Slide = { file: string; title: string; caption: string; html: string };

const PHONE = 390;
const PHONE_H = 844;
/** Frames stay inside these bounds, clear of the footer. */
const RIGHT = 2280;
const BOTTOM = 1440;
const BAR = 60;

function lookup(m: Manifest) {
  const shot = (name: string): Shot => {
    const s = m.shots[name];
    if (!s) throw new Error(`no capture named "${name}" in raw/manifest.json; run the live and demo captures first`);
    return s;
  };
  const fact = (key: string): string => {
    const v = m.facts[key];
    if (!v) throw new Error(`no fact "${key}" in raw/manifest.json; run the captures again`);
    return v;
  };
  return { shot, fact };
}

const fmtDate = (iso: string) => new Date(`${iso}T12:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });

/** Slide pixels a crop takes in a browser frame `width` wide (bar included). */
const framedHeight = (crop: Crop, width: number) => Math.round(crop.h * ((width - 4) / crop.w)) + BAR;
const phoneHeight = (crop: Crop, screen: number) => Math.round(crop.h * (screen / crop.w)) + 32;

/** Text column for layout A: eyebrow, headline, paragraph, chips. */
function textColumn(width: number, eyebrow: string, headline: string, lede: string, extra = ""): string {
  return `<div class="abs" style="left:120px;top:120px;width:${width}px">
    <div class="eyebrow">${eyebrow}</div>
    <h1>${headline}</h1>
    <p class="lede">${lede}</p>
    ${extra}
  </div>`;
}

/** Layout B: eyebrow, a one-line headline and a paragraph across the top; a wide frame below. */
function headerBlock(eyebrow: string, headline: string, lede: string): string {
  return `<div class="abs" style="left:120px;top:110px;width:2160px">
    <div class="eyebrow">${eyebrow}</div>
    <h1 style="font-size:88px;margin-top:20px">${headline}</h1>
    <p class="lede" style="font-size:36px;margin-top:22px;max-width:2000px">${lede}</p>
  </div>`;
}
const B_TOP = 470;

/** The widest frame of this crop that fits between B_TOP and BOTTOM. */
const wideFrameWidth = (crop: Crop) => Math.min(RIGHT - 120, Math.floor(((BOTTOM - B_TOP - BAR) / crop.h) * crop.w) + 4);

export function buildSlides(m: Manifest): Slide[] {
  const { shot, fact } = lookup(m);
  const liveGemini = fact("liveAi") === "gemini";
  const date = fmtDate(fact("liveDate"));
  const rental = fact("liveRentalId");
  const ids = {
    order: fact("liveOrderId"),
    fee: fact("liveFeeCaptureId"),
    auth: fact("liveAuthorizationId"),
    settle: fact("liveSettlementCaptureId"),
  };
  // What the strip at the top of the captured pages said, repeated in the footer and the captions.
  const liveSource = liveGemini
    ? `Captured ${date} · <b>PayPal sandbox</b>, real API calls · <b>Gemini, live</b> · AI-generated photos`
    : `Captured ${date} · <b>PayPal sandbox</b>, real API calls · photo check: <b>recorded Gemini run</b> · AI-generated photos`;
  const liveCaptionTail = liveGemini
    ? "Captured in the PayPal sandbox with live Gemini; the bike photos are AI-generated samples."
    : "Captured in the PayPal sandbox (real API calls); the photo comparison replays a recorded two-look Gemini run of these AI-generated sample photos.";
  const demoSource = `<b>Demo mode</b>: PayPal stand-in and sample data, as the app's own strip says`;
  const host = (base: string) => base.replace(/^https?:\/\//, "");
  const liveHost = host(fact("liveBase"));
  const demoHost = host(fact("demoBase"));
  const counterUrl = `${liveHost}/shop/rentals/${rental}`;

  const slides: Slide[] = [];

  // ── 1. Cover ────────────────────────────────────────────────────────────────
  {
    const settled = shot("counter-settled");
    const receipt = shot("renter-receipt");
    const bezel = 22;
    const outer = 1150;
    const left = RIGHT - 40 - outer;
    const screenW = outer - 2 * bezel;
    const screen: Crop = { x: 0, y: 0, w: 1280, h: 800 };
    const laptopTop = 250;
    const laptop = `
      <div class="abs" style="left:${left}px;top:${laptopTop}px;width:${outer}px">
        <div style="background:${C.ink};border-radius:30px 30px 10px 10px;padding:${bezel}px ${bezel}px 28px;box-shadow:0 60px 120px -40px rgb(29 27 47 / .45)">
          <div style="border-radius:8px;overflow:hidden">${browserFrame(settled, screen, screenW, counterUrl)}</div>
        </div>
        <div style="margin:0 -40px;height:30px;border-radius:0 0 26px 26px;background:linear-gradient(#ddd7cc,#c4bdb0);box-shadow:0 30px 50px -24px rgb(29 27 47 / .5)"></div>
      </div>`;
    const phoneScreen = 360;
    const phoneCrop: Crop = { x: 0, y: 0, w: PHONE, h: PHONE_H };
    const phone = `<div class="abs" style="left:1010px;top:${BOTTOM + 20 - phoneHeight(phoneCrop, phoneScreen)}px">${phoneFrame(receipt, phoneCrop, phoneScreen)}</div>`;
    slides.push({
      file: "01-handback.png",
      title: "Handback: rental deposits that settle themselves, fairly",
      caption: `A real sandbox rental at the moment it settles: the counter keeps $12.00 for a missing phone holder, and PayPal releases the other $138.00 of the $150.00 deposit, which the renter sees on their phone. ${liveCaptionTail}`,
      html: pageHtml(`
        <div class="abs" style="left:120px;top:120px;width:800px">
          <div class="brandmark" style="font-size:64px;gap:26px">${logoMark(92)}Handback</div>
          <h1 style="font-size:108px;margin-top:72px">Rental deposits that settle themselves, fairly</h1>
          <p class="lede" style="font-size:40px;margin-top:44px">PayPal holds the deposit at pickup. Two AI looks compare the photos. The renter sees every charge before PayPal takes it, and the rest is released.</p>
          <div style="display:flex;gap:30px;margin-top:52px;font-size:31px;color:${C.inkSoft};white-space:nowrap">
            ${[
              ["$150.00", "held", C.held],
              ["$12.00", "kept", C.charged],
              ["$138.00", "released", C.released],
            ]
              .map(([v, l, c]) => `<span style="display:inline-flex;align-items:center;gap:14px"><span class="dot" style="background:${c};width:20px;height:20px"></span><b style="color:${C.ink};font-weight:650">${v}</b> ${l}</span>`)
              .join("")}
          </div>
        </div>
        ${laptop}${phone}
        ${footer(liveSource, false)}
      `),
    });
  }

  // ── 2. The problem: the interview (README.md, "Why") ────────────────────────
  {
    const tile = (big: string, small: string, tone: string, opts: { wide?: boolean; soft?: string; aside?: string } = {}) => `
      <div style="background:${opts.soft ?? C.card};border:2px solid ${opts.soft ? "#f1c9bd" : C.line};border-radius:30px;padding:54px 52px;${opts.wide ? "grid-column:1 / span 2;" : ""}">
        <div style="display:flex;align-items:center;gap:20px"><span class="dot" style="background:${tone};width:20px;height:20px;flex:none"></span>
          <span class="display" style="font-size:120px;font-weight:700;letter-spacing:-0.035em;line-height:1">${big}</span>
          ${opts.aside ? `<span class="display" style="font-size:56px;font-weight:600;color:${C.inkSoft};letter-spacing:-0.02em;margin-left:12px">${opts.aside}</span>` : ""}</div>
        <div style="font-size:36px;line-height:1.3;color:${C.inkSoft};margin-top:20px">${small}</div>
      </div>`;
    slides.push({
      file: "02-the-problem.png",
      title: "The problem: deposits cost a small shop money and trust",
      caption:
        "From our October 2026 interview with the owner of one bicycle rental shop in Vietnam: 400 to 600 rentals a month, only 30 to 40% of pickups photographed, 5 to 10 deposit arguments a month, 2 to 5 million VND (about $75 to $190) a month absorbed in repairs it cannot prove, and 15 to 30 minutes to return a deposit at busy times. These are the owner's estimates for one shop.",
      html: pageHtml(`
        ${textColumn(
          780,
          "The problem",
          "Deposits cost a small shop money and trust",
          "What would earn the owner's trust in an AI check: <strong>marked before-and-after photos</strong>, the time and the bike's ID, and a customer who <strong>sees the evidence directly</strong>.",
        )}
        <div class="abs" style="left:1000px;top:120px;width:1280px;display:flex;flex-direction:column;gap:46px">
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:30px">
          ${tile("400–600", "rentals a month", C.brand)}
          ${tile("30–40%", "of pickups photographed", C.held)}
          ${tile("5–10", "deposit arguments a month", C.held)}
          ${tile("15–30", "minutes to return a deposit at busy times", C.held)}
          ${tile("2–5M VND", "a month in repairs the shop absorbs because it cannot prove them", C.charged, { wide: true, soft: C.chargedSoft, aside: "≈ $75–190" })}
        </div>
        <div style="font-size:28px;line-height:1.42;color:${C.muted}">
          From our October 2026 interview with the owner of one bicycle rental shop in Vietnam, which takes deposits in cash or by bank transfer today. The numbers are the owner's estimates for that one shop: they show the problem is real for someone, not how common it is.
        </div>
        </div>
        ${footer("Interview: README.md, “Why”")}
      `),
    });
  }

  // ── 3. Book ────────────────────────────────────────────────────────────────
  {
    const book = shot("book-desktop");
    const popup = shot("paypal-review");
    const cancel = anchor(book, "cancel");
    // Down to the end of the cancellation terms.
    const crop: Crop = { x: 60, y: 0, w: 1160, h: Math.min(book.height, cancel.y + 196) };
    const bw = 1000;
    const bTop = 120;
    const popupW = 390;
    const popupCrop: Crop = { x: 0, y: 0, w: popup.width, h: popup.height };
    const pTop = Math.max(bTop, BOTTOM - framedHeight(popupCrop, popupW) - 20);
    slides.push({
      file: "03-book.png",
      title: "Book: pay the fee with PayPal, saved for the deposit",
      caption: `The booking page shows the shop's repair prices and cancellation terms before anything is paid. One approval with the PayPal button (JS SDK v6) pays the $45.00 fee and saves PayPal for this shop, so the deposit can be held at pickup without asking again. Sandbox order ${ids.order}, fee capture ${ids.fee}.`,
      html: pageHtml(`
        ${textColumn(
          680,
          "Step 1 of 5 · <b>Book</b>",
          "Pay with PayPal, saved for the deposit",
          "Prices and cancellation terms come first. One PayPal approval pays the <strong>$45.00</strong> fee and saves PayPal, so the shop can hold the <strong>$150.00</strong> deposit at pickup.",
          `<div class="chips">${chip("order", ids.order)}${chip("fee capture", ids.fee)}${chip("PayPal", "JS SDK v6")}</div>`,
        )}
        <div class="abs" style="left:${RIGHT - popupW - bw - 30}px;top:${bTop}px">${browserFrame(book, crop, bw, `${liveHost}/rent/city-bike`)}</div>
        <div class="abs" style="left:${RIGHT - popupW}px;top:${pTop}px">${browserFrame(popup, popupCrop, popupW, "sandbox.paypal.com", "window")}</div>
        ${footer(`${liveSource} · card pictures blurred`)}
      `),
    });
  }

  // ── 4. Pick up ─────────────────────────────────────────────────────────────
  {
    const pickup = shot("counter-pickup");
    const confirm = shot("renter-confirm");
    const p = anchor(pickup, "pickup");
    const hold = anchor(pickup, "hold");
    const crop: Crop = { x: p.x - 40, y: p.y - 38, w: p.w + 80, h: hold.y + hold.h + 44 - (p.y - 38) };
    const c = anchor(confirm, "confirm");
    const phoneCrop = windowAt(confirm, 0, PHONE, c.y + c.h + 30 - PHONE_H, PHONE_H);
    const bw = 900;
    const screen = 400;
    const bLeft = 860;
    const bTop = 170;
    const pLeft = RIGHT - screen - 32;
    const pTop = bTop + 80;
    slides.push({
      file: "04-pick-up.png",
      title: "Pick up: one tap holds the deposit on PayPal",
      caption: `At pickup the counter photographs the bike and holds the $150.00 deposit on the PayPal account saved at booking, with no new approval from the renter (a merchant-initiated authorization, valid 29 days). The renter confirms the pickup photo on their phone. Sandbox authorization ${ids.auth}.`,
      html: pageHtml(`
        ${textColumn(
          680,
          "Step 2 of 5 · <b>Pick up</b>",
          "One tap holds the deposit on PayPal",
          "Staff photograph the bike and hold <strong>$150.00</strong> on the saved PayPal account: no new approval, nothing charged. The renter confirms the photo on their phone.",
          `<div class="chips">${chip("authorization", ids.auth, "held")}${chip("hold valid", "29 days")}</div>`,
        )}
        ${frameLabel("At the counter", bLeft + 4, bTop - 50)}
        <div class="abs" style="left:${bLeft}px;top:${bTop}px">${browserFrame(pickup, crop, bw, counterUrl)}</div>
        ${frameLabel("On the renter's phone", pLeft + 10, pTop - 50)}
        <div class="abs" style="left:${pLeft}px;top:${pTop}px">${phoneFrame(confirm, phoneCrop, screen)}</div>
        ${footer(liveSource)}
      `),
    });
  }

  // ── 5. Return: two looks ───────────────────────────────────────────────────
  {
    const f = shot("counter-findings");
    const sec = anchor(f, "section");
    const proposed = anchor(f, "proposed");
    const crop: Crop = { x: sec.x - 40, y: sec.y - 44, w: proposed.w + 32 + 80, h: proposed.y + proposed.h + 40 - (sec.y - 44) };
    const avail = BOTTOM - 120;
    const w = Math.min(1180, Math.floor(((avail - BAR) / crop.h) * crop.w) + 4);
    slides.push({
      file: "05-return.png",
      title: "Return: two AI looks must agree; code sets the price",
      caption: `At return, two independent Gemini calls compare the pickup and return photos and box what changed. The model points at an entry in the shop's price list and never names an amount; code prices it, and proposes a charge only when both looks agree. Here: phone holder $12.00 and rear light $15.00. ${liveGemini ? "Run live." : "Shown with the recorded two-look Gemini run of these sample photos, which the app replays when no API key is set."}`,
      html: pageHtml(`
        ${textColumn(
          RIGHT - w - 120 - 80,
          "Step 3 of 5 · <b>Return</b>",
          "Two AI looks compare. Code sets the price.",
          "Two independent Gemini calls box what changed. The AI only points at the shop's price list, never an amount, and a charge is proposed <strong>only when both looks agree</strong>.",
          `<div style="margin-top:50px;display:grid;grid-template-columns:1fr 1fr;gap:16px;font-size:28px;line-height:1.3">
             ${["Look 1", "Look 2"].map((l) => `<div style="background:${C.card};border:2px solid ${C.line};border-radius:20px;padding:20px 24px"><div style="font-weight:600">Gemini ${l.toLowerCase()}</div><div style="color:${C.inkSoft};margin-top:4px">phone holder · rear light</div></div>`).join("")}
             <div style="grid-column:1 / span 2;text-align:center;color:${C.muted};font-size:26px">↓ both name the same item and price-list entry ↓</div>
             <div style="grid-column:1 / span 2;background:${C.chargedSoft};border:2px solid #f1c9bd;border-radius:20px;padding:20px 24px;display:flex;justify-content:space-between;gap:20px">
               <span>Shop's price list</span><span><b>$12.00</b> phone holder · <b>$15.00</b> rear light</span></div>
           </div>
           <div class="chips">${chip("photo check", liveGemini ? "live Gemini ×2" : "recorded Gemini ×2")}</div>`,
        )}
        <div class="abs" style="left:${RIGHT - w}px;top:120px">${browserFrame(f, crop, w, counterUrl)}</div>
        ${footer(liveSource)}
      `),
    });
  }

  // ── 6. Review ──────────────────────────────────────────────────────────────
  {
    const answers = shot("renter-answers");
    const send = anchor(answers, "sendAnswers");
    const phoneCrop = windowAt(answers, 0, PHONE, send.y + send.h + 26 - PHONE_H, PHONE_H);
    const q = shot("counter-questioned");
    const waive = anchor(q, "waive");
    const price = anchor(q, "lightPrice");
    const crop: Crop = { x: 85, y: price.y - 54, w: 768, h: waive.y + waive.h + 34 - (price.y - 54) };
    const screen = 480;
    const pLeft = 860;
    const pTop = 160;
    const bw = 860;
    const bLeft = RIGHT - bw;
    const bTop = 640;
    slides.push({
      file: "06-review.png",
      title: "Review: the renter accepts or questions each charge",
      caption: `On their phone the renter sees both photos and each proposed charge. They accept the $12.00 phone holder and question the $15.00 rear light ("It's in my backpack"). A person at the counter decides every questioned charge; here they waive it. ${liveCaptionTail}`,
      html: pageHtml(`
        ${textColumn(
          700,
          "Step 4 of 5 · <b>Review</b>",
          "The renter accepts or questions each charge",
          "An accepts the <strong>$12.00</strong> phone holder and questions the rear light: “It's in my backpack.” Nothing is taken until a person at the counter decides; here, they <strong>waive it</strong>.",
        )}
        ${frameLabel("On the renter's phone", pLeft + 10, pTop - 50)}
        <div class="abs" style="left:${pLeft}px;top:${pTop}px">${phoneFrame(answers, phoneCrop, screen)}</div>
        ${frameLabel("At the counter", bLeft + 4, bTop - 50)}
        <div class="abs" style="left:${bLeft}px;top:${bTop}px">${browserFrame(q, crop, bw, counterUrl)}
          <div class="chips" style="margin-top:44px;width:${bw}px">${chip("phone holder", "$12.00 accepted", "charged")}${chip("rear light", "waived", "released")}</div>
        </div>
        ${footer(liveSource)}
      `),
    });
  }

  // ── 7. Settle ──────────────────────────────────────────────────────────────
  {
    const s = shot("counter-settled");
    const st = anchor(s, "settled");
    const refunds = anchor(s, "refunds");
    const light = anchor(s, "lightPrice");
    const crop: Crop = { x: st.x - 40, y: light.y - 54, w: st.w + 80, h: refunds.y - 34 - (light.y - 54) };
    const r = shot("renter-receipt");
    const released = anchor(r, "released");
    const phoneCrop = windowAt(r, 0, PHONE, released.y + 150 - PHONE_H, PHONE_H);
    const money = (amount: string, label: string, color: string) =>
      `<div><div class="display" style="font-size:96px;font-weight:700;letter-spacing:-0.035em;line-height:1;color:${C.ink}">${amount}</div><div style="display:flex;align-items:center;gap:14px;font-size:34px;color:${C.inkSoft};margin-top:16px"><span class="dot" style="background:${color};width:22px;height:22px"></span>${label}</div></div>`;
    const screen = 440;
    const pLeft = RIGHT - screen - 32;
    const pTop = 150;
    const bw = 860;
    const bLeft = pLeft - 60 - bw;
    const bTop = BOTTOM - framedHeight(crop, bw) - 40;
    slides.push({
      file: "07-settle.png",
      title: "Settle: one capture keeps $12.00, PayPal releases $138.00",
      caption: `Settling is one final capture on the authorization: $12.00 kept for the phone holder, and PayPal releases the other $138.00 of the $150.00 hold. The renter's page shows the receipt. Sandbox capture ${ids.settle} on authorization ${ids.auth}.`,
      html: pageHtml(`
        ${textColumn(
          700,
          "Step 5 of 5 · <b>Settle</b>",
          "One capture. PayPal releases the rest.",
          "One final capture on the hold keeps what was agreed. PayPal releases the rest at once: no refund step, no cash.",
          `<div style="display:flex;gap:70px;margin-top:60px">${money("$12.00", "kept", C.charged)}${money("$138.00", "released", C.released)}</div>
           <div class="chips" style="margin-top:60px">${chip("capture", ids.settle, "charged")}${chip("authorization", ids.auth)}</div>`,
        )}
        ${frameLabel("At the counter", bLeft + 4, bTop - 50)}
        <div class="abs" style="left:${bLeft}px;top:${bTop}px">${browserFrame(s, crop, bw, counterUrl)}</div>
        ${frameLabel("On the renter's phone", pLeft + 10, pTop - 50)}
        <div class="abs" style="left:${pLeft}px;top:${pTop}px">${phoneFrame(r, phoneCrop, screen)}</div>
        ${footer(liveSource)}
      `),
    });
  }

  // ── 8. Disputes (demo stand-in; the sandbox cases are in docs/paypal-sandbox-notes.md) ─
  {
    const d = shot("dispute");
    const panel = anchor(d, "panel");
    const open = anchor(d, "open");
    const crop: Crop = { x: panel.x, y: panel.y - 10, w: panel.w, h: open.y + 100 - (panel.y - 10) };
    const pdf = shot("evidence-page");
    const pdfW = 660;
    const pdfH = Math.round((pdf.height / pdf.width) * pdfW);
    const bw = 840;
    const bLeft = 860;
    const bTop = 170;
    const pdfLeft = RIGHT - pdfW;
    const pdfTop = BOTTOM - pdfH - 10;
    slides.push({
      file: "08-disputes.png",
      title: "Disputes: answer PayPal with a one-page evidence pack",
      caption:
        "When a renter disputes a charge in PayPal, the rental gets a dispute desk with advice from the record and PayPal's dispute fee, and code builds a one-page evidence PDF: both photos with their SHA-256, what the renter accepted, the PayPal ids and the audit chain. Shown in demo mode with the PayPal stand-in; in the sandbox the counter answered two real buyer cases the same way (PP-R-HKL-10190228, PP-R-XKA-10190233).",
      html: pageHtml(`
        ${textColumn(
          680,
          "After settling · <b>Disputes</b>",
          "Answer a PayPal dispute from the record",
          "The desk advises from the record and PayPal's fee. Code builds a <strong>one-page evidence PDF</strong>: both photos with their SHA-256, the renter's answers, PayPal ids and the audit chain.",
          `<div class="chips">${chip("sandbox case", "PP-R-HKL-10190228")}${chip("sandbox case", "PP-R-XKA-10190233")}</div>`,
        )}
        ${frameLabel("The dispute desk", bLeft + 4, bTop - 50)}
        <div class="abs" style="left:${bLeft}px;top:${bTop}px">${browserFrame(d, crop, bw, `${demoHost}/shop/rentals/${fact("demoDisputeRentalId")}`)}</div>
        ${frameLabel("The evidence PDF", pdfLeft + 4, pdfTop - 50)}
        <div class="abs" style="left:${pdfLeft}px;top:${pdfTop}px;box-shadow:0 50px 100px -30px rgb(29 27 47 / .45);border:2px solid ${C.lineStrong};border-radius:8px;overflow:hidden;background:#fff">
          <img src="../raw/${pdf.file}" style="display:block;width:${pdfW - 4}px" alt="">
        </div>
        ${footer(`${demoSource} · the two sandbox cases: docs/paypal-sandbox-notes.md`)}
      `),
    });
  }

  // ── 9. Schedule (demo) ─────────────────────────────────────────────────────
  {
    const s = shot("schedule");
    const tl = anchor(s, "timeline");
    const pr = anchor(s, "proposals");
    const legend = s.anchors.legend;
    const top = Math.min(tl.y, pr.y) - 16;
    const bottom = Math.max(tl.y + tl.h, legend ? legend.y + legend.h : 0) + 16;
    const crop: Crop = { x: tl.x - 8, y: top, w: pr.x + pr.w + 16 - (tl.x - 8), h: Math.min(s.height, bottom) - top };
    const w = wideFrameWidth(crop);
    slides.push({
      file: "09-schedule.png",
      title: "Schedule: a damaged return re-plans the units",
      caption:
        "Every booking gets a physical unit on a Bryntum Scheduler timeline. When a return is settled with damage, the unit is blocked for its repair and an agent suggests a fix for each booking that now clashes: another unit, later dates, or a call. Staff approve each one, and the server checks every move. Demo mode with sample bookings; the faint pattern is the Bryntum trial watermark.",
      html: pageHtml(`
        ${headerBlock(
          "Running the shop · <b>Schedule</b>",
          "A damaged return re-plans the schedule",
          "A charged repair blocks the unit on the Bryntum timeline. An agent suggests a fix for each clash, like <strong>moving Priya to Projector B</strong> (the dashed bar); staff approve, and the server checks every move.",
        )}
        <div class="abs" style="left:${Math.round((2400 - w) / 2)}px;top:${B_TOP}px">${browserFrame(s, crop, w, `${demoHost}/shop/schedule`)}</div>
        ${footer(`${demoSource} · Bryntum trial watermark`)}
      `),
    });
  }

  // ── 10. Owner's dashboard (demo) ───────────────────────────────────────────
  {
    const s = shot("insights");
    const head = anchor(s, "heading");
    const clock = anchor(s, "clock");
    const cropTop = head.y + 200;
    const crop: Crop = { x: 0, y: cropTop, w: s.width, h: Math.min(s.height, clock.y + clock.h + 24) - cropTop };
    const w = wideFrameWidth(crop);
    slides.push({
      file: "10-dashboard.png",
      title: "Dashboard: where every deposit dollar went",
      caption:
        "The owner's dashboard, built with AG Studio: what was held, kept, released and refunded from every PayPal movement, open disputes, and each running hold on PayPal's 29-day clock with the 72-hour honor period we measured in the sandbox. A deposit-desk agent answers from the record and drafts refunds that a person sends. Demo mode with six weeks of sample rentals.",
      html: pageHtml(`
        ${headerBlock(
          "Running the shop · <b>Dashboard</b>",
          "See where every deposit dollar went",
          "Built with AG Studio: kept, released and refunded money from every PayPal movement, and each hold on PayPal's <strong>29-day clock</strong>, with the <strong>72-hour</strong> honor period we measured in the sandbox.",
        )}
        <div class="abs" style="left:${Math.round((2400 - w) / 2)}px;top:${B_TOP}px">${browserFrame(s, crop, w, `${demoHost}/shop/insights`)}</div>
        ${footer(demoSource)}
      `),
    });
  }

  // ── 11. Architecture (README.md: How we use PayPal, How we use AI; render.yaml) ─
  slides.push({
    file: "11-architecture.png",
    title: "How it fits together",
    caption:
      "A Next.js app on Render (web service, Render Workflows for photo checks and hold renewals, Postgres, an hourly cron job). PayPal: the JS SDK v6 button, Orders v2 with Vault, Payments v2 capture, void, reauthorize and refund, Disputes v1 and verified webhooks. Gemini: two independent looks with schema-checked output; code applies the price list and the agreement rule. Assistants book over MCP under a deposit mandate and cannot move money.",
    html: architecture(),
  });

  // ── 12. Eval (eval/README.md, eval/headline.json) ───────────────────────────
  slides.push({
    file: "12-eval.png",
    title: "Trust numbers: two looks charged nothing unchanged",
    caption:
      "From eval/README.md: gemini-3.8-flash with two looks that must agree (prompt v2, what the app sends), 3 runs per set. Synthetic set (36 AI-generated pairs): 0 of 72 unchanged checks charged, 41 of 42 real changes charged, all at the right price. Real-photo set (55 pairs on 11 real photos, with the damage drawn in by an image model): 0 of 99 and 63 of 66. Uncharged notes still reached staff on 6 of 99 unchanged real-photo checks.",
    html: evalSlide(),
  });

  // ── Thumbnail (Devpost: 3:2, JPG/PNG/GIF, 5 MB max) ─────────────────────────
  slides.push({
    file: "thumbnail.png",
    title: "Project thumbnail",
    caption: "Handback: rental deposits that settle themselves, fairly. On a $150.00 PayPal deposit: $12.00 kept, $138.00 released.",
    html: thumbnail(),
  });

  return slides;
}

function architecture(): string {
  const item = (l: string) => `<li style="font-size:28px;line-height:1.32;color:${C.inkSoft};margin-top:10px">${l}</li>`;
  const box = (x: number, y: number, w: number, h: number, title: string, lines: string[], tone: { bg: string; border: string }) => `
    <div class="abs" style="left:${x}px;top:${y}px;width:${w}px;height:${h}px;background:${tone.bg};border:2px solid ${tone.border};border-radius:26px;padding:28px 32px">
      <div class="display" style="font-size:40px;font-weight:700;letter-spacing:-0.02em">${title}</div>
      <ul style="margin:10px 0 0;padding:0;list-style:none">${lines.map(item).join("")}</ul>
    </div>`;
  const white = { bg: C.card, border: C.line };
  const arrow = (x1: number, y: number, x2: number) => `<line x1="${x1}" y1="${y}" x2="${x2}" y2="${y}" stroke="${C.muted}" stroke-width="4" marker-end="url(#a)"/>`;
  const both = (x1: number, y: number, x2: number) => `<line x1="${x1 + 8}" y1="${y}" x2="${x2 - 8}" y2="${y}" stroke="${C.muted}" stroke-width="4" marker-start="url(#s)" marker-end="url(#a)"/>`;
  const sha = `<span style="white-space:nowrap">SHA-256</span>`;
  const inner = [
    ["Deposit mandate", "The most it may hold, the price list and an end date, hashed into the audit chain and checked before every hold and charge"],
    ["Price list and agreement rule", "Code turns findings into charges: only from the shop's list, only when both looks agree"],
    ["Hash-chained audit log", `Every step with its PayPal ids; photos stored under their ${sha}`],
    ["Agents that propose, never act", "Schedule fixes (Bryntum) and the deposit desk (AG Studio) wait for a person"],
  ];
  return pageHtml(`
    <div class="abs" style="left:120px;top:110px;width:2160px">
      <div class="eyebrow">Under the hood</div>
      <h1 style="font-size:88px;margin-top:20px">How Handback fits together</h1>
    </div>
    <svg class="abs" style="left:0;top:0" width="2400" height="1600">
      <defs>
        <marker id="a" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto"><path d="M0 0L10 5L0 10z" fill="${C.muted}"/></marker>
        <marker id="s" viewBox="0 0 10 10" refX="1" refY="5" markerWidth="6" markerHeight="6" orient="auto"><path d="M10 0L0 5L10 10z" fill="${C.muted}"/></marker>
      </defs>
      ${arrow(600, 455, 768)}
      ${arrow(600, 760, 768)}
      ${arrow(600, 1075, 768)}
      ${both(1592, 560, 1700)}
      ${both(1592, 1150, 1700)}
    </svg>
    ${box(120, 330, 480, 260, "Renter's phone", ["Books with the PayPal button", "Confirms the pickup photo", "Accepts or questions charges"], white)}
    ${box(120, 630, 480, 260, "Counter", ["Photos, one-tap hold, settle", "Refunds and the dispute desk", "Schedule and dashboard"], white)}
    ${box(120, 930, 480, 290, "AI assistant", ["Books over MCP under a deposit mandate", "Cannot approve, hold, settle or refund"], white)}
    <div class="abs" style="left:770px;top:330px;width:822px;height:1110px;background:${C.brandSoft};border:2px solid #d6d2fa;border-radius:32px;padding:30px 34px">
      <div class="display" style="font-size:42px;font-weight:700;letter-spacing:-0.02em;color:${C.brandInk}">Handback · Next.js app</div>
      <div style="font-size:27px;color:${C.inkSoft};margin-top:6px">Amounts set on the server; people make every decision</div>
      ${inner
        .map(
          ([t, d]) =>
            `<div style="background:${C.card};border:2px solid ${C.line};border-radius:20px;padding:18px 24px;margin-top:18px"><div style="font-size:30px;font-weight:600">${t}</div><div style="font-size:25px;line-height:1.35;color:${C.inkSoft};margin-top:6px">${d}</div></div>`,
        )
        .join("")}
      <div style="position:absolute;left:34px;right:34px;bottom:30px;background:${C.ink};color:#fff;border-radius:20px;padding:20px 24px">
        <div style="font-size:30px;font-weight:600">On Render</div>
        <div style="font-size:25px;line-height:1.35;color:#d9d7f5;margin-top:6px">Web service · Workflows (photo checks, hold renewals) · Postgres · hourly cron</div>
      </div>
    </div>
    ${box(1700, 330, 580, 610, "PayPal", ["JS SDK v6 button that saves PayPal", "Orders v2 + Vault: the fee, then the deposit hold on the saved wallet", "Payments v2: capture, void, reauthorize, refund", "Disputes v1: evidence, accept, offer", "Webhooks, verified and applied once", "A request id on every order and payment call"], { bg: C.heldSoft, border: "#f0dcb4" })}
    ${box(1700, 980, 580, 460, "Gemini", ["Two independent looks at both photos", "Schema-checked JSON: boxes and a price-list id, never an amount", "Run as a Render Workflows task"], { bg: C.releasedSoft, border: "#c4e3d1" })}
    ${footer("README.md: How we use PayPal, How we use AI · render.yaml")}
  `);
}

function evalSlide(): string {
  // eval/README.md, Results: gemini-3.8-flash, thinking low, 2 looks, prompt v2, 3 runs per set.
  const sets = [
    { name: "Synthetic set", sub: "36 AI-generated pairs · 3 runs", unchanged: [0, 72], changes: [41, 42], right: 41 },
    { name: "Real-photo set", sub: "55 pairs on 11 real photos · 3 runs", unchanged: [0, 99], changes: [63, 66], right: 63 },
  ];
  const meter = (n: number, d: number, color: string) =>
    `<div style="height:24px;border-radius:12px;background:${C.line};margin-top:26px;overflow:hidden">${n > 0 ? `<div style="height:100%;width:${((n / d) * 100).toFixed(2)}%;background:${color};border-radius:12px"></div>` : ""}</div>`;
  const stat = (n: number, d: number, label: string, color: string) => `
    <div class="display" style="font-size:170px;font-weight:700;letter-spacing:-0.045em;line-height:1">${n}<span style="font-size:68px;color:${C.muted};letter-spacing:-0.02em;margin-left:20px">of ${d}</span></div>
    <div style="font-size:34px;color:${C.inkSoft};margin-top:14px">${label}</div>
    ${meter(n, d, color)}`;
  const panel = (s: (typeof sets)[number]) => `
    <div style="background:${C.card};border:2px solid ${C.line};border-radius:30px;padding:56px 56px 64px;width:720px">
      <div class="display" style="font-size:46px;font-weight:700;letter-spacing:-0.02em">${s.name}</div>
      <div style="font-size:29px;color:${C.muted};margin-top:8px">${s.sub}</div>
      <div style="margin-top:70px">${stat(s.unchanged[0], s.unchanged[1], "unchanged-item checks charged", C.charged)}</div>
      <div style="margin-top:90px">${stat(s.changes[0], s.changes[1], `real changes charged, all ${s.right} at the right price`, C.released)}</div>
    </div>`;
  return pageHtml(`
    ${textColumn(
      640,
      "Trust numbers",
      "Two looks charged nothing unchanged",
      "Two Gemini looks must agree before a charge is proposed. That costs a little recall and, in every run, kept items that did not change off the bill.",
    )}
    <div class="abs" style="left:${RIGHT - 1480}px;top:120px;width:1480px;display:flex;flex-direction:column;gap:44px">
    <div style="display:flex;gap:40px">${sets.map(panel).join("")}</div>
    <div style="font-size:27px;line-height:1.42;color:${C.muted}">
      gemini-3.8-flash, thinking low, two looks, prompt v2 (what the app sends). A check is one pair in one run: 24 and 33 unchanged pairs × 3 runs. The synthetic photos are AI-generated; in the real-photo set an image model drew each change into a real photo, which may make it easier to find. Unchanged real-photo pairs still drew an uncharged note in 6 of 99 checks.
    </div>
    </div>
    ${footer("eval/README.md · eval/headline.json")}
  `);
}

function thumbnail(): string {
  return pageHtml(`
    <div class="abs" style="left:150px;top:190px;width:2100px">
      <div class="brandmark" style="font-size:120px;gap:44px">${logoMark(170)}Handback</div>
      <h1 style="font-size:156px;margin-top:80px;line-height:1">Rental deposits that settle themselves, fairly</h1>
    </div>
    <div class="abs" style="left:150px;top:980px;width:2100px">
      <div style="display:flex;gap:18px;height:88px">
        <div style="width:8%;background:${C.charged};border-radius:44px"></div>
        <div style="flex:1;background:${C.released};border-radius:44px"></div>
      </div>
      <div class="display" style="display:flex;gap:90px;margin-top:44px;font-size:84px;font-weight:700;letter-spacing:-0.025em">
        <span><span style="color:${C.charged}">$12</span> kept</span>
        <span><span style="color:${C.released}">$138</span> released</span>
        <span style="color:${C.muted};font-weight:600">of a $150 PayPal deposit</span>
      </div>
    </div>
  `);
}
