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

