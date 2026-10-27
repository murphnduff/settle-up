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

  const fromRate =
    Number.isFinite(rawFromRate) && rawFromRate > 0 ? rawFromRate : 1;
  const targetRate =
    Number.isFinite(rawTargetRate) && rawTargetRate > 0 ? rawTargetRate : 1;

  // When rates are quoted as `1 targetCurrency = X fromCurrency`, targetRate is 1 and fromRate is X -> amountCents / X
  return amountCents * (targetRate / fromRate);
}

/**
 * Calculates a unified cross-currency Member Breakdown and greedy Cash-Flow Minimization
 * Settlement Plan converted into `targetCurrency`.
 *
 * Deterministically resolves any 1-cent rounding remainder across members so that
 * `SUM(netBalanceCents) === 0` before running the greedy settlement algorithm.
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

  // Discover all distinct currencies present in expenses
  const activeCurrencies = Array.from(
    new Set(expenses.map((e) => normalizeCurrencyCode(e.currency)))
  );
  if (activeCurrencies.length === 0) {
    activeCurrencies.push(targetCode);
  }

  const exactPaidByMember = new Map<string, number>();
  const exactShareByMember = new Map<string, number>();
  const exactNetByMember = new Map<string, number>();

  for (const m of members) {
    exactPaidByMember.set(m.id, 0);
    exactShareByMember.set(m.id, 0);
    exactNetByMember.set(m.id, 0);
  }

  for (const curCode of activeCurrencies) {
    const curBreakdown = calculateMemberBreakdown(members, expenses, curCode);
    for (const rec of curBreakdown) {
      const paidTarget = convertCentsToTargetCurrency(
        rec.paidCents,
        curCode,
        targetCode,
        exchangeRates
      );
      const shareTarget = convertCentsToTargetCurrency(
        rec.shareCents,
        curCode,
        targetCode,
        exchangeRates
      );
      const netTarget = convertCentsToTargetCurrency(
        rec.netBalanceCents,
        curCode,
        targetCode,
        exchangeRates
      );

      exactPaidByMember.set(
        rec.memberId,
        (exactPaidByMember.get(rec.memberId) || 0) + paidTarget
      );
      exactShareByMember.set(
        rec.memberId,
        (exactShareByMember.get(rec.memberId) || 0) + shareTarget
      );
      exactNetByMember.set(
        rec.memberId,
        (exactNetByMember.get(rec.memberId) || 0) + netTarget
      );
    }
  }

  // Round each member's converted Paid, Share, and Net Balance to integer cents
  const roundedEntries = members.map((m, index) => {
    const exactNet = exactNetByMember.get(m.id) || 0;
    const roundedNet = Math.round(exactNet);
    const roundingError = roundedNet - exactNet; // positive if rounded up, negative if rounded down
    return {
      memberId: m.id,
      memberName: m.name,
      index,
      paidCents: Math.round(exactPaidByMember.get(m.id) || 0),
      shareCents: Math.round(exactShareByMember.get(m.id) || 0),
      exactNet,
      netBalanceCents: roundedNet,
      roundingError,
    };
  });

  // Deterministic 1-cent remainder resolution so SUM(netBalanceCents) === 0 holds strictly
  const residualCents = roundedEntries.reduce(
    (sum, item) => sum + item.netBalanceCents,
    0
  );

  if (residualCents !== 0 && roundedEntries.length > 0) {
    const step = residualCents > 0 ? -1 : 1;
    let remainingToAdjust = Math.abs(residualCents);

    // Sort candidates by who was rounded most in the direction of the residual, then by largest |exactNet|, then by member order
    const candidates = [...roundedEntries].sort((a, b) => {
      const errDiff =
        residualCents > 0
          ? b.roundingError - a.roundingError
          : a.roundingError - b.roundingError;
      if (Math.abs(errDiff) > 1e-7) return errDiff;
      const magDiff = Math.abs(b.exactNet) - Math.abs(a.exactNet);
      if (Math.abs(magDiff) > 1e-7) return magDiff;
      return a.index - b.index;
    });

    let cIdx = 0;
    while (remainingToAdjust > 0) {
      candidates[cIdx % candidates.length].netBalanceCents += step;
      remainingToAdjust--;
      cIdx++;
    }
  }

  const memberBreakdown: MemberSummaryRecord[] = roundedEntries.map((item) => ({
    memberId: item.memberId,
    memberName: item.memberName,
    paidCents: item.paidCents,
    shareCents: item.shareCents,
    netBalanceCents: item.netBalanceCents,
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
 *   Date,Description,Category,Cost,Currency,<Member 1>,<Member 2>,...
 *
 * Rules:
 * - Reads member names from header index 5 (6th column) onward.
 * - Skips empty lines and the 'Total balance' summary row (Description === 'Total balance' or Cost is empty).
 * - Reconstructs paidByMemberName (column where valCents > 0) and exact expense_splits:
 *   - For any member with valCents < 0: split_amount_cents = Math.abs(valCents)
 *   - For the payer (valCents > 0): if amount_cents - valCents > 0, split_amount_cents = amount_cents - valCents
 */
export function parseGroupCsv(csvContent: string): ParsedGroupCsvResult {
  const lines = csvContent
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .split('\n');

  let headerCols: string[] | null = null;
  let memberNames: string[] = [];
  const transactions: ParsedCsvTransaction[] = [];

  for (const rawLine of lines) {
    const trimmedLine = rawLine.trim();
    if (!trimmedLine) continue;

    const cols = parseCsvLine(rawLine);

    if (!headerCols) {
      headerCols = cols.map((c) => c.trim());
      memberNames = headerCols.slice(5).filter((name) => name.length > 0);
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

    for (let mIdx = 0; mIdx < memberNames.length; mIdx++) {
      const memberName = memberNames[mIdx];
      const rawCell = (cols[5 + mIdx] || '0').trim();
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
      splits,
    });
  }

  return {
    memberNames,
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
 */
export function generateGroupCsv(
  members: MemberRecord[],
  expenses: CsvExportExpense[],
  exportDateStr?: string
): string {
  const todayStr =
    exportDateStr || new Date().toISOString().split('T')[0];

  const headerRow = [
    'Date',
    'Description',
    'Category',
    'Cost',
    'Currency',
    ...members.map((m) => escapeCsvCell(m.name)),
  ].join(',');

  // Track net balances per currency code ('USD' | 'EUR') in integer cents
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

    transactionRows.push(
      [
        escapeCsvCell(dateStr),
        escapeCsvCell(descStr),
        escapeCsvCell(category),
        costFormatted,
        currencyCode,
        ...memberCols,
      ].join(',')
    );
  }

  if (netBalancesByCurrency.size === 0) {
    ensureCurrencyMap('USD');
  }

  const footerRows: string[] = [];
  for (const [curCode, balMap] of netBalancesByCurrency.entries()) {
    const memberTotals = members.map((m) =>
      ((balMap.get(m.id) || 0) / 100).toFixed(2)
    );
    footerRows.push(
      [todayStr, 'Total balance', ' ', ' ', curCode, ...memberTotals].join(',')
    );
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

