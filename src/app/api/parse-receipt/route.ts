import { NextRequest, NextResponse } from "next/server";
import { EXPENSE_CATEGORIES } from "@/lib/reconciliation";
import { normalizeParsedReceipt } from "@/lib/receipts";

const CANDIDATE_MODELS = [
  "gemini-2.5-flash-lite",
  "gemini-flash-lite-latest",
  "gemini-2.5-flash",
  "gemini-flash-latest",
];

const RECEIPT_EXTRACTION_PROMPT = `Extract receipt details into strict JSON:
{"description":"Merchant + brief item","amount":0.00,"currency":"USD","date":"YYYY-MM-DD","category":"Category"}
Rules:
- amount: final total charged (positive number).
- currency: 3-letter ISO code (USD, EUR, AUD, THB, GBP, CAD, JPY, NZD, CHF, MXN).
- date: YYYY-MM-DD (infer current year if omitted; "" if none).
- category: one of [${EXPENSE_CATEGORIES.join(", ")}] or a 1-2 word custom category.`;

function supportsThinkingConfig(modelName: string): boolean {
  return /gemini-(2\.5|3)/i.test(modelName);
}

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
  const startedAt = Date.now();
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

    const baseContents = [
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
    ];

    const buildRequestBody = (includeThinkingZero: boolean) => ({
      contents: baseContents,
      generationConfig: {
        responseMimeType: "application/json",
        temperature: 0,
        maxOutputTokens: 200,
        ...(includeThinkingZero
          ? { thinkingConfig: { thinkingBudget: 0 } }
          : {}),
      },
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let geminiJson: any = null;
    let modelUsed = "";
    let primaryErrorMsg = "";
    const triedModels = new Set<string>();

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const callSingleModel = async (modelName: string): Promise<{ modelName: string; json: any }> => {
      triedModels.add(modelName);
      const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
        modelName
      )}:generateContent?key=${encodeURIComponent(apiKey)}`;

      const useThinkingZero = supportsThinkingConfig(modelName);
      let geminiRes = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(buildRequestBody(useThinkingZero)),
      });

      if (geminiRes.ok) {
        return { modelName, json: await geminiRes.json() };
      }

      let errData = await geminiRes.json().catch(() => ({}));
      let currentErrorMsg: string =
        errData?.error?.message ||
        `Gemini API (${modelName}) returned status ${geminiRes.status}`;

      // If a model unexpectedly rejected thinkingConfig, retry once without it
      if (useThinkingZero && geminiRes.status === 400 && /thinking/i.test(currentErrorMsg)) {
        geminiRes = await fetch(endpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(buildRequestBody(false)),
        });

        if (geminiRes.ok) {
          return { modelName, json: await geminiRes.json() };
        }

        errData = await geminiRes.json().catch(() => ({}));
        currentErrorMsg =
          errData?.error?.message ||
          `Gemini API (${modelName}) returned status ${geminiRes.status}`;
      }

      if (!primaryErrorMsg) {
        primaryErrorMsg = currentErrorMsg;
      }

      const err = new Error(currentErrorMsg) as Error & { retryable?: boolean };
      err.retryable = isRetryableOrCascadeError(geminiRes.status, currentErrorMsg);
      throw err;
    };

    // Hedged parallel race: start primary model immediately; if it hasn't responded within 3500ms
    // (or fails with 404/429/500/503), immediately launch the next fallback model in parallel.
    const tryModelListWithHedge = async (candidates: string[]): Promise<boolean> => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const activePromises: Array<Promise<{ modelName: string; json: any }>> = [];
      let resolvedWinner: { modelName: string; json: unknown } | null = null;

      for (const candidate of candidates) {
        const p = callSingleModel(candidate).then((res) => {
          if (!resolvedWinner) {
            resolvedWinner = res;
          }
          return res;
        });
        activePromises.push(p);

        const raceOutcome = await Promise.race([
          Promise.any(activePromises).then((win) => ({
            type: "win" as const,
            win,
          })),
          p.then(
            (win) => ({ type: "win" as const, win }),
            (err: Error & { retryable?: boolean }) => ({
              type: "err" as const,
              err,
            })
          ),
          new Promise<{ type: "timeout" }>((resolve) =>
            setTimeout(() => resolve({ type: "timeout" }), 3500)
          ),
        ]);

        if (raceOutcome.type === "win") {
          geminiJson = raceOutcome.win.json;
          modelUsed = raceOutcome.win.modelName;
          return true;
        }

        if (
          raceOutcome.type === "err" &&
          raceOutcome.err.retryable === false &&
          activePromises.length === 1
        ) {
          return false;
        }
        // Otherwise (timeout > 3500ms or retryable 404/429/503 error), immediately launch next candidate!
      }

      if (activePromises.length > 0) {
        try {
          const win = await Promise.any(activePromises);
          geminiJson = win.json;
          modelUsed = win.modelName;
          return true;
        } catch {
          return false;
        }
      }
      return false;
    };

    // 1. Try configured/rolling candidate models with 3500ms hedged timeout race
    await tryModelListWithHedge(modelsToTry);

    // 2. Dynamic auto-discovery fallback if all static candidates failed
    if (!geminiJson) {
      const discoveredModels = await discoverLatestFlashModels(
        apiKey,
        triedModels
      );
      if (discoveredModels.length > 0) {
        await tryModelListWithHedge(discoveredModels);
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
    const durationMs = Date.now() - startedAt;
    return NextResponse.json(
      {
        ok: true,
        ...normalized,
        modelUsed,
        durationMs,
      },
      { status: 200 }
    );
  } catch (err: unknown) {
    const message =
      err instanceof Error ? err.message : "Unexpected error parsing receipt.";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
