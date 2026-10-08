/**
 * Renders each slide's HTML in Chromium at 2400x1600, writes the numbered
 * images and captions.md, and keeps every file under Devpost's 5 MB limit
 * (a PNG that is too large is written as a JPEG instead).
 */
import { existsSync, mkdirSync, readdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { chromium, type Browser } from "@playwright/test";
import sharp from "sharp";
import { H, W } from "./frames";
import { log, writeManifest, type Manifest } from "./shots";
import { buildSlides } from "./slides";

/** Devpost: "JPG, PNG or GIF format, 5 MB max file size"; leave some room. */
const MAX_BYTES = 4.5 * 1024 * 1024;
const PDFJS = "https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38";

/** Page 1 of the evidence PDF as a PNG, drawn by pdf.js (headless Chromium has no PDF viewer). */
async function renderEvidencePdf(browser: Browser, rawDir: string, manifest: Manifest) {
  const pdfFile = path.join(rawDir, "evidence.pdf");
  const pngFile = path.join(rawDir, "evidence-page.png");
  if (!existsSync(pdfFile)) throw new Error("raw/evidence.pdf is missing; run the demo capture first");
  if (existsSync(pngFile) && statSync(pngFile).mtimeMs > statSync(pdfFile).mtimeMs && manifest.shots["evidence-page"]) return;
  const page = await browser.newPage({ viewport: { width: 1900, height: 2500 } });
  try {
    await page.setContent("<!doctype html><body style='margin:0;background:#fff'><canvas></canvas></body>");
    const b64 = (await readFile(pdfFile)).toString("base64");
    // Plain JavaScript: a dynamic import written in TypeScript could be compiled into a require().
    const size = (await page.evaluate(`(async ({ b64, base }) => {
      const pdfjs = await import(base + "/build/pdf.min.mjs");
      pdfjs.GlobalWorkerOptions.workerSrc = base + "/build/pdf.worker.min.mjs";
      const data = Uint8Array.from(atob(b64), (ch) => ch.charCodeAt(0));
      const doc = await pdfjs.getDocument({ data, standardFontDataUrl: base + "/standard_fonts/" }).promise;
      const first = await doc.getPage(1);
      const viewport = first.getViewport({ scale: 3 });
      const canvas = document.querySelector("canvas");
      canvas.width = viewport.width;
      canvas.height = viewport.height;
      await first.render({ canvasContext: canvas.getContext("2d"), viewport }).promise;
      return { w: viewport.width, h: viewport.height, pages: doc.numPages };
    })(${JSON.stringify({ b64, base: PDFJS })})`)) as { w: number; h: number; pages: number };
    if (size.pages !== 1) log(`  the evidence PDF has ${size.pages} pages; showing the first`);
    await page.locator("canvas").screenshot({ path: pngFile });
    manifest.shots["evidence-page"] = { file: "evidence-page.png", width: size.w, height: size.h, scale: 1, anchors: {} };
    writeManifest(path.join(rawDir, "manifest.json"), manifest);
    log(`  evidence PDF page 1 drawn (${size.w}x${size.h})`);
  } finally {
    await page.close();
  }
}

export async function compose(out: string, manifest: Manifest) {
  const rawDir = path.join(out, "raw");
  const buildDir = path.join(out, "build");
  mkdirSync(buildDir, { recursive: true });
  const browser = await chromium.launch();
  try {
    await renderEvidencePdf(browser, rawDir, manifest);
    const slides = buildSlides(manifest);
    const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
    const written: { file: string; title: string; caption: string; bytes: number }[] = [];
    for (const slide of slides) {
      const htmlFile = path.join(buildDir, slide.file.replace(/\.png$/, ".html"));
      writeFileSync(htmlFile, slide.html);
      await page.goto(pathToFileURL(htmlFile).href, { waitUntil: "networkidle" });
      const fontsOk = await page.evaluate(async () => {
        await document.fonts.ready;
        await Promise.all(Array.from(document.images).map((img) => (img.complete ? null : new Promise((r) => ((img.onload = r), (img.onerror = r))))));
        const broken = Array.from(document.images).filter((img) => !img.naturalWidth).map((img) => img.getAttribute("src"));
        // load() fetches a face even where a slide does not use it, and returns none when the font is missing.
        return {
          display: (await document.fonts.load('700 96px "Bricolage Grotesque"')).length > 0,
          sans: (await document.fonts.load('400 38px "Geist"')).length > 0,
          broken,
        };
      });
      if (!fontsOk.display || !fontsOk.sans) throw new Error(`${slide.file}: the web fonts did not load (Google Fonts unreachable?)`);
      if (fontsOk.broken.length) throw new Error(`${slide.file}: images did not load: ${fontsOk.broken.join(", ")}`);
      const png = await page.screenshot({ type: "png" });
      let file = slide.file;
      let bytes = await sharp(png).png({ compressionLevel: 9, effort: 10 }).toBuffer();
      if (bytes.length > MAX_BYTES) {
        file = slide.file.replace(/\.png$/, ".jpg");
        bytes = await sharp(png).jpeg({ quality: 90, mozjpeg: true }).toBuffer();
      }
      // A stale file of the other format would be uploaded by mistake.
      for (const old of [slide.file, slide.file.replace(/\.png$/, ".jpg")]) if (old !== file && existsSync(path.join(out, old))) unlinkSync(path.join(out, old));
      writeFileSync(path.join(out, file), bytes);
      written.push({ file, title: slide.title, caption: slide.caption, bytes: bytes.length });
      log(`  ${file}  ${(bytes.length / 1024 / 1024).toFixed(2)} MB`);
    }
    const gallery = written.filter((w) => !w.file.startsWith("thumbnail"));
    const thumb = written.find((w) => w.file.startsWith("thumbnail"));
    const md = [
      "# Devpost gallery",
      "",
      `Generated by \`scripts/gallery/generate.ts\` on ${new Date().toISOString().slice(0, 10)}. ${W}x${H} (3:2), each under 5 MB. Upload in this order; paste each caption into Devpost's caption field.`,
      "",
      ...gallery.flatMap((w, i) => [`## ${i + 1}. ${w.title}`, "", `File: \`${w.file}\``, "", w.caption, ""]),
      ...(thumb ? ["## Thumbnail", "", `File: \`${thumb.file}\` (Devpost's project thumbnail: 3:2, JPG, PNG or GIF, 5 MB max)`, "", thumb.caption, ""] : []),
      "## PayPal sandbox ids from this run",
      "",
      ...Object.entries(manifest.facts)
        .filter(([k, v]) => (/^live.*Id$/.test(k) || k === "liveRentalsLooksDisagreed" || k === "liveStrip") && v)
        .map(([k, v]) => `- ${k}: \`${v}\``),
      "",
    ].join("\n");
    writeFileSync(path.join(out, "captions.md"), md);
    const unexpected = readdirSync(out).filter((f) => /\.(png|jpg)$/.test(f) && !written.some((w) => w.file === f));
    if (unexpected.length) log(`  other images in ${out} (not from this run): ${unexpected.join(", ")}`);
    log(`wrote ${written.length} images and captions.md to ${out}`);
  } finally {
    await browser.close();
  }
}
