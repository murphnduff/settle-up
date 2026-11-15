export interface CurrencyDefinition {
  code: string;
  symbol: string;
  name: string;
  label: string;
  pillLabel: string;
}

export const SUPPORTED_CURRENCIES: readonly CurrencyDefinition[] = [
  { code: "USD", symbol: "$", name: "US Dollar", label: "US Dollar", pillLabel: "$ USD" },
  { code: "EUR", symbol: "€", name: "Euro", label: "Euro", pillLabel: "€ EUR" },
  { code: "AUD", symbol: "A$", name: "Australian Dollar", label: "Australian Dollar", pillLabel: "A$ AUD" },
  { code: "THB", symbol: "฿", name: "Thai Baht", label: "Thai Baht", pillLabel: "฿ THB" },
  { code: "GBP", symbol: "£", name: "British Pound", label: "British Pound", pillLabel: "£ GBP" },
  { code: "CAD", symbol: "C$", name: "Canadian Dollar", label: "Canadian Dollar", pillLabel: "C$ CAD" },
  { code: "JPY", symbol: "¥", name: "Japanese Yen", label: "Japanese Yen", pillLabel: "¥ JPY" },
  { code: "NZD", symbol: "NZ$", name: "New Zealand Dollar", label: "New Zealand Dollar", pillLabel: "NZ$ NZD" },
  { code: "CHF", symbol: "CHF", name: "Swiss Franc", label: "Swiss Franc", pillLabel: "CHF" },
  { code: "MXN", symbol: "Mex$", name: "Mexican Peso", label: "Mexican Peso", pillLabel: "Mex$ MXN" },
] as const;

const SYMBOL_TO_ISO_MAP: Record<string, string> = {
  $: "USD",
  US$: "USD",
  USD: "USD",
  "€": "EUR",
  EUR: "EUR",
  A$: "AUD",
  AU$: "AUD",
  AUD: "AUD",
  "฿": "THB",
  THB: "THB",
  BAHT: "THB",
  "£": "GBP",
  GBP: "GBP",
  C$: "CAD",
  CA$: "CAD",
  CAD: "CAD",
  "¥": "JPY",
  JPY: "JPY",
  NZ$: "NZD",
  NZD: "NZD",
  CHF: "CHF",
  MEX$: "MXN",
  MX$: "MXN",
  MXN: "MXN",
};

const CURRENCY_BY_CODE = new Map<string, CurrencyDefinition>(
  SUPPORTED_CURRENCIES.map((c) => [c.code, c])
);

/**
 * Normalizes any symbol ('$', '€', 'A$', '฿', etc.) or currency string into its
 * canonical 3-letter uppercase ISO currency code (defaults to 'USD').
 */
export function normalizeCurrencyCode(raw?: string | null): string {
  if (!raw || typeof raw !== "string") return "USD";
  const trimmed = raw.trim();
  if (!trimmed) return "USD";

  const upper = trimmed.toUpperCase();
  if (SYMBOL_TO_ISO_MAP[upper]) {
    return SYMBOL_TO_ISO_MAP[upper];
  }
  if (SYMBOL_TO_ISO_MAP[trimmed]) {
    return SYMBOL_TO_ISO_MAP[trimmed];
  }

  // Extract 3-letter ISO code if string contains one (e.g. "A$ AUD" -> "AUD")
  const isoMatch = upper.match(/\b([A-Z]{3})\b/);
  if (isoMatch) {
    return isoMatch[1];
  }

  if (/^[A-Z]{3}$/.test(upper)) {
    return upper;
  }

  return "USD";
}

/**
 * Returns full metadata for a currency code or symbol, with a clean fallback for any custom 3-letter ISO code.
 */
export function getCurrencyInfo(raw?: string | null): CurrencyDefinition {
  const code = normalizeCurrencyCode(raw);
  const known = CURRENCY_BY_CODE.get(code);
  if (known) return known;
  return {
    code,
    symbol: `${code} `,
    name: code,
    label: code,
    pillLabel: code,
  };
}

/**
 * Returns the display symbol for a currency code (e.g. '$', '€', 'A$', '฿', 'CHF ').
 */
export function getCurrencySymbol(raw?: string | null): string {
  const info = getCurrencyInfo(raw);
  return info.symbol === "CHF" ? "CHF " : info.symbol;
}

/**
 * Formats an integer cent amount with the appropriate symbol prefix and thousands separators.
 * Examples:
 * - formatCurrency(2500, 'USD') -> '$25.00'
 * - formatCurrency(4000, 'AUD') -> 'A$40.00'
 * - formatCurrency(125000, 'THB') -> '฿1,250.00'
 * - formatCurrency(1500, 'EUR') -> '€15.00'
 */
export function formatCurrency(
  cents: number,
  currencyCode: string = "USD"
): string {
  const safeCents = Number.isFinite(cents) ? Math.round(cents) : 0;
  const isNegative = safeCents < 0;
  const absDollars = Math.abs(safeCents) / 100;
  const formattedNumber = absDollars.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });

  const symbol = getCurrencySymbol(currencyCode);
  return `${isNegative ? "-" : ""}${symbol}${formattedNumber}`;
}

/**
 * Builds the ordered list of active ISO currency codes for a group,
 * combining group.currencies, group.default_currency, and any currencies present in the group's expenses.
 */
export function buildGroupCurrencies(
  groupCurrencies?: string[] | null,
  defaultCurrency?: string | null,
  expensesOrCurrencies: Array<string | { currency?: string }> = []
): string[] {
  const result: string[] = [];
  const seen = new Set<string>();

  const addCode = (raw?: string | null) => {
    if (!raw) return;
    const code = normalizeCurrencyCode(raw);
    if (!seen.has(code)) {
      seen.add(code);
      result.push(code);
    }
  };

  if (Array.isArray(groupCurrencies) && groupCurrencies.length > 0) {
    for (const c of groupCurrencies) {
      addCode(c);
    }
  }

  if (defaultCurrency) {
    addCode(defaultCurrency);
  }

  for (const item of expensesOrCurrencies) {
    if (typeof item === "string") {
      addCode(item);
    } else if (item?.currency) {
      addCode(item.currency);
    }
  }

  if (result.length === 0) {
    result.push("USD");
  }

  return result;
}

export type FxRatesMap = Record<string, number>;

/**
 * Safely normalizes a raw JSONB `fx_rates` map into uppercase 3-letter ISO keys
 * with positive finite numeric values. Returns `null` if no valid rates exist.
 */
export function normalizeFxRatesMap(
  raw: unknown,
  baseCurrency?: string | null
): FxRatesMap | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return null;
  }

  const normalized: FxRatesMap = {};
  let validCount = 0;

  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    const num = Number(v);
    if (Number.isFinite(num) && num > 0) {
      const code = normalizeCurrencyCode(k);
      normalized[code] = Number(num.toPrecision(10));
      validCount++;
    }
  }

  if (validCount === 0) {
    return null;
  }

  if (baseCurrency) {
    const baseCode = normalizeCurrencyCode(baseCurrency);
    if (!normalized[baseCode]) {
      normalized[baseCode] = 1;
    }
  }

  return normalized;
}

/**
 * Resolves the locked conversion multiplier (`1 expenseCurrency = mult targetCurrency`)
 * from an expense's `fx_rates` map, or returns `null` if unavailable.
 */
export function getLockedRateToTarget(
  expenseCurrency: string,
  targetCurrency: string,
  fxRates?: FxRatesMap | null
): number | null {
  const expCode = normalizeCurrencyCode(expenseCurrency);
  const targetCode = normalizeCurrencyCode(targetCurrency);
  if (expCode === targetCode) return 1;
  if (!fxRates || typeof fxRates !== "object") return null;

  const rawTarget = Number(fxRates[targetCode]);
  if (!Number.isFinite(rawTarget) || rawTarget <= 0) {
    return null;
  }

  const rawSelf = Number(fxRates[expCode]);
  const baseSelf = Number.isFinite(rawSelf) && rawSelf > 0 ? rawSelf : 1;
  return rawTarget / baseSelf;
}

/**
 * Formats an exchange rate number cleanly (e.g., 34.5 -> "34.50", 1.5234 -> "1.5234").
 */
export function formatFxQuoteNumber(rate: number): string {
  if (!Number.isFinite(rate) || rate <= 0) return "1.00";
  if (rate >= 100) {
    return rate.toFixed(2);
  }
  if (rate >= 1) {
    const fixed4 = rate.toFixed(4);
    return fixed4.replace(/(\.\d{2,}?)0+$/, "$1");
  }
  const fixed6 = rate.toFixed(6);
  return fixed6.replace(/(\.\d{4,}?)0+$/, "$1");
}

/**
 * Formats a human-friendly FX quote between `expenseCurrency` and `targetCurrency`
 * so values < 1 (such as THB -> USD) display intuitively as `1 USD = 34.50 THB`,
 * while values >= 1 (such as EUR -> USD) display as `1 EUR = 1.08 USD`.
 */
export function formatFxDisplayQuote(
  expenseCurrency: string,
  targetCurrency: string,
  rateExpToTarget: number
): {
  quoteText: string;
  shortRateText: string;
  isInverse: boolean;
  displayRate: number;
} {
  const expCode = normalizeCurrencyCode(expenseCurrency);
  const targetCode = normalizeCurrencyCode(targetCurrency);
  const safeRate =
    Number.isFinite(rateExpToTarget) && rateExpToTarget > 0
      ? rateExpToTarget
      : 1;

  if (safeRate < 1) {
    const inverse = 1 / safeRate;
    const shortRateText = formatFxQuoteNumber(inverse);
    return {
      quoteText: `1 ${targetCode} = ${shortRateText} ${expCode}`,
      shortRateText,
      isInverse: true,
      displayRate: inverse,
    };
  }

  const shortRateText = formatFxQuoteNumber(safeRate);
  return {
    quoteText: `1 ${expCode} = ${shortRateText} ${targetCode}`,
    shortRateText,
    isInverse: false,
    displayRate: safeRate,
  };
}

const fxFetchCache = new Map<string, Promise<FxRatesMap>>();

/**
 * Fetches date-aware FX rates normalized as `1 unit of baseCurrency = X units of targetCurrency`
 * (with `fx_rates[baseCurrency] = 1`).
 *
 * 1. Queries `https://api.frankfurter.dev/v1/${dateIso}?base=${baseCurrency}` first for free historical daily rates.
 * 2. Merges/falls back to `https://open.er-api.com/v6/latest/${baseCurrency}` for today's live tick
 *    or for any ISO currency code not returned by Frankfurter.
 */
export async function fetchTransactionFxRates(
  baseCurrency: string,
  dateIso: string,
  targetCurrencies: string[] = []
): Promise<FxRatesMap> {
  const base = normalizeCurrencyCode(baseCurrency);
  const todayUtc = new Date().toISOString().split("T")[0];
  const cleanDateMatch = (dateIso || "").trim().match(/^(\d{4}-\d{2}-\d{2})/);
  const cleanDate = cleanDateMatch ? cleanDateMatch[1] : todayUtc;
  const queryDate = cleanDate > todayUtc ? todayUtc : cleanDate;
  const isHistoricalDate = cleanDate < todayUtc;

  const normalizedTargets = Array.from(
    new Set(
      targetCurrencies
        .filter(Boolean)
        .map((c) => normalizeCurrencyCode(c))
        .filter((c) => c !== base)
    )
  ).sort();

  const desiredKeepCodes = new Set<string>([
    base,
    ...SUPPORTED_CURRENCIES.map((c) => c.code),
    ...normalizedTargets,
  ]);

  const cacheKey = `${base}::${cleanDate}::${normalizedTargets.join(",")}`;
  const cached = fxFetchCache.get(cacheKey);
  if (cached) {
    return cached.then((r) => ({ ...r }));
  }

  const task = (async (): Promise<FxRatesMap> => {
    const rates: FxRatesMap = { [base]: 1 };
    let frankfurterOk = false;

    try {
      const frankfurterUrl = `https://api.frankfurter.dev/v1/${encodeURIComponent(
        queryDate
      )}?base=${encodeURIComponent(base)}`;
      const res = await fetch(frankfurterUrl);
      if (res.ok) {
        const data = await res.json();
        if (data?.rates && typeof data.rates === "object") {
          frankfurterOk = true;
          for (const [k, v] of Object.entries(
            data.rates as Record<string, unknown>
          )) {
            const code = normalizeCurrencyCode(k);
            const num = Number(v);
            if (
              desiredKeepCodes.has(code) &&
              Number.isFinite(num) &&
              num > 0
            ) {
              rates[code] = Number(num.toPrecision(10));
            }
          }
        }
      }
    } catch {
      // Fall through to open.er-api.com fallback
    }

    const missingRequestedTarget = normalizedTargets.some(
      (code) => !(code in rates)
    );
    const shouldQueryLiveApi =
      !frankfurterOk || !isHistoricalDate || missingRequestedTarget;

    if (shouldQueryLiveApi) {
      try {
        const liveUrl = `https://open.er-api.com/v6/latest/${encodeURIComponent(
          base
        )}`;
        const res = await fetch(liveUrl);
        if (res.ok) {
          const data = await res.json();
          if (data?.rates && typeof data.rates === "object") {
            for (const [k, v] of Object.entries(
              data.rates as Record<string, unknown>
            )) {
              const code = normalizeCurrencyCode(k);
              const num = Number(v);
              if (
                !desiredKeepCodes.has(code) ||
                !Number.isFinite(num) ||
                num <= 0
              ) {
                continue;
              }
              // On historical dates, only fill codes missing from Frankfurter so historical ECB rates stay preserved
              if (!isHistoricalDate || !(code in rates)) {
                rates[code] = Number(num.toPrecision(10));
              }
            }
          }
        }
      } catch {
        // Keep whatever rates were resolved so far
      }
    }

    rates[base] = 1;
    return rates;
  })();

  fxFetchCache.set(cacheKey, task);
  try {
    const resolved = await task;
    // Evict from cache if no non-base rates were obtained (e.g. temporary offline failure)
    if (normalizedTargets.length > 0 && Object.keys(resolved).length <= 1) {
      fxFetchCache.delete(cacheKey);
    }
    return { ...resolved };
  } catch (err) {
    fxFetchCache.delete(cacheKey);
    throw err;
  }
}


