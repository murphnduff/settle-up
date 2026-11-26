/**
 * Settle Up - Financial Reconciliation & Penny-Splitting Math Engine
 *
 * All monetary calculations operate strictly on integers representing cents
 * (e.g. $10.00 = 1000 cents) to prevent floating-point rounding errors.
 * Supports isolated multi-currency ledgers as well as unified cross-currency reconciliation.
 */

import {
  normalizeCurrencyCode,
  getCurrencySymbol,
  normalizeFxRatesMap,
  getStaticApproxExchangeRate,
  type FxRatesMap,
} from './currencies.ts';

export const EXPENSE_CATEGORIES = [
  'General',
  'Dining out',
  'Groceries',
  'Drinks',
  'Lodging',
  'Flights',
  'Car Rental',
  'Gas',
  'Activities',
  'Miscellaneous',
  'Other',
] as const;

/**
 * Combines the default preset categories with any unique custom categories
 * already present in the group's expenses (excluding 'Payment').
 */
export function buildGroupCategories(
  expenses: Array<{ category?: string; type?: string }> = [],
  extraCategories: string[] = []
): string[] {
  const result: string[] = [...EXPENSE_CATEGORIES];
  const seenLower = new Set(result.map((c) => c.toLowerCase()));

  const addIfUnique = (raw?: string) => {
    const trimmed = (raw || '').trim();
    if (!trimmed) return;
    const lower = trimmed.toLowerCase();
    if (lower === 'payment' || seenLower.has(lower)) return;
    seenLower.add(lower);
    result.push(trimmed);
  };

  for (const exp of expenses) {
    if (exp.type === 'payment') continue;
    addIfUnique(exp.category);
  }

  for (const extra of extraCategories) {
    addIfUnique(extra);
  }

  return result;
}

export interface MemberRecord {
  id: string;
  name: string;
  householdName?: string | null;
}

export interface SplitRecord {
  memberId: string;
  splitAmountCents: number;
  /** Backwards compatibility alias */
  userId?: string;
  amount?: number;
}

export interface ExpenseRecord {
  id: string;
  paidByMemberId?: string;
  amountCents?: number;
  currency: string;
  type: 'expense' | 'payment';
  category?: string;
  date?: string;
  fxRates?: FxRatesMap | null;
  splits: SplitRecord[];
  description?: string;
  /** Backwards compatibility aliases */
  payerId?: string;
  amount?: number;
}

export interface SettlementInstruction {
  fromMemberId: string;
  fromMemberName: string;
  toMemberId: string;
  toMemberName: string;
  amountCents: number;
  amountFormatted: string;
  currency: string;
  /** Backwards compatibility aliases */
  fromUser: string;
  toUser: string;
  amount: number;
}

export interface MemberSummaryRecord {
  memberId: string;
  memberName: string;
  /** Sum of amount_cents for all type === 'expense' paid by member (excludes payments) */
  paidCents: number;
  /** Sum of split_amount_cents for all type === 'expense' allocated to member (excludes payments) */
  shareCents: number;
  /** Current net balance in cents including both expenses and direct payments */
  netBalanceCents: number;
}

export interface CategorySpendRecord {
  category: string;
  amountCents: number;
  amountFormatted: string;
  percentage: number;
}

/**
 * Evenly distributes an integer amount in cents among a set of members.
 * Remainder pennies are distributed one-by-one to the first members so that:
 * SUM(splitAmountCents) === totalAmountCents exactly.
 * Never loses or invents a penny.
 */
export function splitAmountEqually(
  totalAmountCents: number,
  memberIds: string[]
): SplitRecord[] {
  if (!memberIds || memberIds.length === 0 || totalAmountCents <= 0) {
    return [];
  }

  const count = memberIds.length;
  const baseSplit = Math.floor(totalAmountCents / count);
  const remainder = totalAmountCents % count;

  return memberIds.map((id, index) => {
    const splitAmountCents = baseSplit + (index < remainder ? 1 : 0);
    return {
      memberId: id,
      splitAmountCents,
      userId: id,
      amount: splitAmountCents / 100,
    };
  });
}

/**
 * Calculates net balances for each member grouped by currency.
 *
 * Net Balance(u) = SUM(Paid Expenses) - SUM(Split Shares)
 *                + SUM(Direct Payments Made) - SUM(Direct Payments Received)
 *
 * Direct settlement transfers (`type === 'payment'`) never clamp or cap at $0.00;
 * an overpayment naturally inverts the debtor/creditor balances past zero.
 *
 * Positive balance = Creditor (is owed money)
 * Negative balance = Debtor (owes money)
 */
export function calculateBalancesByCurrency(
  members: MemberRecord[],
  expenses: ExpenseRecord[]
): Map<string, Map<string, number>> {
  const normalizeCurrencyFamily = (rawCur?: string): string =>
    normalizeCurrencyCode(rawCur);

  // Preserve the caller's preferred label ('$' vs 'USD', '€' vs 'EUR') per currency family
  const familyLabelMap = new Map<string, string>();
  for (const e of expenses) {
    const raw = (e.currency || 'USD').trim();
    const fam = normalizeCurrencyFamily(raw);
    if (!familyLabelMap.has(fam)) {
      familyLabelMap.set(fam, raw);
    }
  }

  const currencyBalances = new Map<string, Map<string, number>>();

  for (const [family, label] of familyLabelMap.entries()) {
    const balances = new Map<string, number>();

    // Initialize all members with 0 cents
    for (const m of members) {
      balances.set(m.id, 0);
    }

    const curExpenses = expenses.filter(
      (e) => normalizeCurrencyFamily(e.currency) === family
    );

    for (const exp of curExpenses) {
      const payerId = exp.paidByMemberId || exp.payerId || '';
      const totalCents =
        typeof exp.amountCents === 'number'
          ? Math.round(exp.amountCents)
          : Math.round((exp.amount || 0) * 100);

      if (!payerId || totalCents <= 0) continue;

      // Resolve effective splits: if an expense row is missing splits (e.g. orphaned in DB),
      // fall back to splitting equally across all group members so zero-sum conservation holds.
      const effectiveSplits =
        exp.splits && exp.splits.length > 0
          ? exp.splits
          : exp.type !== 'payment' && members.length > 0
            ? splitAmountEqually(
                totalCents,
                members.map((m) => m.id)
              )
            : [];

      if (effectiveSplits.length === 0) continue;

      let allocatedTotalCents = 0;

      // Deduct each participant's split share (Expense share owed OR Direct Payment received) -> debit participant (-splitCents)
      for (const split of effectiveSplits) {
        const participantId = split.memberId || split.userId || '';
        if (!participantId) continue;

        const rawSplitCents =
          typeof split.splitAmountCents === 'number'
            ? Math.round(split.splitAmountCents)
            : Math.round((split.amount || 0) * 100);

        const splitCents =
          exp.type === 'payment' &&
          effectiveSplits.length === 1 &&
          rawSplitCents <= 0
            ? totalCents
            : rawSplitCents;

        if (splitCents <= 0) continue;

        allocatedTotalCents += splitCents;
        const currentPartBalance = balances.get(participantId) || 0;
        balances.set(participantId, currentPartBalance - splitCents);
      }

      // Payer paid total allocated amount (Expense fronted OR Direct Payment sent) -> credit payer (+allocatedTotalCents)
      // Strictly matches sum of debited splits so SUM(balances) === 0 is invariant and never clamps at 0.
      if (allocatedTotalCents > 0) {
        const currentPayerBalance = balances.get(payerId) || 0;
        balances.set(payerId, currentPayerBalance + allocatedTotalCents);
      }
    }

    currencyBalances.set(label, balances);
  }

  return currencyBalances;
}

/**
 * Calculates cumulative per-member breakdown (Paid Out-of-Pocket vs. Accrued Share vs. Net Balance)
 * for a specific currency family ('USD' / '$' or 'EUR' / '€').
 *
 * - `paidCents`: Sum of `amountCents` for `type === 'expense'` where `paidByMemberId === member.id` (excludes `type === 'payment'`)
 * - `shareCents`: Sum of `splitAmountCents` for `type === 'expense'` allocated to `member.id` (excludes `type === 'payment'`)
 * - `netBalanceCents`: Net balance in cents including both expenses and direct settlement payments
 */
export function calculateMemberBreakdown(
  members: MemberRecord[],
  expenses: ExpenseRecord[],
  targetCurrency: string = 'USD'
): MemberSummaryRecord[] {
  const normalizeCurrencyFamily = (rawCur?: string): string =>
    normalizeCurrencyCode(rawCur);

  const targetFamily = normalizeCurrencyFamily(targetCurrency);
  const paidMap = new Map<string, number>();
  const shareMap = new Map<string, number>();
  const netMap = new Map<string, number>();

  for (const m of members) {
    paidMap.set(m.id, 0);
    shareMap.set(m.id, 0);
    netMap.set(m.id, 0);
  }

  const curExpenses = expenses.filter(
    (e) => normalizeCurrencyFamily(e.currency) === targetFamily
  );

  for (const exp of curExpenses) {
    const payerId = exp.paidByMemberId || exp.payerId || '';
    const totalCents =
      typeof exp.amountCents === 'number'
        ? Math.round(exp.amountCents)
        : Math.round((exp.amount || 0) * 100);

    if (!payerId || totalCents <= 0) continue;

    const effectiveSplits =
      exp.splits && exp.splits.length > 0
        ? exp.splits
        : exp.type !== 'payment' && members.length > 0
          ? splitAmountEqually(
              totalCents,
              members.map((m) => m.id)
            )
          : [];

    if (effectiveSplits.length === 0) continue;

    let allocatedTotalCents = 0;

    for (const split of effectiveSplits) {
      const participantId = split.memberId || split.userId || '';
      if (!participantId) continue;

      const rawSplitCents =
        typeof split.splitAmountCents === 'number'
          ? Math.round(split.splitAmountCents)
          : Math.round((split.amount || 0) * 100);

      const splitCents =
        exp.type === 'payment' &&
        effectiveSplits.length === 1 &&
        rawSplitCents <= 0
          ? totalCents
          : rawSplitCents;

      if (splitCents <= 0) continue;

      allocatedTotalCents += splitCents;
      netMap.set(participantId, (netMap.get(participantId) || 0) - splitCents);

      if (exp.type === 'expense') {
        shareMap.set(
          participantId,
          (shareMap.get(participantId) || 0) + splitCents
        );
      }
    }

    if (allocatedTotalCents > 0) {
      netMap.set(payerId, (netMap.get(payerId) || 0) + allocatedTotalCents);
      if (exp.type === 'expense') {
        paidMap.set(
          payerId,
          (paidMap.get(payerId) || 0) + allocatedTotalCents
        );
      }
    }
  }

  return members.map((m) => ({
    memberId: m.id,
    memberName: m.name,
    paidCents: paidMap.get(m.id) || 0,
    shareCents: shareMap.get(m.id) || 0,
    netBalanceCents: netMap.get(m.id) || 0,
  }));
}

/**
 * Aggregates spending by category for a specific currency ('USD' / '$' or 'EUR' / '€').
 * Strictly includes only `type === 'expense'`, excluding settlement transfers (`type === 'payment'`).
 * Sorted descending by `amountCents` (highest-to-lowest spend).
 */
export function calculateCategorySpend(
  expenses: ExpenseRecord[],
  targetCurrency: string = 'USD'
): CategorySpendRecord[] {
  const normalizeCurrencyFamily = (rawCur?: string): string =>
    normalizeCurrencyCode(rawCur);

  const targetFamily = normalizeCurrencyFamily(targetCurrency);
  const categoryTotals = new Map<string, number>();
  let totalSpendCents = 0;

  for (const exp of expenses) {
    if (exp.type !== 'expense') continue;
    if (normalizeCurrencyFamily(exp.currency) !== targetFamily) continue;

    const cents =
      typeof exp.amountCents === 'number'
        ? Math.round(exp.amountCents)
        : Math.round((exp.amount || 0) * 100);
    if (cents <= 0) continue;

    const cat = (exp.category || '').trim() || 'General';
    categoryTotals.set(cat, (categoryTotals.get(cat) || 0) + cents);
    totalSpendCents += cents;
  }

  return Array.from(categoryTotals.entries())
    .map(([category, amountCents]) => ({
      category,
      amountCents,
      amountFormatted: (amountCents / 100).toFixed(2),
      percentage:
        totalSpendCents > 0 ? (amountCents / totalSpendCents) * 100 : 0,
    }))
    .sort((a, b) => {
      if (b.amountCents !== a.amountCents) {
        return b.amountCents - a.amountCents;
      }
      return a.category.localeCompare(b.category);
    });
}

/**
 * Computes optimal settlement transfers using a greedy cash-flow minimization
 * algorithm, strictly isolating each currency.
 * Pairs the largest debtor with the largest creditor to minimize total transactions.
 */
export function calculateSettlements(
  members: MemberRecord[],
  expenses: ExpenseRecord[]
): SettlementInstruction[] {
  const memberNameMap = new Map<string, string>();
  for (const m of members) {
    memberNameMap.set(m.id, m.name);
  }

  const currencyBalances = calculateBalancesByCurrency(members, expenses);
  const instructions: SettlementInstruction[] = [];

  for (const [cur, balances] of currencyBalances.entries()) {
    const debtors: { memberId: string; amountCents: number }[] = [];
    const creditors: { memberId: string; amountCents: number }[] = [];

    for (const [memberId, balCents] of balances.entries()) {
      if (balCents < 0) {
        debtors.push({ memberId, amountCents: Math.abs(balCents) });
      } else if (balCents > 0) {
        creditors.push({ memberId, amountCents: balCents });
      }
    }

    // Sort descending by magnitude (largest amounts first)
    debtors.sort((a, b) => b.amountCents - a.amountCents);
    creditors.sort((a, b) => b.amountCents - a.amountCents);

    let d = 0;
    let c = 0;

    while (d < debtors.length && c < creditors.length) {
      const debtor = debtors[d];
      const creditor = creditors[c];
      const transferCents = Math.min(debtor.amountCents, creditor.amountCents);

      if (transferCents > 0) {
        const fromName = memberNameMap.get(debtor.memberId) || 'Unknown Member';
        const toName = memberNameMap.get(creditor.memberId) || 'Unknown Member';
        const amountFormatted = (transferCents / 100).toFixed(2);

        instructions.push({
          fromMemberId: debtor.memberId,
          fromMemberName: fromName,
          toMemberId: creditor.memberId,
          toMemberName: toName,
          amountCents: transferCents,
          amountFormatted,
          currency: cur,
          fromUser: fromName,
          toUser: toName,
          amount: Number(amountFormatted),
        });
      }

      debtor.amountCents -= transferCents;
      creditor.amountCents -= transferCents;

      if (debtor.amountCents === 0) d++;
      if (creditor.amountCents === 0) c++;
    }
  }

  return instructions;
}

export interface UnifiedReconciliationResult {
  targetCurrency: string;
  memberBreakdown: MemberSummaryRecord[];
  settlements: SettlementInstruction[];
}

/**
 * Converts a cent amount from `fromCurrency` into `targetCurrency` using `exchangeRates`.
 *
 * `exchangeRates` maps currency codes (e.g. 'AUD', 'THB', 'EUR') to how many units of that
 * currency equal 1 unit of the rate base (typically `1 targetCurrency = rate fromCurrency`,
 * so `targetAmount = fromAmount / rate`, or `fromAmount * (rates[target] / rates[from])` if cross-rates exist).
 */
export function convertCentsToTargetCurrency(
  amountCents: number,
  fromCurrency: string,
  targetCurrency: string,
  exchangeRates: Record<string, number> = {}
): number {
  const fromCode = normalizeCurrencyCode(fromCurrency);
  const targetCode = normalizeCurrencyCode(targetCurrency);
  if (fromCode === targetCode || amountCents === 0) {
    return amountCents;
  }

  const rawFromRate = Number(exchangeRates[fromCode]);
  const rawTargetRate = Number(exchangeRates[targetCode]);
  const hasFrom = Number.isFinite(rawFromRate) && rawFromRate > 0;
  const hasTarget = Number.isFinite(rawTargetRate) && rawTargetRate > 0;

  if (hasFrom && hasTarget) {
    return amountCents * (rawTargetRate / rawFromRate);
  }
  if (hasFrom) {
    // exchangeRates is quoted relative to targetCode (1 targetCode = rawFromRate fromCode)
    return amountCents / rawFromRate;
  }
  if (hasTarget) {
    // exchangeRates is quoted relative to fromCode (1 fromCode = rawTargetRate targetCode)
    return amountCents * rawTargetRate;
  }

  // Last-resort built-in static approximate fallback so foreign currencies never silently fall back to 1:1
  const approx = getStaticApproxExchangeRate(fromCode, targetCode);
  return amountCents * (approx ?? 1);
}

/**
 * Resolves the per-transaction FX multiplier (`1 unit of expCurrency = mult units of targetCurrency`).
 *
 * Priority:
 * 1. Transaction's own locked `fxRates` (`fxRates[targetCode] / fxRates[expCode]`), or bridged via a shared currency.
 * 2. Group-level `fallbackExchangeRates` (`1 targetCurrency = X expCurrency` or inverse) for legacy unlocked rows.
 * 3. Built-in static approximate fallback table (`STATIC_APPROX_RATES_PER_USD`) so `expCode !== targetCode` never silently defaults to `1`.
 */
export function resolveExpenseFxMultiplier(
  expCurrency: string,
  targetCurrency: string,
  expFxRates?: FxRatesMap | null,
  fallbackExchangeRates: Record<string, number> = {}
): number {
  const expCode = normalizeCurrencyCode(expCurrency);
  const targetCode = normalizeCurrencyCode(targetCurrency);
  if (expCode === targetCode) return 1;

  const normalizedFx = normalizeFxRatesMap(expFxRates, expCode);
  if (normalizedFx) {
    const baseSelf =
      Number.isFinite(normalizedFx[expCode]) && normalizedFx[expCode] > 0
        ? normalizedFx[expCode]
        : 1;

    if (
      Number.isFinite(normalizedFx[targetCode]) &&
      normalizedFx[targetCode] > 0
    ) {
      return normalizedFx[targetCode] / baseSelf;
    }

    // Bridge via any shared currency present in both normalizedFx and fallbackExchangeRates
    for (const [pivotCode, pivotVal] of Object.entries(normalizedFx)) {
      if (pivotCode === expCode || !Number.isFinite(pivotVal) || pivotVal <= 0) {
        continue;
      }
      if (
        pivotCode in fallbackExchangeRates &&
        Number(fallbackExchangeRates[pivotCode]) > 0
      ) {
        const expToPivot = pivotVal / baseSelf;
        const pivotToTarget = convertCentsToTargetCurrency(
          1,
          pivotCode,
          targetCode,
          fallbackExchangeRates
        );
        if (Number.isFinite(pivotToTarget) && pivotToTarget > 0) {
          return expToPivot * pivotToTarget;
        }
      }
    }

    // Bridge via a shared pivot in built-in approximate rates (e.g. USD)
    for (const [pivotCode, pivotVal] of Object.entries(normalizedFx)) {
      if (pivotCode === expCode || !Number.isFinite(pivotVal) || pivotVal <= 0) {
        continue;
      }
      const pivotToTarget = getStaticApproxExchangeRate(pivotCode, targetCode);
      if (pivotToTarget && pivotToTarget > 0) {
        return (pivotVal / baseSelf) * pivotToTarget;
      }
    }
  }

  return convertCentsToTargetCurrency(
    1,
    expCode,
    targetCode,
    fallbackExchangeRates
  );
}

/**
 * Aggregates spending by category across all currencies converted into `targetCurrency`,
 * converting each transaction at its locked `fxRates` (falling back to `exchangeRates` only for legacy unlocked rows).
 */
export function calculateUnifiedCategorySpend(
  expenses: ExpenseRecord[],
  targetCurrency: string = 'USD',
  exchangeRates: Record<string, number> = {}
): CategorySpendRecord[] {
  const targetCode = normalizeCurrencyCode(targetCurrency);
  const categoryTotals = new Map<string, number>();
  let totalSpendCents = 0;

  for (const exp of expenses) {
    if (exp.type !== 'expense') continue;
    const rawCents =
      typeof exp.amountCents === 'number'
        ? Math.round(exp.amountCents)
        : Math.round((exp.amount || 0) * 100);
    if (rawCents <= 0) continue;

    const expCode = normalizeCurrencyCode(exp.currency);
    const mult = resolveExpenseFxMultiplier(
      expCode,
      targetCode,
      exp.fxRates,
      exchangeRates
    );
    const convertedCents =
      expCode === targetCode ? rawCents : Math.round(rawCents * mult);
    if (convertedCents <= 0) continue;

    const cat = (exp.category || '').trim() || 'General';
    categoryTotals.set(cat, (categoryTotals.get(cat) || 0) + convertedCents);
    totalSpendCents += convertedCents;
  }

  return Array.from(categoryTotals.entries())
    .map(([category, amountCents]) => ({
      category,
      amountCents,
      amountFormatted: (amountCents / 100).toFixed(2),
      percentage:
        totalSpendCents > 0 ? (amountCents / totalSpendCents) * 100 : 0,
    }))
    .sort((a, b) => {
      if (b.amountCents !== a.amountCents) {
        return b.amountCents - a.amountCents;
      }
      return a.category.localeCompare(b.category);
    });
}

/**
 * Calculates a unified cross-currency Member Breakdown and greedy Cash-Flow Minimization
 * Settlement Plan converted into `targetCurrency`.
 *
 * Converts each transaction and its splits individually using that transaction's own
 * locked `expense.fxRates` (falling back to `exchangeRates` only for legacy unlocked rows).
 * Uses Largest Remainder per transaction so `SUM(convertedSplits) === convertedAmountCents`
 * and `SUM(netBalanceCents) === 0` hold strictly without end-of-trip drift.
 */
export function calculateUnifiedReconciliation(
  members: MemberRecord[],
  expenses: ExpenseRecord[],
  targetCurrency: string = 'USD',
  exchangeRates: Record<string, number> = {}
): UnifiedReconciliationResult {
  const targetCode = normalizeCurrencyCode(targetCurrency);
  if (!members || members.length === 0) {
    return {
      targetCurrency: targetCode,
      memberBreakdown: [],
      settlements: [],
    };
  }

  const memberOrderMap = new Map<string, number>();
  const paidByMember = new Map<string, number>();
  const shareByMember = new Map<string, number>();
  const netByMember = new Map<string, number>();

  members.forEach((m, idx) => {
    memberOrderMap.set(m.id, idx);
    paidByMember.set(m.id, 0);
    shareByMember.set(m.id, 0);
    netByMember.set(m.id, 0);
  });

  for (const exp of expenses) {
    const payerId = exp.paidByMemberId || exp.payerId || '';
    const totalCents =
      typeof exp.amountCents === 'number'
        ? Math.round(exp.amountCents)
        : Math.round((exp.amount || 0) * 100);

    if (!payerId || totalCents <= 0) continue;

    const effectiveSplits =
      exp.splits && exp.splits.length > 0
        ? exp.splits
        : exp.type !== 'payment' && members.length > 0
          ? splitAmountEqually(
              totalCents,
              members.map((m) => m.id)
            )
          : [];

    if (effectiveSplits.length === 0) continue;

    const validSplits: Array<{
      participantId: string;
      splitCents: number;
      index: number;
      memberOrder: number;
    }> = [];
    let allocatedTotalCents = 0;

    for (let i = 0; i < effectiveSplits.length; i++) {
      const split = effectiveSplits[i];
      const participantId = split.memberId || split.userId || '';
      if (!participantId) continue;

      const rawSplitCents =
        typeof split.splitAmountCents === 'number'
          ? Math.round(split.splitAmountCents)
          : Math.round((split.amount || 0) * 100);

      const splitCents =
        exp.type === 'payment' &&
        effectiveSplits.length === 1 &&
        rawSplitCents <= 0
          ? totalCents
          : rawSplitCents;

      if (splitCents <= 0) continue;

      allocatedTotalCents += splitCents;
      validSplits.push({
        participantId,
        splitCents,
        index: i,
        memberOrder: memberOrderMap.get(participantId) ?? i,
      });
    }

    if (allocatedTotalCents <= 0 || validSplits.length === 0) continue;

    const expCode = normalizeCurrencyCode(exp.currency);
    const mult = resolveExpenseFxMultiplier(
      expCode,
      targetCode,
      exp.fxRates,
      exchangeRates
    );

    let convertedTotalCents: number;
    let convertedSplits: Array<{
      participantId: string;
      convertedCents: number;
    }>;

    if (expCode === targetCode || Math.abs(mult - 1) < 1e-12) {
      convertedTotalCents = allocatedTotalCents;
      convertedSplits = validSplits.map((s) => ({
        participantId: s.participantId,
        convertedCents: s.splitCents,
      }));
    } else {
      convertedTotalCents = Math.round(allocatedTotalCents * mult);
      if (convertedTotalCents <= 0) continue;

      const allocations = validSplits.map((s) => {
        const exact = s.splitCents * mult;
        const floored = Math.max(0, Math.floor(exact));
        const fraction = exact - floored;
        return {
          ...s,
          floored,
          fraction,
          adjusted: floored,
        };
      });

      const sumFloored = allocations.reduce((acc, a) => acc + a.floored, 0);
      let remainder = convertedTotalCents - sumFloored;

      if (remainder > 0) {
        const sortedDesc = [...allocations].sort((a, b) => {
          if (Math.abs(b.fraction - a.fraction) > 1e-9) {
            return b.fraction - a.fraction;
          }
          if (a.memberOrder !== b.memberOrder) {
            return a.memberOrder - b.memberOrder;
          }
          return a.index - b.index;
        });
        let idx = 0;
        while (remainder > 0 && sortedDesc.length > 0) {
          sortedDesc[idx % sortedDesc.length].adjusted += 1;
          remainder--;
          idx++;
        }
      } else if (remainder < 0) {
        const sortedAsc = [...allocations]
          .filter((a) => a.adjusted > 0)
          .sort((a, b) => {
            if (Math.abs(a.fraction - b.fraction) > 1e-9) {
              return a.fraction - b.fraction;
            }
            if (b.memberOrder !== a.memberOrder) {
              return b.memberOrder - a.memberOrder;
            }
            return b.index - a.index;
          });
        let idx = 0;
        while (remainder < 0 && sortedAsc.length > 0) {
          const target = sortedAsc[idx % sortedAsc.length];
          if (target.adjusted > 0) {
            target.adjusted -= 1;
            remainder++;
          }
          idx++;
        }
      }

      convertedSplits = allocations.map((a) => ({
        participantId: a.participantId,
        convertedCents: a.adjusted,
      }));
    }

    // Credit payer (+convertedTotalCents) and debit participants (-convertedCents)
    netByMember.set(
      payerId,
      (netByMember.get(payerId) || 0) + convertedTotalCents
    );
    if (exp.type === 'expense') {
      paidByMember.set(
        payerId,
        (paidByMember.get(payerId) || 0) + convertedTotalCents
      );
    }

    for (const cs of convertedSplits) {
      netByMember.set(
        cs.participantId,
        (netByMember.get(cs.participantId) || 0) - cs.convertedCents
      );
      if (exp.type === 'expense') {
        shareByMember.set(
          cs.participantId,
          (shareByMember.get(cs.participantId) || 0) + cs.convertedCents
        );
      }
    }
  }

  const memberBreakdown: MemberSummaryRecord[] = members.map((m) => ({
    memberId: m.id,
    memberName: m.name,
    paidCents: paidByMember.get(m.id) || 0,
    shareCents: shareByMember.get(m.id) || 0,
    netBalanceCents: netByMember.get(m.id) || 0,
  }));

  // Run greedy cash-flow minimization on unified balances
  const debtors: { memberId: string; memberName: string; amountCents: number }[] =
    [];
  const creditors: {
    memberId: string;
    memberName: string;
    amountCents: number;
  }[] = [];

  for (const item of memberBreakdown) {
    if (item.netBalanceCents < 0) {
      debtors.push({
        memberId: item.memberId,
        memberName: item.memberName,
        amountCents: Math.abs(item.netBalanceCents),
      });
    } else if (item.netBalanceCents > 0) {
      creditors.push({
        memberId: item.memberId,
        memberName: item.memberName,
        amountCents: item.netBalanceCents,
      });
    }
  }

  debtors.sort((a, b) => b.amountCents - a.amountCents);
  creditors.sort((a, b) => b.amountCents - a.amountCents);

  const settlements: SettlementInstruction[] = [];
  let d = 0;
  let c = 0;

  while (d < debtors.length && c < creditors.length) {
    const debtor = debtors[d];
    const creditor = creditors[c];
    const transferCents = Math.min(debtor.amountCents, creditor.amountCents);

    if (transferCents > 0) {
      const amountFormatted = (transferCents / 100).toFixed(2);
      settlements.push({
        fromMemberId: debtor.memberId,
        fromMemberName: debtor.memberName,
        toMemberId: creditor.memberId,
        toMemberName: creditor.memberName,
        amountCents: transferCents,
        amountFormatted,
        currency: targetCode,
        fromUser: debtor.memberName,
        toUser: creditor.memberName,
        amount: Number(amountFormatted),
      });
    }

    debtor.amountCents -= transferCents;
    creditor.amountCents -= transferCents;

    if (debtor.amountCents === 0) d++;
    if (creditor.amountCents === 0) c++;
  }

  return {
    targetCurrency: targetCode,
    memberBreakdown,
    settlements,
  };
}

// ============================================================================
// Household / Family Sub-Group Rollup Helpers
// ============================================================================

export interface HouseholdMemberDetail {
  memberId: string;
  memberName: string;
  paidCents: number;
  shareCents: number;
  netBalanceCents: number;
}

export interface HouseholdSummaryRecord {
  householdKey: string;
  householdName: string;
  isHousehold: boolean;
  primaryMemberId: string;
  primaryMemberName: string;
  paidCents: number;
  shareCents: number;
  netBalanceCents: number;
  members: HouseholdMemberDetail[];
}

export interface HouseholdSettlementInstruction {
  fromHouseholdKey: string;
  fromHouseholdName: string;
  fromPrimaryMemberId: string;
  toHouseholdKey: string;
  toHouseholdName: string;
  toPrimaryMemberId: string;
  amountCents: number;
  amountFormatted: string;
  currency: string;
}

export interface HouseholdGroupOption {
  householdKey: string;
  householdName: string;
  memberIds: string[];
}

export function hasAnyHousehold(members: MemberRecord[]): boolean {
  return members.some((m) => (m.householdName || '').trim().length > 0);
}

/**
 * Extracts distinct non-empty household sub-groups in first-seen order
 * for quick-select chips in Add/Edit Transaction and Manage Members.
 */
export function getHouseholdGroups(
  members: MemberRecord[]
): HouseholdGroupOption[] {
  const byKey = new Map<string, HouseholdGroupOption>();
  for (const m of members) {
    const trimmed = (m.householdName || '').trim();
    if (!trimmed) continue;
    const key = `hh:${trimmed.toLowerCase()}`;
    const existing = byKey.get(key);
    if (existing) {
      existing.memberIds.push(m.id);
    } else {
      byKey.set(key, {
        householdKey: key,
        householdName: trimmed,
        memberIds: [m.id],
      });
    }
  }
  return Array.from(byKey.values());
}

/**
 * Aggregates individual member Paid, Share, and Net Balance rows by `household_name`
 * (case-insensitive grouping; members without a `household_name` remain 1-person units).
 *
 * Selects each household's `primaryMemberId` deterministically as the member with the
 * largest combined paid + net activity so recorded settlement payments use valid member IDs.
 */
export function groupMemberBreakdownByHousehold(
  members: MemberRecord[],
  memberBreakdown: MemberSummaryRecord[]
): HouseholdSummaryRecord[] {
  const memberMetaMap = new Map<string, MemberRecord>();
  for (const m of members) {
    memberMetaMap.set(m.id, m);
  }

  const buckets = new Map<
    string,
    {
      householdKey: string;
      householdName: string;
      isHousehold: boolean;
      paidCents: number;
      shareCents: number;
      netBalanceCents: number;
      members: HouseholdMemberDetail[];
    }
  >();

  for (const row of memberBreakdown) {
    const meta = memberMetaMap.get(row.memberId);
    const trimmedHousehold = (meta?.householdName || '').trim();
    const isHousehold = trimmedHousehold.length > 0;
    const key = isHousehold
      ? `hh:${trimmedHousehold.toLowerCase()}`
      : `ind:${row.memberId}`;
    const displayName = isHousehold ? trimmedHousehold : row.memberName;

    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = {
        householdKey: key,
        householdName: displayName,
        isHousehold,
        paidCents: 0,
        shareCents: 0,
        netBalanceCents: 0,
        members: [],
      };
      buckets.set(key, bucket);
    }

    bucket.paidCents += row.paidCents;
    bucket.shareCents += row.shareCents;
    bucket.netBalanceCents += row.netBalanceCents;
    bucket.members.push({
      memberId: row.memberId,
      memberName: row.memberName,
      paidCents: row.paidCents,
      shareCents: row.shareCents,
      netBalanceCents: row.netBalanceCents,
    });
  }

  return Array.from(buckets.values()).map((b) => {
    let primary = b.members[0];
    let bestScore = -1;
    for (const m of b.members) {
      const score = Math.abs(m.paidCents) + Math.abs(m.netBalanceCents);
      if (
        score > bestScore ||
        (score === bestScore && m.paidCents > (primary?.paidCents ?? -1))
      ) {
        bestScore = score;
        primary = m;
      }
    }

    return {
      householdKey: b.householdKey,
      householdName: b.householdName,
      isHousehold: b.isHousehold,
      primaryMemberId: primary?.memberId || '',
      primaryMemberName: primary?.memberName || b.householdName,
      paidCents: b.paidCents,
      shareCents: b.shareCents,
      netBalanceCents: b.netBalanceCents,
      members: b.members,
    };
  });
}

/**
 * Runs greedy cash-flow minimization on already-netted household balances so
 * intra-household balances cancel out BEFORE computing inter-household transfers.
 */
export function calculateHouseholdSettlementsFromBreakdown(
  householdBreakdown: HouseholdSummaryRecord[],
  currency: string
): HouseholdSettlementInstruction[] {
  const code = normalizeCurrencyCode(currency);
  const debtors: Array<{
    householdKey: string;
    householdName: string;
    primaryMemberId: string;
    amountCents: number;
  }> = [];
  const creditors: Array<{
    householdKey: string;
    householdName: string;
    primaryMemberId: string;
    amountCents: number;
  }> = [];

  for (const row of householdBreakdown) {
    if (row.netBalanceCents < 0) {
      debtors.push({
        householdKey: row.householdKey,
        householdName: row.householdName,
        primaryMemberId: row.primaryMemberId,
        amountCents: Math.abs(row.netBalanceCents),
      });
    } else if (row.netBalanceCents > 0) {
      creditors.push({
        householdKey: row.householdKey,
        householdName: row.householdName,
        primaryMemberId: row.primaryMemberId,
        amountCents: row.netBalanceCents,
      });
    }
  }

  debtors.sort((a, b) => b.amountCents - a.amountCents);
  creditors.sort((a, b) => b.amountCents - a.amountCents);

  const instructions: HouseholdSettlementInstruction[] = [];
  let d = 0;
  let c = 0;

  while (d < debtors.length && c < creditors.length) {
    const debtor = debtors[d];
    const creditor = creditors[c];
    const transferCents = Math.min(debtor.amountCents, creditor.amountCents);

    if (transferCents > 0) {
      instructions.push({
        fromHouseholdKey: debtor.householdKey,
        fromHouseholdName: debtor.householdName,
        fromPrimaryMemberId: debtor.primaryMemberId,
        toHouseholdKey: creditor.householdKey,
        toHouseholdName: creditor.householdName,
        toPrimaryMemberId: creditor.primaryMemberId,
        amountCents: transferCents,
        amountFormatted: (transferCents / 100).toFixed(2),
        currency: code,
      });
    }

    debtor.amountCents -= transferCents;
    creditor.amountCents -= transferCents;

    if (debtor.amountCents === 0) d++;
    if (creditor.amountCents === 0) c++;
  }

  return instructions;
}

/**
 * Per-currency Household rollup & settlement plan.
 */
export function calculateHouseholdReconciliation(
  members: MemberRecord[],
  expenses: ExpenseRecord[],
  currency: string = 'USD'
): {
  currency: string;
  householdBreakdown: HouseholdSummaryRecord[];
  settlements: HouseholdSettlementInstruction[];
} {
  const code = normalizeCurrencyCode(currency);
  const individualBreakdown = calculateMemberBreakdown(members, expenses, code);
  const householdBreakdown = groupMemberBreakdownByHousehold(
    members,
    individualBreakdown
  );
  const settlements = calculateHouseholdSettlementsFromBreakdown(
    householdBreakdown,
    code
  );
  return { currency: code, householdBreakdown, settlements };
}

/**
 * Unified cross-currency Household rollup & settlement plan.
 */
export function calculateUnifiedHouseholdReconciliation(
  members: MemberRecord[],
  expenses: ExpenseRecord[],
  targetCurrency: string = 'USD',
  exchangeRates: Record<string, number> = {}
): {
  targetCurrency: string;
  householdBreakdown: HouseholdSummaryRecord[];
  settlements: HouseholdSettlementInstruction[];
} {
  const unified = calculateUnifiedReconciliation(
    members,
    expenses,
    targetCurrency,
    exchangeRates
  );
  const householdBreakdown = groupMemberBreakdownByHousehold(
    members,
    unified.memberBreakdown
  );
  const settlements = calculateHouseholdSettlementsFromBreakdown(
    householdBreakdown,
    unified.targetCurrency
  );
  return {
    targetCurrency: unified.targetCurrency,
    householdBreakdown,
    settlements,
  };
}

/**
 * Guard check to prevent deleting a member who is involved in any group transaction.
 * A member cannot be deleted if they are a payer or a split participant in any transaction.
 */
export function canDeleteMember(
  memberId: string,
  expenses: ExpenseRecord[]
): { canDelete: boolean; reason?: string } {
  if (!memberId) {
    return { canDelete: false, reason: 'Invalid member ID.' };
  }

  for (const exp of expenses) {
    const payerId = exp.paidByMemberId || exp.payerId;
    if (payerId === memberId) {
      return {
        canDelete: false,
        reason: `Cannot delete member: They are recorded as the payer for transaction "${exp.description || 'Expense'}".`,
      };
    }

    const isParticipant = exp.splits.some(
      (s) => (s.memberId || s.userId) === memberId
    );
    if (isParticipant) {
      return {
        canDelete: false,
        reason: `Cannot delete member: They are included as a split participant in transaction "${exp.description || 'Expense'}".`,
      };
    }
  }

  return { canDelete: true };
}

/**
 * Distributes an integer amount in cents across members according to percentage shares.
 * Validates that the sum of percentages equals 100% (within 0.01% tolerance).
 * Uses the Largest Remainder Method (with deterministic tie-breaking by order) so that:
 * SUM(allocated cents) === totalAmountCents without losing or inventing pennies.
 */
export function splitAmountByPercentage(
  totalAmountCents: number,
  memberPercentages: Record<string, number>
): Record<string, number> {
  if (totalAmountCents <= 0 || !memberPercentages) {
    return {};
  }

  const entries = Object.entries(memberPercentages).filter(
    ([id, pct]) => Boolean(id) && typeof pct === 'number' && !isNaN(pct) && pct > 0
  );

  if (entries.length === 0) {
    return {};
  }

  // Reject any negative percentage
  if (Object.values(memberPercentages).some((pct) => pct < 0)) {
    return {};
  }

  const totalPercentage = entries.reduce((acc, [, pct]) => acc + pct, 0);
  if (Math.abs(totalPercentage - 100) > 0.01) {
    return {};
  }

  const rawAllocations = entries.map(([memberId, percentage], index) => {
    const exactCents = (totalAmountCents * percentage) / 100;
    const flooredCents = Math.floor(exactCents + 1e-9);
    const fraction = exactCents - flooredCents;
    return {
      memberId,
      index,
      flooredCents,
      fraction,
    };
  });

  const sumFloored = rawAllocations.reduce((acc, a) => acc + a.flooredCents, 0);
  let remainder = Math.round(totalAmountCents - sumFloored);

  // Sort by largest fractional remainder descending, then original index ascending
  const byRemainder = [...rawAllocations].sort((a, b) => {
    if (Math.abs(b.fraction - a.fraction) > 1e-7) {
      return b.fraction - a.fraction;
    }
    return a.index - b.index;
  });

  const bonusByIndex = new Map<number, number>();
  for (let i = 0; i < byRemainder.length && remainder > 0; i++) {
    bonusByIndex.set(byRemainder[i].index, 1);
    remainder--;
  }

  const result: Record<string, number> = {};
  for (const a of rawAllocations) {
    result[a.memberId] = a.flooredCents + (bonusByIndex.get(a.index) || 0);
  }

  return result;
}

/**
 * Verifies that exact integer cent allocations are non-negative and sum strictly to totalAmountCents.
 */
export function validateExactSplits(
  totalAmountCents: number,
  memberAmountsCents: Record<string, number>
): boolean {
  if (totalAmountCents <= 0 || !memberAmountsCents) {
    return false;
  }

  const values = Object.values(memberAmountsCents);
  if (values.length === 0) {
    return false;
  }

  let sumCents = 0;
  for (const rawCents of values) {
    if (typeof rawCents !== 'number' || isNaN(rawCents) || rawCents < 0) {
      return false;
    }
    sumCents += Math.round(rawCents);
  }

  return sumCents === Math.round(totalAmountCents);
}

// ============================================================================
// Single Unified CSV Import & Export Engine
// ============================================================================

export interface ParsedCsvTransaction {
  date: string;
  description: string;
  category: string;
  amountCents: number;
  currency: string;
  currencySymbol: string;
  type: 'expense' | 'payment';
  paidByMemberName: string;
  fxRates?: FxRatesMap | null;
  splits: {
    memberName: string;
    splitAmountCents: number;
  }[];
}

export interface ParsedGroupCsvResult {
  memberNames: string[];
  transactions: ParsedCsvTransaction[];
}

/**
 * Parses a single CSV line respecting RFC-4180 quoted fields.
 */
export function parseCsvLine(line: string): string[] {
  const result: string[] = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (i + 1 < line.length && line[i + 1] === '"') {
          current += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        current += ch;
      }
    } else {
      if (ch === '"') {
        inQuotes = true;
      } else if (ch === ',') {
        result.push(current);
        current = '';
      } else {
        current += ch;
      }
    }
  }
  result.push(current);
  return result;
}

/**
 * Parses a unified Settle Up CSV string into member names and exact cent transactions.
 *
 * Header format:
 *   Date,Description,Category,Cost,Currency,<Member 1>,<Member 2>,[,FX_Rates]
 *
 * Rules:
 * - Reads member names from header index 5 (6th column) onward, excluding optional trailing `FX_Rates`.
 * - Skips empty lines and the 'Total balance' summary row (Description === 'Total balance' or Cost is empty).
 * - Reconstructs paidByMemberName (column where valCents > 0) and exact expense_splits:
 *   - For any member with valCents < 0: split_amount_cents = Math.abs(valCents)
 *   - For the payer (valCents > 0): if amount_cents - valCents > 0, split_amount_cents = amount_cents - valCents
 * - Parses optional `FX_Rates` JSON metadata per row when present.
 */
export function parseGroupCsv(csvContent: string): ParsedGroupCsvResult {
  const lines = csvContent
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .split('\n');

  let headerCols: string[] | null = null;
  let memberColsMeta: Array<{ name: string; colIndex: number }> = [];
  let fxRatesColIndex = -1;
  const transactions: ParsedCsvTransaction[] = [];

  for (const rawLine of lines) {
    const trimmedLine = rawLine.trim();
    if (!trimmedLine) continue;

    const cols = parseCsvLine(rawLine);

    if (!headerCols) {
      headerCols = cols.map((c) => c.trim());
      memberColsMeta = [];
      for (let idx = 5; idx < headerCols.length; idx++) {
        const colName = headerCols[idx];
        if (!colName) continue;
        const lower = colName.toLowerCase();
        if (lower === 'fx_rates' || lower === 'fx rates') {
          fxRatesColIndex = idx;
          continue;
        }
        memberColsMeta.push({ name: colName, colIndex: idx });
      }
      continue;
    }

    const rawDate = (cols[0] || '').trim();
    const rawDescription = (cols[1] || '').trim();
    const rawCategory = (cols[2] || '').trim();
    const rawCost = (cols[3] || '').trim();
    const rawCurrency = (cols[4] || '').trim();

    // Skip summary / 'Total balance' row or rows with empty Cost
    if (
      rawDescription.toLowerCase() === 'total balance' ||
      rawCost === ''
    ) {
      continue;
    }

    const parsedCost = parseFloat(rawCost);
    if (isNaN(parsedCost) || parsedCost <= 0) {
      continue;
    }

    const amountCents = Math.round(parsedCost * 100);
    const type: 'expense' | 'payment' =
      rawCategory.toLowerCase() === 'payment' ? 'payment' : 'expense';
    const currency = normalizeCurrencyCode(rawCurrency);
    const currencySymbol = getCurrencySymbol(currency).trim();

    let paidByMemberName = '';
    const splits: { memberName: string; splitAmountCents: number }[] = [];

    for (const { name: memberName, colIndex } of memberColsMeta) {
      const rawCell = (cols[colIndex] || '0').trim();
      const parsedVal = parseFloat(rawCell || '0');
      if (isNaN(parsedVal)) continue;

      const valCents = Math.round(parsedVal * 100);

      if (valCents > 0) {
        paidByMemberName = memberName;
        const payerShareCents = amountCents - valCents;
        if (payerShareCents > 0) {
          splits.push({
            memberName,
            splitAmountCents: payerShareCents,
          });
        }
      } else if (valCents < 0) {
        splits.push({
          memberName,
          splitAmountCents: Math.abs(valCents),
        });
      }
    }

    if (!paidByMemberName) {
      continue;
    }

    let fxRates: FxRatesMap | null = null;
    if (fxRatesColIndex >= 0) {
      const rawFxCell = (cols[fxRatesColIndex] || '').trim();
      if (rawFxCell) {
        try {
          const parsedJson = JSON.parse(rawFxCell);
          fxRates = normalizeFxRatesMap(parsedJson, currency);
        } catch {
          fxRates = null;
        }
      }
    }

    transactions.push({
      date: rawDate || new Date().toISOString().split('T')[0],
      description:
        rawDescription ||
        (type === 'payment' ? 'Direct Payment' : 'Group Expense'),
      category: rawCategory || (type === 'payment' ? 'Payment' : 'General'),
      amountCents,
      currency,
      currencySymbol,
      type,
      paidByMemberName,
      ...(fxRates ? { fxRates } : {}),
      splits,
    });
  }

  return {
    memberNames: memberColsMeta.map((m) => m.name),
    transactions,
  };
}

function escapeCsvCell(value: string): string {
  if (
    value.includes(',') ||
    value.includes('"') ||
    value.includes('\n') ||
    value.includes('\r')
  ) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

export interface CsvExportExpense extends ExpenseRecord {
  date?: string;
  category?: string;
}

/**
 * Generates the unified Settle Up CSV export string matching `<slug>_<YYYY-MM-DD>_export.csv`.
 * Appends an optional trailing `FX_Rates` JSON metadata column when any exported transaction has locked `fxRates`.
 */
export function generateGroupCsv(
  members: MemberRecord[],
  expenses: CsvExportExpense[],
  exportDateStr?: string
): string {
  const todayStr =
    exportDateStr || new Date().toISOString().split('T')[0];

  const includeFxColumn = expenses.some(
    (exp) => Boolean(normalizeFxRatesMap(exp.fxRates, exp.currency))
  );

  const headerCols = [
    'Date',
    'Description',
    'Category',
    'Cost',
    'Currency',
    ...members.map((m) => escapeCsvCell(m.name)),
  ];
  if (includeFxColumn) {
    headerCols.push('FX_Rates');
  }
  const headerRow = headerCols.join(',');

  // Track net balances per currency code ('USD' | 'EUR' | ...) in integer cents
  const netBalancesByCurrency = new Map<string, Map<string, number>>();
  const ensureCurrencyMap = (curCode: string) => {
    if (!netBalancesByCurrency.has(curCode)) {
      const mMap = new Map<string, number>();
      for (const m of members) {
        mMap.set(m.id, 0);
      }
      netBalancesByCurrency.set(curCode, mMap);
    }
    return netBalancesByCurrency.get(curCode)!;
  };

  // Sort chronological ascending for export ledger (or preserve order if dates match)
  const sortedExpenses = [...expenses].sort((a, b) => {
    const dateA = a.date || '';
    const dateB = b.date || '';
    if (dateA !== dateB) return dateA.localeCompare(dateB);
    return 0;
  });

  const transactionRows: string[] = [];

  for (const exp of sortedExpenses) {
    const payerId = exp.paidByMemberId || exp.payerId || '';
    const totalCents =
      typeof exp.amountCents === 'number'
        ? Math.round(exp.amountCents)
        : Math.round((exp.amount || 0) * 100);
    if (!payerId || totalCents <= 0) continue;

    const currencyCode = normalizeCurrencyCode(exp.currency);
    const category =
      exp.type === 'payment' ? 'Payment' : exp.category || 'General';
    const costFormatted = (totalCents / 100).toFixed(2);
    const dateStr = (exp.date || todayStr).split('T')[0];
    const descStr =
      exp.description ||
      (exp.type === 'payment' ? 'Direct Payment' : 'Group Expense');

    const splitMap = new Map<string, number>();
    for (const s of exp.splits) {
      const mId = s.memberId || s.userId || '';
      if (!mId) continue;
      const sCents =
        typeof s.splitAmountCents === 'number'
          ? Math.round(s.splitAmountCents)
          : Math.round((s.amount || 0) * 100);
      splitMap.set(mId, (splitMap.get(mId) || 0) + sCents);
    }

    const curBalances = ensureCurrencyMap(currencyCode);

    const memberCols = members.map((m) => {
      const shareCents = splitMap.get(m.id) || 0;
      let deltaCents = 0;
      if (m.id === payerId) {
        deltaCents = totalCents - shareCents;
      } else if (shareCents > 0) {
        deltaCents = -shareCents;
      } else {
        deltaCents = 0;
      }

      curBalances.set(m.id, (curBalances.get(m.id) || 0) + deltaCents);
      return (deltaCents / 100).toFixed(2);
    });

    const rowCells = [
      escapeCsvCell(dateStr),
      escapeCsvCell(descStr),
      escapeCsvCell(category),
      costFormatted,
      currencyCode,
      ...memberCols,
    ];
    if (includeFxColumn) {
      const normalizedFx = normalizeFxRatesMap(exp.fxRates, currencyCode);
      rowCells.push(normalizedFx ? escapeCsvCell(JSON.stringify(normalizedFx)) : '');
    }

    transactionRows.push(rowCells.join(','));
  }

  if (netBalancesByCurrency.size === 0) {
    ensureCurrencyMap('USD');
  }

  const footerRows: string[] = [];
  for (const [curCode, balMap] of netBalancesByCurrency.entries()) {
    const memberTotals = members.map((m) =>
      ((balMap.get(m.id) || 0) / 100).toFixed(2)
    );
    const footerCells = [
      todayStr,
      'Total balance',
      ' ',
      ' ',
      curCode,
      ...memberTotals,
    ];
    if (includeFxColumn) {
      footerCells.push('');
    }
    footerRows.push(footerCells.join(','));
  }

  return [headerRow, ...transactionRows, '', ...footerRows].join('\n');
}

/**
 * Derives a clean group name from a CSV filename (e.g. `orphans_2026-10-18_export.csv` -> `orphans`).
 */
export function deriveGroupNameFromCsvFilename(filename: string): string {
  const withoutExt = filename.replace(/\.csv$/i, '').trim();
  const stripped = withoutExt
    .replace(/_\d{4}-\d{2}-\d{2}_export$/i, '')
    .replace(/_export$/i, '')
    .trim();
  return stripped || withoutExt || 'Imported Group';
}

// ============================================================================
// Personalized Member URL Identity Resolution
// ============================================================================

export function safeDecodeUrlComponent(raw: string): string {
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

const RESERVED_QUERY_KEYS = new Set([
  'shared_receipt',
  'share_error',
  'm',
  'groupid',
  'join',
]);

/**
 * Resolves a group member identity from URL parameters and optional localStorage fallback
 * following strict priority:
 * 1. Path segment: `/[slug]/[member]` (URL-decoded, case-insensitive match on display_name)
 * 2. Legacy query param: `/[slug]?m=<name>`
 * 3. Bare valueless query string: `/[slug]?<name>` (single non-reserved key with value `""`)
 * 4. Stored `localStorage` member ID or name
 */
export function resolveMemberIdentityFromUrl<
  T extends { id: string; name: string; displayName?: string }
>(
  members: T[],
  options: {
    pathMember?: string | null;
    search?: string | null;
    storedMember?: string | null;
  }
): {
  member: T | undefined;
  source: 'path' | 'query_m' | 'query_bare' | 'storage' | null;
} {
  const matchCandidate = (rawCandidate?: string | null): T | undefined => {
    if (!rawCandidate) return undefined;
    const decoded = safeDecodeUrlComponent(rawCandidate).trim().toLowerCase();
    if (!decoded) return undefined;
    return members.find((m) => {
      const display = (m.displayName || m.name || '').trim().toLowerCase();
      const name = (m.name || '').trim().toLowerCase();
      return (
        display === decoded ||
        name === decoded ||
        m.id.toLowerCase() === decoded
      );
    });
  };

  // 1. Path segment: /[slug]/[member]
  if (options.pathMember && options.pathMember.trim().length > 0) {
    const byPath = matchCandidate(options.pathMember);
    if (byPath) {
      return { member: byPath, source: 'path' };
    }
  }

  // 2 & 3. Query string formats
  if (options.search) {
    const cleanSearch = options.search.startsWith('?')
      ? options.search.slice(1)
      : options.search;
    const params = new URLSearchParams(cleanSearch);

    // 2. Legacy query param: ?m=<name>
    const mParam = params.get('m');
    if (mParam && mParam.trim().length > 0) {
      const byQueryM = matchCandidate(mParam);
      if (byQueryM) {
        return { member: byQueryM, source: 'query_m' };
      }
    }

    // 3. Bare valueless query string: ?<name>
    const nonReservedEntries = Array.from(params.entries()).filter(
      ([key]) => !RESERVED_QUERY_KEYS.has(key.trim().toLowerCase())
    );
    if (
      nonReservedEntries.length === 1 &&
      nonReservedEntries[0][1] === ''
    ) {
      const byBareKey = matchCandidate(nonReservedEntries[0][0]);
      if (byBareKey) {
        return { member: byBareKey, source: 'query_bare' };
      }
    }
  }

  // 4. Fallback to saved localStorage identity
  if (options.storedMember && options.storedMember.trim().length > 0) {
    const byStorage = matchCandidate(options.storedMember);
    if (byStorage) {
      return { member: byStorage, source: 'storage' };
    }
  }

  return { member: undefined, source: null };
}


