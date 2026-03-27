import { Storage } from "@google-cloud/storage";
import vision from "@google-cloud/vision";
import { PDFParse } from "pdf-parse";

type ImageAnnotatorClient = InstanceType<typeof vision.ImageAnnotatorClient>;
type StorageClient = InstanceType<typeof Storage>;
type VisionCredentials = {
  client_email: string;
  private_key: string;
  project_id?: string;
};

export type OcrResult = {
  text: string;
  pageCount: number;
  textLength: number;
  provider: "google-vision" | "pdf-parse";
};

function isVisionStrictMode() {
  return process.env.GOOGLE_VISION_STRICT === "true";
}

function normalizeContentType(contentType: string) {
  return contentType.split(";")[0]?.trim().toLowerCase() || "";
}

function getVisionCredentials(): VisionCredentials | null {
  const credentialsJson = process.env.GOOGLE_VISION_CREDENTIALS_JSON;
  if (!credentialsJson) {
    if (isVisionStrictMode()) {
      throw new Error(
        "Google Vision strict mode is enabled but GOOGLE_VISION_CREDENTIALS_JSON is missing.",
      );
    }
    return null;
  }

  try {
    return JSON.parse(credentialsJson) as VisionCredentials;
  } catch {
    if (isVisionStrictMode()) {
      throw new Error(
        "Google Vision strict mode is enabled but GOOGLE_VISION_CREDENTIALS_JSON is invalid JSON.",
      );
    }
    return null;
  }
}

function getVisionClient() {
  const credentials = getVisionCredentials();
  if (!credentials) return null;
  return new vision.ImageAnnotatorClient({ credentials });
}

function getStorageClient(): StorageClient | null {
  const credentials = getVisionCredentials();
  if (!credentials) return null;
  return new Storage({ credentials, projectId: credentials.project_id });
}

function getVisionGcsConfig() {
  const inputBucket = process.env.GOOGLE_VISION_GCS_INPUT_BUCKET?.trim();
  const outputBucket = process.env.GOOGLE_VISION_GCS_OUTPUT_BUCKET?.trim();
  const prefixBase =
    process.env.GOOGLE_VISION_GCS_PREFIX?.trim() || "vision-ocr";

  if (!inputBucket || !outputBucket) {
    if (isVisionStrictMode()) {
      throw new Error(
        "Google Vision strict mode is enabled but GOOGLE_VISION_GCS_INPUT_BUCKET or GOOGLE_VISION_GCS_OUTPUT_BUCKET is missing.",
      );
    }
    return null;
  }

  return { inputBucket, outputBucket, prefixBase };
}

function randomKeyPart() {
  return Math.random().toString(36).slice(2, 10);
}

async function parseVisionAsyncOutputJson(buffer: Buffer): Promise<string[]> {
  const parsed = JSON.parse(buffer.toString("utf-8")) as {
    responses?: Array<{ fullTextAnnotation?: { text?: string } }>;
  };
  const responses = parsed.responses ?? [];
  const pages: string[] = [];
  for (const response of responses) {
    const text = response.fullTextAnnotation?.text?.trim();
    if (text) pages.push(text);
  }
  return pages;
}

async function extractPdfWithGoogleVision(
  client: ImageAnnotatorClient,
  buffer: Buffer,
): Promise<{ text: string; pageCount: number } | null> {
  const storage = getStorageClient();
  const gcsConfig = getVisionGcsConfig();
  if (!storage || !gcsConfig) return null;

  // #region agent log
  fetch("http://127.0.0.1:7413/ingest/554872b6-b526-4f4b-85dd-aaf0b37e62cd", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Debug-Session-Id": "392735",
    },
    body: JSON.stringify({
      sessionId: "392735",
      runId: "pre-fix",
      hypothesisId: "H1",
      location: "src/lib/ocr.ts:extractPdfWithGoogleVision:entry",
      message: "Starting async Vision OCR upload flow",
      data: {
        inputBucket: gcsConfig.inputBucket,
        outputBucket: gcsConfig.outputBucket,
        prefixBase: gcsConfig.prefixBase,
        bufferBytes: buffer.length,
      },
      timestamp: Date.now(),
    }),
  }).catch(() => {});
  // #endregion

  const inputObjectPath = `${gcsConfig.prefixBase}/input/${Date.now()}-${randomKeyPart()}.pdf`;
  const outputPrefix = `${gcsConfig.prefixBase}/output/${Date.now()}-${randomKeyPart()}`;
  const outputUri = `gs://${gcsConfig.outputBucket}/${outputPrefix}/`;

  const inputFile = storage.bucket(gcsConfig.inputBucket).file(inputObjectPath);
  await inputFile.save(buffer, {
    resumable: false,
    contentType: "application/pdf",
  });

  // #region agent log
  fetch("http://127.0.0.1:7413/ingest/554872b6-b526-4f4b-85dd-aaf0b37e62cd", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Debug-Session-Id": "392735",
    },
    body: JSON.stringify({
      sessionId: "392735",
      runId: "pre-fix",
      hypothesisId: "H1",
      location: "src/lib/ocr.ts:extractPdfWithGoogleVision:afterInputSave",
      message: "Uploaded PDF to input bucket",
      data: {
        inputObjectPath,
      },
      timestamp: Date.now(),
    }),
  }).catch(() => {});
  // #endregion

  try {
    const [operation] = await client.asyncBatchAnnotateFiles({
      requests: [
        {
          inputConfig: {
            gcsSource: {
              uri: `gs://${gcsConfig.inputBucket}/${inputObjectPath}`,
            },
            mimeType: "application/pdf",
          },
          features: [{ type: "DOCUMENT_TEXT_DETECTION" }],
          outputConfig: {
            gcsDestination: { uri: outputUri },
            batchSize: 5,
          },
        },
      ],
    });

    await operation.promise();

    const [outputFiles] = await storage
      .bucket(gcsConfig.outputBucket)
      .getFiles({ prefix: `${outputPrefix}/` });
    const sortedFiles = outputFiles.sort((a, b) =>
      a.name.localeCompare(b.name),
    );

    // #region agent log
    fetch("http://127.0.0.1:7413/ingest/554872b6-b526-4f4b-85dd-aaf0b37e62cd", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Debug-Session-Id": "392735",
      },
      body: JSON.stringify({
        sessionId: "392735",
        runId: "pre-fix",
        hypothesisId: "H2",
        location: "src/lib/ocr.ts:extractPdfWithGoogleVision:afterOutputList",
        message: "Listed Vision OCR output objects",
        data: {
          outputPrefix,
          outputFileCount: sortedFiles.length,
          outputJsonCount: sortedFiles.filter((f) => f.name.endsWith(".json"))
            .length,
        },
        timestamp: Date.now(),
      }),
    }).catch(() => {});
    // #endregion

    const pageTexts: string[] = [];
    for (const file of sortedFiles) {
      if (!file.name.endsWith(".json")) continue;
      const [content] = await file.download();
      const pages = await parseVisionAsyncOutputJson(content);
      pageTexts.push(...pages);
    }

    if (pageTexts.length === 0) return null;
    return { text: pageTexts.join("\n\n"), pageCount: pageTexts.length };
  } finally {
    await inputFile.delete({ ignoreNotFound: true }).catch(() => undefined);
  }
}

async function extractImageWithGoogleVision(
  client: ImageAnnotatorClient,
  buffer: Buffer,
): Promise<{ text: string; pageCount: number } | null> {
  const [result] = await client.documentTextDetection({
    image: { content: buffer },
  });

  const text = result.fullTextAnnotation?.text?.trim() ?? "";
  if (!text) return null;
  return { text, pageCount: 1 };
}

async function extractWithGoogleVision(
  buffer: Buffer,
  contentType: string,
): Promise<{ text: string; pageCount: number } | null> {
  const client = getVisionClient();
  if (!client) return null;

  try {
    if (contentType === "application/pdf") {
      return await extractPdfWithGoogleVision(client, buffer);
    }
    return await extractImageWithGoogleVision(client, buffer);
  } catch (error) {
    // #region agent log
    fetch("http://127.0.0.1:7413/ingest/554872b6-b526-4f4b-85dd-aaf0b37e62cd", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Debug-Session-Id": "392735",
      },
      body: JSON.stringify({
        sessionId: "392735",
        runId: "pre-fix",
        hypothesisId: "H3",
        location: "src/lib/ocr.ts:extractWithGoogleVision:catch",
        message: "Google Vision OCR threw exception",
        data: {
          contentType,
          error:
            error instanceof Error
              ? error.message
              : "Unknown Google Vision error",
          strictMode: isVisionStrictMode(),
        },
        timestamp: Date.now(),
      }),
    }).catch(() => {});
    // #endregion
    if (isVisionStrictMode()) {
      const detail =
        error instanceof Error ? error.message : "Unknown Google Vision error";
      throw new Error(
        `Google Vision OCR failed while strict mode is enabled. contentType=${contentType} detail=${detail}`,
      );
    }
    return null;
  }
}

export async function extractPdfText(
  fileBuffer: Buffer,
  contentType = "application/pdf",
): Promise<OcrResult> {
  const normalizedContentType = normalizeContentType(contentType);

  const visionResult = await extractWithGoogleVision(
    fileBuffer,
    normalizedContentType,
  );
  if (visionResult) {
    return {
      text: visionResult.text,
      pageCount: visionResult.pageCount,
      textLength: visionResult.text.length,
      provider: "google-vision",
    };
  }

  if (normalizedContentType !== "application/pdf") {
    const visionConfigured = Boolean(
      process.env.GOOGLE_VISION_CREDENTIALS_JSON,
    );
    throw new Error(
      [
        "Google Vision OCR returned no text for this image format.",
        `rawContentType=${contentType}`,
        `normalizedContentType=${normalizedContentType}`,
        `visionStrict=${process.env.GOOGLE_VISION_STRICT === "true"}`,
        `visionConfigured=${visionConfigured}`,
      ].join(" "),
    );
  }

  // Last-resort fallback for PDFs only when Vision is not strict.
  const parser = new PDFParse({ data: fileBuffer });
  const parsed = await parser.getText();
  const text = (parsed.text ?? "").trim();
  await parser.destroy();

  return {
    text,
    pageCount: parsed.total ?? 0,
    textLength: text.length,
    provider: "pdf-parse",
  };
}
