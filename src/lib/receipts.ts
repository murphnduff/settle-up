import type { SupabaseClient } from "@supabase/supabase-js";
import { EXPENSE_CATEGORIES } from "./reconciliation.ts";
import { normalizeCurrencyCode } from "./currencies.ts";

export interface ParsedReceiptData {
  description?: string;
  amount?: number;
  currency?: string;
  date?: string;
  category?: string;
  modelUsed?: string;
  durationMs?: number;
}

export interface FastAiReceiptPayload {
  aiBase64: string;
  mimeType: string;
  previewUrl: string;
  isPdf: boolean;
}

export interface StorageReceiptPayload {
  blob: Blob;
  extension: string;
  mimeType: string;
}

export interface CompressedReceiptResult {
  /** Crisp 1600px (0.82 quality) JPEG Blob for Supabase Storage upload */
  blob: Blob;
  /** Compact 800px (0.65 quality) JPEG base64 string for fast AI OCR */
  base64: string;
  /** Explicit alias for the compact 800px (0.65 quality) AI payload */
  aiBase64: string;
  mimeType: string;
  extension: string;
  previewUrl: string;
  isPdf: boolean;
}

const DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Pure normalization helper for Gemini AI receipt extraction output.
 * Ensures valid fields, ISO date format, positive 2-decimal amount, and matched preset/custom category.
 */
export function normalizeParsedReceipt(raw: unknown): ParsedReceiptData {
  if (!raw || typeof raw !== "object") {
    return {};
  }

  const record = raw as Record<string, unknown>;
  const result: ParsedReceiptData = {};

  if (typeof record.description === "string") {
    const cleanDesc = record.description.trim();
    if (cleanDesc.length > 0) {
      result.description = cleanDesc;
    }
  }

  const rawAmount =
    typeof record.amount === "number"
      ? record.amount
      : typeof record.amount === "string"
        ? parseFloat(record.amount.replace(/[^0-9.-]/g, ""))
        : NaN;

  if (!isNaN(rawAmount) && rawAmount > 0) {
    result.amount = Math.round(rawAmount * 100) / 100;
  }

  if (typeof record.currency === "string" && record.currency.trim().length > 0) {
    result.currency = normalizeCurrencyCode(record.currency);
  }

  if (typeof record.date === "string") {
    const cleanDate = record.date.trim().split("T")[0];
    if (DATE_REGEX.test(cleanDate)) {
      const parsedTime = Date.parse(`${cleanDate}T00:00:00Z`);
      if (!isNaN(parsedTime)) {
        result.date = cleanDate;
      }
    }
  }

  if (typeof record.category === "string") {
    const cleanCat = record.category.trim();
    if (cleanCat.length > 0 && cleanCat.toLowerCase() !== "payment") {
      const matchedPreset = EXPENSE_CATEGORIES.find(
        (preset) => preset.toLowerCase() === cleanCat.toLowerCase()
      );
      result.category = matchedPreset || cleanCat;
    }
  }

  if (typeof record.modelUsed === "string" && record.modelUsed.trim()) {
    result.modelUsed = record.modelUsed.trim();
  }

  if (
    typeof record.durationMs === "number" &&
    Number.isFinite(record.durationMs)
  ) {
    result.durationMs = Math.round(record.durationMs);
  }

  return result;
}

export function isPdfReceiptUrl(url?: string | null): boolean {
  if (!url) return false;
  const clean = url.split("?")[0].split("#")[0].toLowerCase();
  return clean.endsWith(".pdf") || url.startsWith("data:application/pdf");
}

function readBlobAsBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = typeof reader.result === "string" ? reader.result : "";
      const commaIdx = dataUrl.indexOf(",");
      resolve(commaIdx >= 0 ? dataUrl.slice(commaIdx + 1) : dataUrl);
    };
    reader.onerror = () =>
      reject(new Error("Failed to read file into base64."));
    reader.readAsDataURL(blob);
  });
}

function loadImageElement(file: File): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const objectUrl = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(objectUrl);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(objectUrl);
      reject(new Error("Failed to decode receipt image."));
    };
    img.src = objectUrl;
  });
}

function renderImageToCanvas(
  img: HTMLImageElement,
  maxDimension: number
): HTMLCanvasElement {
  const origWidth = img.naturalWidth || img.width || 1;
  const origHeight = img.naturalHeight || img.height || 1;

  let targetWidth = origWidth;
  let targetHeight = origHeight;

  const largestSide = Math.max(origWidth, origHeight);
  if (largestSide > maxDimension) {
    const scale = maxDimension / largestSide;
    targetWidth = Math.max(1, Math.round(origWidth * scale));
    targetHeight = Math.max(1, Math.round(origHeight * scale));
  }

  const canvas = document.createElement("canvas");
  canvas.width = targetWidth;
  canvas.height = targetHeight;

  const ctx = canvas.getContext("2d");
  if (!ctx) {
    throw new Error("Browser 2D canvas context is unavailable.");
  }

  // Fill white background so transparent PNGs/WebPs render cleanly as JPEG
  ctx.fillStyle = "#FFFFFF";
  ctx.fillRect(0, 0, targetWidth, targetHeight);
  ctx.drawImage(img, 0, 0, targetWidth, targetHeight);

  return canvas;
}

function renderImageToJpegDataUrl(
  img: HTMLImageElement,
  maxDimension: number,
  quality: number
): string {
  return renderImageToCanvas(img, maxDimension).toDataURL(
    "image/jpeg",
    quality
  );
}

/**
 * Step 1 (Ultra-Fast, <50ms): Immediately generates a tiny 800px max-dimension JPEG (0.65 quality, ~40KB-60KB)
 * specifically for `POST /api/parse-receipt` so the AI request fires before any 1600px storage compression begins.
 */
export async function prepareFastAiReceiptPayload(
  file: File,
  aiMaxDimension = 800,
  aiQuality = 0.65
): Promise<FastAiReceiptPayload> {
  const fileName = file.name || "";
  const isPdf =
    file.type === "application/pdf" || /\.pdf$/i.test(fileName);

  if (isPdf) {
    const base64 = await readBlobAsBase64(file);
    return {
      aiBase64: base64.replace(/^data:[^;]+;base64,/i, ""),
      mimeType: "application/pdf",
      previewUrl: URL.createObjectURL(file),
      isPdf: true,
    };
  }

  const isLikelyImage =
    file.type.startsWith("image/") ||
    /\.(jpe?g|png|webp|heic|heif)$/i.test(fileName) ||
    !file.type;

  if (isLikelyImage) {
    try {
      const img = await loadImageElement(file);
      const aiDataUrl = renderImageToJpegDataUrl(
        img,
        aiMaxDimension,
        aiQuality
      );
      return {
        aiBase64: aiDataUrl.replace(/^data:[^;]+;base64,/i, ""),
        mimeType: "image/jpeg",
        previewUrl: aiDataUrl,
        isPdf: false,
      };
    } catch {
      const rawBase64 = await readBlobAsBase64(file);
      return {
        aiBase64: rawBase64.replace(/^data:[^;]+;base64,/i, ""),
        mimeType:
          file.type && file.type.startsWith("image/")
            ? file.type
            : "image/jpeg",
        previewUrl: URL.createObjectURL(file),
        isPdf: false,
      };
    }
  }

  const rawBase64 = await readBlobAsBase64(file);
  return {
    aiBase64: rawBase64.replace(/^data:[^;]+;base64,/i, ""),
    mimeType: file.type || "image/jpeg",
    previewUrl: URL.createObjectURL(file),
    isPdf: false,
  };
}

/**
 * Step 2 (Background Storage Compression): Compresses the image to a crisp 1600px JPEG (0.82 quality)
 * using asynchronous `canvas.toBlob` so it never blocks the main thread or AI form auto-fill.
 */
export async function compressReceiptForStorage(
  file: File,
  storageMaxDimension = 1600,
  storageQuality = 0.82
): Promise<StorageReceiptPayload> {
  const fileName = file.name || "";
  const isPdf =
    file.type === "application/pdf" || /\.pdf$/i.test(fileName);

  if (isPdf) {
    return {
      blob: file,
      extension: "pdf",
      mimeType: "application/pdf",
    };
  }

  const isLikelyImage =
    file.type.startsWith("image/") ||
    /\.(jpe?g|png|webp|heic|heif)$/i.test(fileName) ||
    !file.type;

  if (isLikelyImage) {
    try {
      const img = await loadImageElement(file);
      const canvas = renderImageToCanvas(img, storageMaxDimension);
      const blob = await new Promise<Blob>((resolve, reject) => {
        canvas.toBlob(
          (b) => {
            if (b) resolve(b);
            else reject(new Error("Canvas toBlob failed"));
          },
          "image/jpeg",
          storageQuality
        );
      });
      return {
        blob,
        extension: "jpg",
        mimeType: "image/jpeg",
      };
    } catch {
      const fallbackMime =
        file.type && file.type.startsWith("image/") ? file.type : "image/jpeg";
      const extMatch = fileName.match(/\.([a-z0-9]+)$/i);
      const fallbackExt = extMatch ? extMatch[1].toLowerCase() : "jpg";
      return {
        blob: file,
        extension: fallbackExt,
        mimeType: fallbackMime,
      };
    }
  }

  return {
    blob: file,
    extension: "jpg",
    mimeType: file.type || "image/jpeg",
  };
}

/**
 * Dual-resolution client compression helper (combines 800px @ 0.65 AI payload and 1600px @ 0.82 storage payload).
 */
export async function compressReceiptFile(
  file: File,
  storageMaxDimension = 1600,
  storageQuality = 0.82,
  aiMaxDimension = 800,
  aiQuality = 0.65
): Promise<CompressedReceiptResult> {
  const [fastAi, storagePayload] = await Promise.all([
    prepareFastAiReceiptPayload(file, aiMaxDimension, aiQuality),
    compressReceiptForStorage(file, storageMaxDimension, storageQuality),
  ]);

  return {
    blob: storagePayload.blob,
    base64: fastAi.aiBase64,
    aiBase64: fastAi.aiBase64,
    mimeType: fastAi.mimeType,
    extension: storagePayload.extension,
    previewUrl: fastAi.previewUrl,
    isPdf: fastAi.isPdf,
  };
}

/**
 * Fetches a shared receipt URL (e.g. from `?shared_receipt=<url>`) and compresses it to a
 * tiny 800px @ 0.65 JPEG base64 payload for fast AI OCR extraction.
 */
export async function compressRemoteReceiptForAi(
  receiptUrl: string
): Promise<{ base64: string; mimeType: string }> {
  const response = await fetch(receiptUrl);
  if (!response.ok) {
    throw new Error(
      `Failed to fetch shared receipt (${response.status} ${response.statusText})`
    );
  }
  const blob = await response.blob();
  const isPdf =
    blob.type === "application/pdf" || isPdfReceiptUrl(receiptUrl);
  const fileName = isPdf ? "shared-receipt.pdf" : "shared-receipt.jpg";
  const file = new File([blob], fileName, {
    type: blob.type || (isPdf ? "application/pdf" : "image/jpeg"),
  });
  const fastAi = await prepareFastAiReceiptPayload(file, 800, 0.65);
  return {
    base64: fastAi.aiBase64,
    mimeType: fastAi.mimeType,
  };
}

/**
 * Uploads the receipt Blob to the 'receipts' Supabase Storage bucket at
 * `${groupId}/${crypto.randomUUID()}.${extension}` and returns the public URL.
 */
export async function uploadReceiptToStorage(
  supabase: SupabaseClient,
  groupId: string,
  blob: Blob,
  extension: string,
  mimeType: string
): Promise<string> {
  const cleanGroup = groupId.trim() || "general";
  const cleanExt = extension.replace(/[^a-z0-9]/gi, "").toLowerCase() || "jpg";
  const storagePath = `${cleanGroup}/${crypto.randomUUID()}.${cleanExt}`;

  const { error: uploadError } = await supabase.storage
    .from("receipts")
    .upload(storagePath, blob, {
      contentType: mimeType,
      upsert: false,
    });

  if (uploadError) {
    throw new Error(`Receipt upload failed: ${uploadError.message}`);
  }

  const { data: publicUrlData } = supabase.storage
    .from("receipts")
    .getPublicUrl(storagePath);

  if (!publicUrlData?.publicUrl) {
    throw new Error("Could not resolve public URL for uploaded receipt.");
  }

  return publicUrlData.publicUrl;
}

/**
 * Sends the compressed base64 receipt to POST /api/parse-receipt for AI OCR extraction.
 */
export async function parseReceiptWithAi(
  imageBase64: string,
  mimeType: string
): Promise<ParsedReceiptData> {
  const response = await fetch("/api/parse-receipt", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      imageBase64,
      mimeType,
    }),
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload?.ok === false) {
    throw new Error(
      typeof payload?.error === "string"
        ? payload.error
        : `Receipt scan failed (${response.status})`
    );
  }

  return normalizeParsedReceipt(payload);
}

