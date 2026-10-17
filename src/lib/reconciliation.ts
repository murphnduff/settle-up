/**
 * Settle Up - Financial Reconciliation & Penny-Splitting Math Engine
 *
 * All monetary calculations operate strictly on integers representing cents
 * (e.g. $10.00 = 1000 cents) to prevent floating-point rounding errors.
 * Currencies (USD vs EUR) are strictly isolated.
 */

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
 * Positive balance = Creditor (is owed money)
 * Negative balance = Debtor (owes money)
 */
export function calculateBalancesByCurrency(
  members: MemberRecord[],
  expenses: ExpenseRecord[]
): Map<string, Map<string, number>> {
  // Find all distinct currencies
  const currencies = Array.from(
    new Set(expenses.map((e) => e.currency || 'USD'))
  );

  const currencyBalances = new Map<string, Map<string, number>>();

  for (const cur of currencies) {
    const balances = new Map<string, number>();

    // Initialize all members with 0 cents
    for (const m of members) {
      balances.set(m.id, 0);
    }

    const curExpenses = expenses.filter(
      (e) => (e.currency || 'USD') === cur
    );

    for (const exp of curExpenses) {
      const payerId = exp.paidByMemberId || exp.payerId || '';
      const totalCents =
        typeof exp.amountCents === 'number'
          ? Math.round(exp.amountCents)
          : Math.round((exp.amount || 0) * 100);

      if (!payerId || totalCents <= 0) continue;

      // Payer paid total amount -> credit payer
      const currentPayerBalance = balances.get(payerId) || 0;
      balances.set(payerId, currentPayerBalance + totalCents);

      // Deduct each participant's split share -> debit participant
      for (const split of exp.splits) {
        const participantId = split.memberId || split.userId || '';
        if (!participantId) continue;

        const splitCents =
          typeof split.splitAmountCents === 'number'
            ? Math.round(split.splitAmountCents)
            : Math.round((split.amount || 0) * 100);

        const currentPartBalance = balances.get(participantId) || 0;
        balances.set(participantId, currentPartBalance - splitCents);
      }
    }

    currencyBalances.set(cur, balances);
  }

  return currencyBalances;
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
