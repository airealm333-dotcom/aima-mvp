/**
 * Read OCR text (e.g. from `npm run ocr-pdf`) and use Claude to extract
 * clients / UEN / document type / page range as JSON.
 *
 * Usage:
 *   npm run extract-ocr-clients -- [path/to.txt] [--out=result.json]
 *
 * Default input path: out.txt (repo root). Loads `.env.local` when env vars are unset.
 *
 * Core logic lives in `src/lib/ocr-client-extract.ts` (shared with `/api/ocr-clients`).
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { extractOcrClientRowsFromDocumentText } from "../src/lib/ocr-client-extract";

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
  let outPath: string | null = null;

  for (let i = 2; i < argv.length; i += 1) {
    const a = argv[i];
    if (a.startsWith("--out=")) outPath = a.slice("--out=".length);
    else if (!a.startsWith("-")) positional.push(a);
  }

  return { positional, outPath };
}

async function main() {
  loadEnvLocal();

  if (!process.env.ANTHROPIC_API_KEY?.trim()) {
    console.error("Missing ANTHROPIC_API_KEY (set in env or .env.local).");
    process.exit(1);
  }

  const { positional, outPath } = parseArgs(process.argv);
  const inputPath = resolve(process.cwd(), positional[0] ?? "out.txt");

  if (!existsSync(inputPath)) {
    console.error(`File not found: ${inputPath}`);
    process.exit(1);
  }

  const documentText = readFileSync(inputPath, "utf8");
  if (!documentText.trim()) {
    console.error("Input file is empty.");
    process.exit(1);
  }

  let rows: Awaited<ReturnType<typeof extractOcrClientRowsFromDocumentText>>;
  try {
    rows = await extractOcrClientRowsFromDocumentText(documentText);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("Extraction failed:", msg);
    process.exit(1);
  }

  const jsonOut = JSON.stringify(rows, null, 2);

  if (outPath) {
    const absOut = resolve(process.cwd(), outPath);
    writeFileSync(absOut, `${jsonOut}\n`, "utf8");
    console.error(`Wrote ${rows.items.length} row(s) to ${absOut}`);
  }

  console.log(jsonOut);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
