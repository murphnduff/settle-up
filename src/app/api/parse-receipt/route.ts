import { NextRequest, NextResponse } from "next/server";
import { EXPENSE_CATEGORIES } from "@/lib/reconciliation";
import { normalizeParsedReceipt } from "@/lib/receipts";

const CANDIDATE_MODELS = ["gemini-2.5-flash", "gemini-2.0-flash"];

const RECEIPT_EXTRACTION_PROMPT = `You are an expert financial receipt parser for a group expense-splitting app.
Analyze the attached receipt image or PDF and extract the transaction details into strict JSON with the following exact keys:
{
  "description": "Merchant name + brief summary (e.g. 'Dunnes Stores - Groceries' or 'Delta Air Lines - Flights')",
  "amount": 42.50,
  "currency": "USD" | "EUR",
  "date": "YYYY-MM-DD",
  "category": "Category name"
}

Rules:
1. "amount": Use the final total charged (including tax and tip if shown), as a positive number with up to 2 decimal places.
2. "currency": Return "EUR" if the receipt uses € or EUR; otherwise return "USD".
3. "date": Return the transaction date in strict YYYY-MM-DD format. If no year is printed, infer the current year. If no date is visible, omit or return an empty string.
4. "category": Prefer one of our standard categories [${EXPENSE_CATEGORIES.join(", ")}], OR if the receipt clearly belongs to another specific category (e.g. "Parking", "Tolls", "Golf", "Pharmacy"), return that concise 1-2 word category name.
5. Return ONLY valid JSON.`;

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
      new Set([
        ...(envModel ? [envModel] : []),
        ...CANDIDATE_MODELS,
      ])
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
    let lastErrorMsg = "Gemini API request failed.";

    for (const modelName of modelsToTry) {
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
        break;
      }

      const errData = await geminiRes.json().catch(() => ({}));
      lastErrorMsg =
        errData?.error?.message ||
        `Gemini API (${modelName}) returned status ${geminiRes.status}`;

      // If 404 or model not found/supported, try the next fallback model
      const isModelError =
        geminiRes.status === 404 ||
        geminiRes.status === 400 ||
        lastErrorMsg.toLowerCase().includes("not found") ||
        lastErrorMsg.toLowerCase().includes("not supported");

      if (!isModelError) {
        break;
      }
    }

    if (!geminiJson) {
      return NextResponse.json(
        { ok: false, error: lastErrorMsg },
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
        { ok: false, error: "Gemini returned an empty response for this receipt." },
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
      // Attempt to extract first {...} JSON object if extra text surrounded it
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
