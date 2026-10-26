import { NextRequest, NextResponse } from "next/server";
import { EXPENSE_CATEGORIES } from "@/lib/reconciliation";
import { normalizeParsedReceipt } from "@/lib/receipts";

const DEFAULT_GEMINI_MODEL = "gemini-3.8-flash";

const RECEIPT_EXTRACTION_PROMPT = `You are an expert financial receipt parser for a group expense-splitting app.
Analyze the attached receipt image or PDF and extract the transaction details into strict JSON with the following exact keys:
{
  "description": "Merchant name + brief summary (e.g. 'Dunnes Stores - Groceries' or 'Delta Air Lines - Flights')",
  "amount": 42.50,
  "currency": "USD" | "EUR",
  "date": "YYYY-MM-DD",
  "category": "One of: General, Dining out, Groceries, Drinks, Lodging, Flights, Car Rental, Gas, Activities"
}

Rules:
1. "amount": Use the final total charged (including tax and tip if shown), as a positive number with up to 2 decimal places.
2. "currency": Return "EUR" if the receipt uses € or EUR; otherwise return "USD".
3. "date": Return the transaction date in strict YYYY-MM-DD format. If no year is printed, infer the current year. If no date is visible, omit or return an empty string.
4. "category": Choose the best matching preset from [${EXPENSE_CATEGORIES.join(", ")}].
5. Return ONLY valid JSON.`;

export async function POST(request: NextRequest) {
  try {
    const apiKey = process.env.GEMINI_API_KEY?.trim();
    if (!apiKey) {
      return NextResponse.json(
        { error: "Server is missing GEMINI_API_KEY configuration." },
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
        { error: "Missing imageBase64 payload." },
        { status: 400 }
      );
    }

    // Strip optional data URI prefix if passed
    const commaIdx = rawBase64.indexOf(",");
    const cleanBase64 =
      rawBase64.startsWith("data:") && commaIdx >= 0
        ? rawBase64.slice(commaIdx + 1)
        : rawBase64;

    const configuredModel =
      process.env.GEMINI_MODEL?.trim() || DEFAULT_GEMINI_MODEL;

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

    const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
      configuredModel
    )}:generateContent?key=${encodeURIComponent(apiKey)}`;

    const geminiRes = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(requestBody),
    });

    if (!geminiRes.ok) {
      const errData = await geminiRes.json().catch(() => ({}));
      const errMsg =
        errData?.error?.message ||
        `Gemini API request failed with status ${geminiRes.status}`;
      return NextResponse.json({ error: errMsg }, { status: 502 });
    }

    const geminiJson = await geminiRes.json();
    const rawText: string =
      geminiJson?.candidates?.[0]?.content?.parts
        ?.map((p: { text?: string }) => p.text || "")
        .join("")
        .trim() || "";

    if (!rawText) {
      return NextResponse.json(
        { error: "Gemini returned an empty response for this receipt." },
        { status: 422 }
      );
    }

    // Strip markdown code fences if present
    const cleanedJsonText = rawText
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/\s*```$/, "")
      .trim();

    let parsedObj: unknown;
    try {
      parsedObj = JSON.parse(cleanedJsonText);
    } catch {
      return NextResponse.json(
        { error: "Failed to parse JSON from Gemini response." },
        { status: 422 }
      );
    }

    const normalized = normalizeParsedReceipt(parsedObj);
    return NextResponse.json(normalized, { status: 200 });
  } catch (err: unknown) {
    const message =
      err instanceof Error ? err.message : "Unexpected error parsing receipt.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

