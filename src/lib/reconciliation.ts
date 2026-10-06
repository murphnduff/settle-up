export interface BalanceSummary {
  userId: string;
  name: string;
  netBalance: number;
}

export interface SettlementInstruction {
  fromUser: string;
  toUser: string;
  amount: number;
  currency: string;
}

export interface SplitRecord {
  userId: string;
  amount: number;
}

export interface ExpenseRecord {
  id: string;
  payerId: string;
  amount: number;
  currency: string;
  type: 'expense' | 'payment';
  splits: SplitRecord[];
}

export function calculateSettlements(
  users: { id: string; name: string }[],
  expenses: ExpenseRecord[]
): SettlementInstruction[] {
  const currencies = Array.from(new Set(expenses.map((e) => e.currency)));
  const instructions: SettlementInstruction[] = [];

  for (const cur of currencies) {
    const balances: Record<string, number> = {};
    users.forEach((u) => (balances[u.id] = 0));

    const curExpenses = expenses.filter((e) => e.currency === cur);

    for (const exp of curExpenses) {
      balances[exp.payerId] = (balances[exp.payerId] || 0) + Number(exp.amount);

      for (const split of exp.splits) {
        balances[split.userId] = (balances[split.userId] || 0) - Number(split.amount);
      }
    }

    // Separate into Debtors and Creditors
    const debtors: { id: string; amount: number }[] = [];
    const creditors: { id: string; amount: number }[] = [];

    for (const [userId, bal] of Object.entries(balances)) {
      const rounded = Math.round(bal * 100) / 100;
      if (rounded < -0.01) debtors.push({ id: userId, amount: Math.abs(rounded) });
      if (rounded > 0.01) creditors.push({ id: userId, amount: rounded });
    }

    debtors.sort((a, b) => b.amount - a.amount);
    creditors.sort((a, b) => b.amount - a.amount);

    let d = 0;
    let c = 0;

    while (d < debtors.length && c < creditors.length) {
      const debtor = debtors[d];
      const creditor = creditors[c];
      const transfer = Math.min(debtor.amount, creditor.amount);

      if (transfer > 0.01) {
        const fromName = users.find((u) => u.id === debtor.id)?.name || 'Unknown';
        const toName = users.find((u) => u.id === creditor.id)?.name || 'Unknown';

        instructions.push({
          fromUser: fromName,
          toUser: toName,
          amount: Number(transfer.toFixed(2)),
          currency: cur,
        });
      }

      debtor.amount = Math.round((debtor.amount - transfer) * 100) / 100;
      creditor.amount = Math.round((creditor.amount - transfer) * 100) / 100;

      if (debtor.amount <= 0.01) d++;
      if (creditor.amount <= 0.01) c++;
    }
  }

  return instructions;
}
