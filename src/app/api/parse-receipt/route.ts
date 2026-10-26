import { NextRequest, NextResponse } from "next/server";
import { EXPENSE_CATEGORIES } from "@/lib/reconciliation";
import { normalizeParsedReceipt } from "@/lib/receipts";

const CANDIDATE_MODELS = [
  "gemini-flash-latest",
  "gemini-3.8-flash",
  "gemini-flash-lite-latest",
  "gemini-2.5-flash",
];

const RECEIPT_EXTRACTION_PROMPT = `You are an expert financial receipt parser for a group expense-splitting app.
Analyze the attached receipt image or PDF and extract the transaction details into strict JSON with the following exact keys:
{
  "description": "Merchant name + brief summary (e.g. 'Dunnes Stores - Groceries' or 'Delta Air Lines - Flights')",
  "amount": 42.50,
  "currency": "USD" | "EUR" | "AUD" | "THB" | "GBP" | "CAD" | "JPY" | "NZD" | "CHF" | "MXN",
  "date": "YYYY-MM-DD",
  "category": "Category name"
}

Rules:
1. "amount": Use the final total charged (including tax and tip if shown), as a positive number with up to 2 decimal places.
2. "currency": Return the 3-letter ISO currency code detected on the receipt (e.g. "THB" if ฿ / Baht / Thailand, "AUD" if A$ / GST in Australia, "EUR" if € / Euro, "GBP" if £, "CAD" if C$, "JPY" if ¥, "NZD" if NZ$, "CHF", "MXN", or "USD" if $ / default).
3. "date": Return the transaction date in strict YYYY-MM-DD format. If no year is printed, infer the current year. If no date is visible, omit or return an empty string.
4. "category": Prefer one of our standard categories [${EXPENSE_CATEGORIES.join(", ")}], OR if the receipt clearly belongs to another specific category (e.g. "Parking", "Tolls", "Golf", "Pharmacy"), return that concise 1-2 word category name.
5. Return ONLY valid JSON.`;

function isRetryableOrCascadeError(status: number, errMsg: string): boolean {
  if (
    status === 404 ||
    status === 429 ||
    status === 500 ||
    status === 503
  ) {
    return true;
  }
  const lower = errMsg.toLowerCase();
  return (
    lower.includes("not found") ||
    lower.includes("no longer available") ||
    lower.includes("high demand") ||
    lower.includes("overloaded") ||
    lower.includes("is not supported for generatecontent")
  );
}

async function discoverLatestFlashModels(
  apiKey: string,
  alreadyTried: Set<string>
): Promise<string[]> {
  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(
        apiKey
      )}`
    );
    if (!res.ok) return [];
    const data = await res.json();
    const models = Array.isArray(data?.models) ? data.models : [];

    const discovered: string[] = [];
    for (const m of models) {
      const rawName = typeof m?.name === "string" ? m.name : "";
      const shortName = rawName.replace(/^models\//i, "").trim();
      const lower = shortName.toLowerCase();
      const methods: string[] = Array.isArray(m?.supportedGenerationMethods)
        ? m.supportedGenerationMethods
        : [];

      if (
        shortName &&
        !alreadyTried.has(shortName) &&
        methods.includes("generateContent") &&
        lower.includes("flash") &&
        !lower.includes("2.0-flash") &&
        !lower.includes("1.5") &&
        !lower.includes("tts") &&
        !lower.includes("image") &&
        !lower.includes("audio") &&
        !lower.includes("live") &&
        !lower.includes("transcribe")
      ) {
        discovered.push(shortName);
      }
    }

    // Sort descending so newest versioned Flash models are tried first
    return discovered.sort((a, b) => b.localeCompare(a)).slice(0, 3);
  } catch {
    return [];
  }
}

export async function POST(request: NextRequest) {
  try {
    const apiKey = process.env.GEMINI_API_KEY?.trim();
    if (!apiKey) {
      return NextResponse.json(
        { ok: false, error: "Server is missing GEMINI_API_KEY configuration." },
        { status: 500 }
      );
    }

    const body = await request.json().catch(() => null);
    const rawBase64 =
      typeof body?.imageBase64 === "string" ? body.imageBase64.trim() : "";
    const mimeType =
      typeof body?.mimeType === "string" && body.mimeType.trim().length > 0
        ? body.mimeType.trim()
        : "image/jpeg";

    if (!rawBase64) {
      return NextResponse.json(
        { ok: false, error: "Missing imageBase64 payload." },
        { status: 400 }
      );
    }

    // Strip optional data URI prefix if passed
    const cleanBase64 = rawBase64.replace(/^data:[^;]+;base64,/i, "");

    const envModel = process.env.GEMINI_MODEL?.trim();
    const modelsToTry = Array.from(
      new Set([...(envModel ? [envModel] : []), ...CANDIDATE_MODELS])
    );

    const requestBody = {
      contents: [
        {
          parts: [
            {
              inlineData: {
                mimeType,
                data: cleanBase64,
              },
            },
            {
              text: RECEIPT_EXTRACTION_PROMPT,
            },
          ],
        },
      ],
      generationConfig: {
        responseMimeType: "application/json",
        temperature: 0.1,
      },
    };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let geminiJson: any = null;
    let primaryErrorMsg = "";
    const triedModels = new Set<string>();

    const tryModelList = async (candidates: string[]): Promise<boolean> => {
      for (const modelName of candidates) {
        triedModels.add(modelName);
        const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
          modelName
        )}:generateContent?key=${encodeURIComponent(apiKey)}`;

        const geminiRes = await fetch(endpoint, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify(requestBody),
        });

        if (geminiRes.ok) {
          geminiJson = await geminiRes.json();
          return true;
        }

        const errData = await geminiRes.json().catch(() => ({}));
        const currentErrorMsg =
          errData?.error?.message ||
          `Gemini API (${modelName}) returned status ${geminiRes.status}`;

        if (!primaryErrorMsg) {
          primaryErrorMsg = currentErrorMsg;
        }

        if (!isRetryableOrCascadeError(geminiRes.status, currentErrorMsg)) {
          primaryErrorMsg = currentErrorMsg;
          return false;
        }
      }
      return false;
    };

    // 1. Try configured/rolling candidate models
    await tryModelList(modelsToTry);

    // 2. Dynamic auto-discovery fallback if all static candidates failed
    if (!geminiJson) {
      const discoveredModels = await discoverLatestFlashModels(
        apiKey,
        triedModels
      );
      if (discoveredModels.length > 0) {
        await tryModelList(discoveredModels);
      }
    }

    if (!geminiJson) {
      return NextResponse.json(
        {
          ok: false,
          error: primaryErrorMsg || "Gemini API request failed.",
        },
        { status: 502 }
      );
    }

    const rawText: string =
      geminiJson?.candidates?.[0]?.content?.parts
        ?.map((p: { text?: string }) => p.text || "")
        .join("")
        .trim() || "";

    if (!rawText) {
      return NextResponse.json(
        {
          ok: false,
          error: "Gemini returned an empty response for this receipt.",
        },
        { status: 422 }
      );
    }

    // Strip any accidental markdown code fences (```json ... ```) before JSON.parse
    const cleanedJsonText = rawText
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/\s*```$/i, "")
      .trim();

    let parsedObj: unknown;
    try {
      parsedObj = JSON.parse(cleanedJsonText);
    } catch {
      const firstBrace = cleanedJsonText.indexOf("{");
      const lastBrace = cleanedJsonText.lastIndexOf("}");
      if (firstBrace >= 0 && lastBrace > firstBrace) {
        try {
          parsedObj = JSON.parse(
            cleanedJsonText.slice(firstBrace, lastBrace + 1)
          );
        } catch {
          return NextResponse.json(
            { ok: false, error: "Failed to parse JSON from Gemini response." },
            { status: 422 }
          );
        }
      } else {
        return NextResponse.json(
          { ok: false, error: "Failed to parse JSON from Gemini response." },
          { status: 422 }
        );
      }
    }

    const normalized = normalizeParsedReceipt(parsedObj);
    return NextResponse.json({ ok: true, ...normalized }, { status: 200 });
  } catch (err: unknown) {
    const message =
      err instanceof Error ? err.message : "Unexpected error parsing receipt.";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
