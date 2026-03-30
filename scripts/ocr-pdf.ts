/**
 * Run OCR on a local PDF using the same pipeline as the app (`extractPdfText`).
 * Page labels use the PDF’s real page count (pdf-lib) and match file order:
 * `=== PDF page i / n ===` then OCR text for that page.
 *
 * Usage:
 *   npm run ocr-pdf -- <path-to.pdf> [--json] [--text-only] [--out=path.txt] [--pages-dir=folder]
 *
 * `--pages-dir=./out-pages` writes `page-001.txt` … `page-nnn.txt` (one file per PDF page).
 *
 * Loads `.env.local` from the repo root when vars are not already set (Vision buckets + credentials).
 *
 * Uses Vision's flat `fullTextAnnotation.text` per page by default (most stable).
 * Set `GOOGLE_VISION_LAYOUT_TEXT=true` only to experiment with geometry-based reordering.
 *
 * OCR text will not look identical to the PDF visually (columns, tables, fonts) — only text extraction.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { extractPdfText } from "../src/lib/ocr";

function loadEnvLocal() {
  const p = resolve(process.cwd(), ".env.local");
  if (!existsSync(p)) return;
  const raw = readFileSync(p, "utf8");
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let val = trimmed.slice(eq + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    if (process.env[key] === undefined) {
      process.env[key] = val;
    }
  }
}

function parseArgs(argv: string[]) {
  const positional: string[] = [];
  let json = false;
  let textOnly = false;
  let outPath: string | null = null;
  let pagesDir: string | null = null;

  for (let i = 2; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--json") json = true;
    else if (a === "--text-only") textOnly = true;
    else if (a.startsWith("--out=")) outPath = a.slice("--out=".length);
    else if (a.startsWith("--pages-dir="))
      pagesDir = a.slice("--pages-dir=".length);
    else if (!a.startsWith("-")) positional.push(a);
  }

  return { positional, json, textOnly, outPath, pagesDir };
}

async function main() {
  loadEnvLocal();

  const { positional, json, textOnly, outPath, pagesDir } = parseArgs(
    process.argv,
  );
  const pdfPath = positional[0];

  if (!pdfPath) {
    console.error(
      "Usage: npm run ocr-pdf -- <path-to.pdf> [--json] [--text-only] [--out=path.txt] [--pages-dir=folder]",
    );
    process.exit(1);
  }

  const abs = resolve(process.cwd(), pdfPath);
  if (!existsSync(abs)) {
    console.error(`File not found: ${abs}`);
    process.exit(1);
  }

  const buffer = readFileSync(abs);
  const started = Date.now();

  let result: Awaited<ReturnType<typeof extractPdfText>>;
  try {
    result = await extractPdfText(buffer, "application/pdf", {
      labelPdfPages: true,
      returnPages: Boolean(pagesDir),
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("OCR failed:", msg);
    process.exit(1);
  }

  const elapsedMs = Date.now() - started;

  if (result.pageAlignment) {
    console.error(
      "Warning: OCR segment count differed from PDF page count (aligned to PDF):",
      JSON.stringify(result.pageAlignment),
    );
  }

  if (pagesDir && result.pages) {
    const dir = resolve(process.cwd(), pagesDir);
    mkdirSync(dir, { recursive: true });
    const total = result.pageCount;
    for (let i = 0; i < result.pages.length; i += 1) {
      const name = `page-${String(i + 1).padStart(3, "0")}.txt`;
      const header = `=== PDF page ${i + 1} / ${total} ===\n`;
      const raw = result.pages[i] ?? "";
      const body = raw.trim().length ? raw : "(no OCR text for this PDF page)";
      writeFileSync(join(dir, name), `${header}${body}\n`, "utf8");
    }
    console.error(`Wrote ${result.pages.length} page file(s) under ${dir}`);
  }

  if (outPath) {
    writeFileSync(resolve(process.cwd(), outPath), result.text, "utf8");
    console.error(`Wrote text to ${outPath} (${result.text.length} chars)`);
  }

  if (textOnly) {
    process.stdout.write(result.text);
    if (!result.text.endsWith("\n")) process.stdout.write("\n");
    return;
  }

  if (json) {
    const payload = {
      file: basename(abs),
      provider: result.provider,
      pageCount: result.pageCount,
      textLength: result.textLength,
      elapsedMs,
      pageAlignment: result.pageAlignment ?? null,
      text: result.text,
      pages: result.pages ?? null,
    };
    console.log(JSON.stringify(payload, null, 2));
    return;
  }

  console.log(`file:          ${basename(abs)}`);
  console.log(`provider:      ${result.provider}`);
  console.log(`pdfPageCount:  ${result.pageCount}`);
  console.log(`textLength:    ${result.textLength}`);
  console.log(`elapsedMs:     ${elapsedMs}`);
  console.log("--- text ---");
  console.log(result.text);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
