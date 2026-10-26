import type { SupabaseClient } from "@supabase/supabase-js";
import { EXPENSE_CATEGORIES } from "./reconciliation.ts";
import { normalizeCurrencyCode } from "./currencies.ts";

export interface ParsedReceiptData {
  description?: string;
  amount?: number;
  currency?: string;
  date?: string;
  category?: string;
}

export interface CompressedReceiptResult {
  /** Crisp 1600px (0.82 quality) JPEG Blob for Supabase Storage upload */
  blob: Blob;
  /** Compact 1024px (0.70 quality) JPEG base64 string for fast AI OCR */
  base64: string;
  /** Explicit alias for the compact 1024px (0.70 quality) AI payload */
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

function renderImageToJpegDataUrl(
  img: HTMLImageElement,
  maxDimension: number,
  quality: number
): string {
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

  return canvas.toDataURL("image/jpeg", quality);
}

/**
 * Dual-resolution client compression:
 * 1. Generates a compact 1024px max-dimension JPEG at 0.70 quality (`aiBase64` / `base64`)
 *    specifically for `POST /api/parse-receipt` (reduces payload size & vision token latency by ~65%).
 * 2. Generates a crisp 1600px max-dimension JPEG at 0.82 quality (`blob` / `previewUrl`)
 *    for the Supabase Storage `'receipts'` bucket upload.
 * Falls back to raw file base64 if canvas decoding fails. Passes PDFs through as-is.
 */
export async function compressReceiptFile(
  file: File,
  storageMaxDimension = 1600,
  storageQuality = 0.82,
  aiMaxDimension = 1024,
  aiQuality = 0.7
): Promise<CompressedReceiptResult> {
  const fileName = file.name || "";
  const isPdf =
    file.type === "application/pdf" || /\.pdf$/i.test(fileName);

  if (isPdf) {
    const base64 = await readBlobAsBase64(file);
    const previewUrl = URL.createObjectURL(file);
    return {
      blob: file,
      base64,
      aiBase64: base64,
      mimeType: "application/pdf",
      extension: "pdf",
      previewUrl,
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

      // 1. Compact 1024px @ 0.70 quality JPEG for fast AI OCR
      const aiDataUrl = renderImageToJpegDataUrl(
        img,
        aiMaxDimension,
        aiQuality
      );
      const aiCleanBase64 = aiDataUrl.replace(/^data:[^;]+;base64,/i, "");

      // 2. Crisp 1600px @ 0.82 quality JPEG for Supabase Storage
      const storageDataUrl = renderImageToJpegDataUrl(
        img,
        storageMaxDimension,
        storageQuality
      );
      const storageCleanBase64 = storageDataUrl.replace(
        /^data:[^;]+;base64,/i,
        ""
      );

      const byteString = atob(storageCleanBase64);
      const byteNumbers = new Uint8Array(byteString.length);
      for (let i = 0; i < byteString.length; i++) {
        byteNumbers[i] = byteString.charCodeAt(i);
      }
      const blob = new Blob([byteNumbers], { type: "image/jpeg" });

      return {
        blob,
        base64: aiCleanBase64,
        aiBase64: aiCleanBase64,
        mimeType: "image/jpeg",
        extension: "jpg",
        previewUrl: storageDataUrl,
        isPdf: false,
      };
    } catch {
      // Fallback: if <canvas> decoding fails (e.g. raw HEIC or unusual container), read raw file base64
      const rawBase64 = await readBlobAsBase64(file);
      const cleanBase64 = rawBase64.replace(/^data:[^;]+;base64,/i, "");
      const fallbackMime =
        file.type && file.type.startsWith("image/") ? file.type : "image/jpeg";
      const extMatch = fileName.match(/\.([a-z0-9]+)$/i);
      const fallbackExt = extMatch ? extMatch[1].toLowerCase() : "jpg";
      return {
        blob: file,
        base64: cleanBase64,
        aiBase64: cleanBase64,
        mimeType: fallbackMime,
        extension: fallbackExt,
        previewUrl: URL.createObjectURL(file),
        isPdf: false,
      };
    }
  }

  // Generic fallback for any other file
  const rawBase64 = await readBlobAsBase64(file);
  const cleanBase64 = rawBase64.replace(/^data:[^;]+;base64,/i, "");
  return {
    blob: file,
    base64: cleanBase64,
    aiBase64: cleanBase64,
    mimeType: file.type || "image/jpeg",
    extension: "jpg",
    previewUrl: URL.createObjectURL(file),
    isPdf: false,
  };
}

/**
 * Fetches a shared receipt URL (e.g. from `?shared_receipt=<url>`) and compresses it to a
 * compact 1024px @ 0.70 JPEG base64 payload for fast AI OCR extraction.
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
  const compressed = await compressReceiptFile(file);
  return {
    base64: compressed.aiBase64,
    mimeType: compressed.mimeType,
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

