import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  splitAmountEqually,
  splitAmountByPercentage,
  validateExactSplits,
  parseGroupCsv,
  generateGroupCsv,
  deriveGroupNameFromCsvFilename,
  calculateSettlements,
  calculateBalancesByCurrency,
  canDeleteMember,
} from './reconciliation.ts';
import type {
  MemberRecord,
  ExpenseRecord,
} from './reconciliation.ts';

describe('Settle Up - Section 4 Math Engine & Edge Case Tests', () => {
  // Test members
  const murph: MemberRecord = { id: 'mem-murph', name: 'Murph' };
  const kev: MemberRecord = { id: 'mem-kev', name: 'Kev' };
  const fitz: MemberRecord = { id: 'mem-fitz', name: 'Fitz' };
  const allMembers = [murph, kev, fitz];

  // --------------------------------------------------------------------------
  // Edge Case 1: The Indivisible Penny Edge Case ($100.00 / 3)
  // --------------------------------------------------------------------------
  it('Edge Case 1: The Indivisible Penny ($100.00 / 3) distributes remainder cents without losing or inventing pennies', () => {
    const totalCents = 10000; // $100.00
    const memberIds = [murph.id, kev.id, fitz.id];

    const splits = splitAmountEqually(totalCents, memberIds);

    // Verify split lengths and exact allocations
    assert.strictEqual(splits.length, 3);
    assert.strictEqual(splits[0].splitAmountCents, 3334);
    assert.strictEqual(splits[1].splitAmountCents, 3333);
    assert.strictEqual(splits[2].splitAmountCents, 3333);

    // Crucial rule: sum of splits must match total amount exactly
    const sumCents = splits.reduce((acc, s) => acc + s.splitAmountCents, 0);
    assert.strictEqual(sumCents, totalCents);

    // Verify settlements when Murph pays the $100.00
    const expense: ExpenseRecord = {
      id: 'exp-100',
      paidByMemberId: murph.id,
      amountCents: totalCents,
      currency: 'USD',
      type: 'expense',
      splits,
    };

    const settlements = calculateSettlements(allMembers, [expense]);

    // Kev and Fitz each owe Murph $33.33
    assert.strictEqual(settlements.length, 2);
    const totalTransferred = settlements.reduce((acc, s) => acc + s.amountCents, 0);
    assert.strictEqual(totalTransferred, 6666); // 3333 + 3333

    const kevTransfer = settlements.find((s) => s.fromMemberId === kev.id);
    const fitzTransfer = settlements.find((s) => s.fromMemberId === fitz.id);

    assert.ok(kevTransfer);
    assert.strictEqual(kevTransfer.toMemberId, murph.id);
    assert.strictEqual(kevTransfer.amountCents, 3333);
    assert.strictEqual(kevTransfer.amountFormatted, '33.33');

    assert.ok(fitzTransfer);
    assert.strictEqual(fitzTransfer.toMemberId, murph.id);
    assert.strictEqual(fitzTransfer.amountCents, 3333);
    assert.strictEqual(fitzTransfer.amountFormatted, '33.33');
  });

  // --------------------------------------------------------------------------
  // Edge Case 2: Transitive Debt Simplification (A -> B -> C)
  // --------------------------------------------------------------------------
  it('Edge Case 2: Transitive Debt Simplification (Murph -> Kev -> Fitz) collapses into 1 transaction', () => {
    // Murph pays $30 for Kev
    const exp1: ExpenseRecord = {
      id: 'exp-1',
      paidByMemberId: murph.id,
      amountCents: 3000,
      currency: 'USD',
      type: 'expense',
      splits: [{ memberId: kev.id, splitAmountCents: 3000 }],
    };

    // Kev pays $30 for Fitz
    const exp2: ExpenseRecord = {
      id: 'exp-2',
      paidByMemberId: kev.id,
      amountCents: 3000,
      currency: 'USD',
      type: 'expense',
      splits: [{ memberId: fitz.id, splitAmountCents: 3000 }],
    };

    const balances = calculateBalancesByCurrency(allMembers, [exp1, exp2]).get('USD');
    assert.ok(balances);
    assert.strictEqual(balances.get(murph.id), 3000); // Murph: +$30.00
    assert.strictEqual(balances.get(kev.id), 0);       // Kev: $0.00
    assert.strictEqual(balances.get(fitz.id), -3000);  // Fitz: -$30.00

    const settlements = calculateSettlements(allMembers, [exp1, exp2]);

    // Greedy simplification must yield exactly 1 transaction: Fitz pays Murph $30.00
    assert.strictEqual(settlements.length, 1);
    assert.strictEqual(settlements[0].fromMemberId, fitz.id);
    assert.strictEqual(settlements[0].fromMemberName, 'Fitz');
    assert.strictEqual(settlements[0].toMemberId, murph.id);
    assert.strictEqual(settlements[0].toMemberName, 'Murph');
    assert.strictEqual(settlements[0].amountCents, 3000);
    assert.strictEqual(settlements[0].amountFormatted, '30.00');
  });

  // --------------------------------------------------------------------------
  // Edge Case 3: 1-to-1 Payment Offset
  // --------------------------------------------------------------------------
  it('Edge Case 3: 1-to-1 Payment Offset reduces debt accurately', () => {
    // Initial debt: Murph pays $30 for Fitz
    const exp1: ExpenseRecord = {
      id: 'exp-debt',
      paidByMemberId: murph.id,
      amountCents: 3000,
      currency: 'USD',
      type: 'expense',
      splits: [{ memberId: fitz.id, splitAmountCents: 3000 }],
    };

    // Direct payment: Fitz pays Murph $10.00 (1000 cents)
    const payment: ExpenseRecord = {
      id: 'pay-1',
      paidByMemberId: fitz.id,
      amountCents: 1000,
      currency: 'USD',
      type: 'payment',
      splits: [{ memberId: murph.id, splitAmountCents: 1000 }],
    };

    const settlements = calculateSettlements(allMembers, [exp1, payment]);

    // Updated settlement plan must output: Fitz pays Murph $20.00
    assert.strictEqual(settlements.length, 1);
    assert.strictEqual(settlements[0].fromMemberId, fitz.id);
    assert.strictEqual(settlements[0].toMemberId, murph.id);
    assert.strictEqual(settlements[0].amountCents, 2000);
    assert.strictEqual(settlements[0].amountFormatted, '20.00');
  });

  // --------------------------------------------------------------------------
  // Edge Case 4: Partial & Subset Splits
  // --------------------------------------------------------------------------
  it("Edge Case 4: Partial & Subset Splits leaves unselected members at $0.00", () => {
    // Murph pays $40 for just Murph & Kev ($20 each)
    const exp: ExpenseRecord = {
      id: 'exp-subset',
      paidByMemberId: murph.id,
      amountCents: 4000,
      currency: 'USD',
      type: 'expense',
      splits: [
        { memberId: murph.id, splitAmountCents: 2000 },
        { memberId: kev.id, splitAmountCents: 2000 },
      ],
    };

    const balances = calculateBalancesByCurrency(allMembers, [exp]).get('USD');
    assert.ok(balances);
    assert.strictEqual(balances.get(murph.id), 2000); // Murph: +$20.00
    assert.strictEqual(balances.get(kev.id), -2000);  // Kev: -$20.00
    assert.strictEqual(balances.get(fitz.id), 0);     // Fitz: $0.00

    const settlements = calculateSettlements(allMembers, [exp]);

    assert.strictEqual(settlements.length, 1);
    assert.strictEqual(settlements[0].fromMemberId, kev.id);
    assert.strictEqual(settlements[0].toMemberId, murph.id);
    assert.strictEqual(settlements[0].amountCents, 2000);
    assert.strictEqual(settlements[0].amountFormatted, '20.00');
  });

  // --------------------------------------------------------------------------
  // Edge Case 5: Multi-Currency Isolation
  // --------------------------------------------------------------------------
  it('Edge Case 5: Multi-Currency Isolation strictly separates USD and EUR ledgers', () => {
    // Murph pays $60.00 USD split all 3 ($20 each)
    const usdExpense: ExpenseRecord = {
      id: 'exp-usd',
      paidByMemberId: murph.id,
      amountCents: 6000,
      currency: 'USD',
      type: 'expense',
      splits: [
        { memberId: murph.id, splitAmountCents: 2000 },
        { memberId: kev.id, splitAmountCents: 2000 },
        { memberId: fitz.id, splitAmountCents: 2000 },
      ],
    };

    // Kev pays €30.00 EUR split all 3 (€10 each)
    const eurExpense: ExpenseRecord = {
      id: 'exp-eur',
      paidByMemberId: kev.id,
      amountCents: 3000,
      currency: 'EUR',
      type: 'expense',
      splits: [
        { memberId: murph.id, splitAmountCents: 1000 },
        { memberId: kev.id, splitAmountCents: 1000 },
        { memberId: fitz.id, splitAmountCents: 1000 },
      ],
    };

    const settlements = calculateSettlements(allMembers, [usdExpense, eurExpense]);

    const usdInstructions = settlements.filter((s) => s.currency === 'USD');
    const eurInstructions = settlements.filter((s) => s.currency === 'EUR');

    // USD: Kev pays Murph $20.00, Fitz pays Murph $20.00
    assert.strictEqual(usdInstructions.length, 2);
    assert.ok(
      usdInstructions.some(
        (s) => s.fromMemberId === kev.id && s.toMemberId === murph.id && s.amountCents === 2000
      )
    );
    assert.ok(
      usdInstructions.some(
        (s) => s.fromMemberId === fitz.id && s.toMemberId === murph.id && s.amountCents === 2000
      )
    );

    // EUR: Murph pays Kev €10.00, Fitz pays Kev €10.00
    assert.strictEqual(eurInstructions.length, 2);
    assert.ok(
      eurInstructions.some(
        (s) => s.fromMemberId === murph.id && s.toMemberId === kev.id && s.amountCents === 1000
      )
    );
    assert.ok(
      eurInstructions.some(
        (s) => s.fromMemberId === fitz.id && s.toMemberId === kev.id && s.amountCents === 1000
      )
    );

    // Verify USD and EUR never cross-canceled each other
    assert.strictEqual(settlements.length, 4);
  });

  // --------------------------------------------------------------------------
  // Edge Case 6: Member Deletion Guard
  // --------------------------------------------------------------------------
  it('Edge Case 6: Member Deletion Guard blocks deletion if referenced, succeeds if unused', () => {
    const unusedMember: MemberRecord = { id: 'mem-unused', name: 'Unused' };

    const expenses: ExpenseRecord[] = [
      {
        id: 'exp-1',
        paidByMemberId: murph.id,
        amountCents: 5000,
        currency: 'USD',
        type: 'expense',
        splits: [
          { memberId: murph.id, splitAmountCents: 2500 },
          { memberId: fitz.id, splitAmountCents: 2500 },
        ],
      },
    ];

    // Murph is a payer -> blocked
    const checkMurph = canDeleteMember(murph.id, expenses);
    assert.strictEqual(checkMurph.canDelete, false);
    assert.match(checkMurph.reason || '', /payer/i);

    // Fitz is a participant -> blocked
    const checkFitz = canDeleteMember(fitz.id, expenses);
    assert.strictEqual(checkFitz.canDelete, false);
    assert.match(checkFitz.reason || '', /participant/i);

    // Kev has no transactions in this list -> allowed
    const checkKev = canDeleteMember(kev.id, expenses);
    assert.strictEqual(checkKev.canDelete, true);

    // Unused member has 0 transactions -> allowed
    const checkUnused = canDeleteMember(unusedMember.id, expenses);
    assert.strictEqual(checkUnused.canDelete, true);
  });

  // --------------------------------------------------------------------------
  // Edge Case 7: Transaction Mutation Recalculation
  // --------------------------------------------------------------------------
  it('Edge Case 7: Transaction Mutation Recalculation dynamically updates with no ghost data', () => {
    // Initial state: Murph pays $60 for Kev
    let expensesList: ExpenseRecord[] = [
      {
        id: 'exp-edit',
        paidByMemberId: murph.id,
        amountCents: 6000,
        currency: 'USD',
        type: 'expense',
        splits: [{ memberId: kev.id, splitAmountCents: 6000 }],
      },
    ];

    let settlements = calculateSettlements(allMembers, expensesList);
    assert.strictEqual(settlements.length, 1);
    assert.strictEqual(settlements[0].fromMemberId, kev.id);
    assert.strictEqual(settlements[0].toMemberId, murph.id);
    assert.strictEqual(settlements[0].amountCents, 6000);

    // Mutation 1: Edit amount from $60.00 to $90.00
    expensesList = [
      {
        ...expensesList[0],
        amountCents: 9000,
        splits: [{ memberId: kev.id, splitAmountCents: 9000 }],
      },
    ];

    settlements = calculateSettlements(allMembers, expensesList);
    assert.strictEqual(settlements.length, 1);
    assert.strictEqual(settlements[0].amountCents, 9000);
    assert.strictEqual(settlements[0].amountFormatted, '90.00');

    // Mutation 2: Switch payer to Kev paying for Fitz
    expensesList = [
      {
        ...expensesList[0],
        paidByMemberId: kev.id,
        splits: [{ memberId: fitz.id, splitAmountCents: 9000 }],
      },
    ];

    settlements = calculateSettlements(allMembers, expensesList);
    assert.strictEqual(settlements.length, 1);
    assert.strictEqual(settlements[0].fromMemberId, fitz.id);
    assert.strictEqual(settlements[0].toMemberId, kev.id);
    assert.strictEqual(settlements[0].amountCents, 9000);

    // Mutation 3: Delete transaction entirely -> 0 settlements (no ghost debt)
    expensesList = [];
    settlements = calculateSettlements(allMembers, expensesList);
    assert.strictEqual(settlements.length, 0);
  });

  // --------------------------------------------------------------------------
  // Edge Case 8: Custom Unequal Splits (% Percentage & $ Exact)
  // --------------------------------------------------------------------------
  it('Edge Case 8: splitAmountByPercentage and validateExactSplits handle custom unequal splits accurately', () => {
    // 70% / 30% split of $100.00 (10000 cents) and odd $10.01 (1001 cents)
    const pctSplits = splitAmountByPercentage(10000, {
      [murph.id]: 70,
      [kev.id]: 30,
    });
    assert.strictEqual(pctSplits[murph.id], 7000);
    assert.strictEqual(pctSplits[kev.id], 3000);

    const odd7030 = splitAmountByPercentage(1001, {
      [murph.id]: 70,
      [kev.id]: 30,
    });
    assert.strictEqual(odd7030[murph.id] + odd7030[kev.id], 1001);
    assert.strictEqual(odd7030[murph.id], 701);
    assert.strictEqual(odd7030[kev.id], 300);

    // Odd-penny percentage split: $10.00 (1000 cents) across 33.33%, 33.33%, 33.34%
    const oddPctSplits = splitAmountByPercentage(1000, {
      [murph.id]: 33.33,
      [kev.id]: 33.33,
      [fitz.id]: 33.34,
    });
    assert.strictEqual(
      oddPctSplits[murph.id] + oddPctSplits[kev.id] + oddPctSplits[fitz.id],
      1000
    );
    assert.strictEqual(oddPctSplits[murph.id], 333);
    assert.strictEqual(oddPctSplits[kev.id], 333);
    assert.strictEqual(oddPctSplits[fitz.id], 334);

    // Invalid percentage sum (90%) returns empty object
    const invalidPct = splitAmountByPercentage(10000, {
      [murph.id]: 60,
      [kev.id]: 30,
    });
    assert.deepStrictEqual(invalidPct, {});

    // Exact split validation: valid $100.00 = $65.25 + $34.75
    const exactValid = validateExactSplits(10000, {
      [murph.id]: 6525,
      [kev.id]: 3475,
    });
    assert.strictEqual(exactValid, true);

    // Exact split validation: $5.00 remaining -> false
    const exactUnder = validateExactSplits(10000, {
      [murph.id]: 6000,
      [kev.id]: 3500,
    });
    assert.strictEqual(exactUnder, false);

    // Negative exact split -> false
    const exactNegative = validateExactSplits(10000, {
      [murph.id]: 11000,
      [kev.id]: -1000,
    });
    assert.strictEqual(exactNegative, false);
  });

  // --------------------------------------------------------------------------
  // Edge Case 9: Unified CSV Parser & Exporter (Odd Penny Split & Round-Trip)
  // --------------------------------------------------------------------------
  it('Edge Case 9: parseGroupCsv reconstructs exact payer (Adele), total (55000 cents), and 7 splits (7857 x 6 + 7858 for Adele)', () => {
    const csvSample = [
      'Date,Description,Category,Cost,Currency,M1,M2,M3,M4,M5,M6,Adele',
      '2026-10-18,Villa Rental,General,550.00,EUR,-78.57,-78.57,-78.57,-78.57,-78.57,-78.57,471.42',
      '',
      '2026-10-18,Total balance, , ,EUR,-78.57,-78.57,-78.57,-78.57,-78.57,-78.57,471.42',
    ].join('\n');

    const parsed = parseGroupCsv(csvSample);

    assert.deepStrictEqual(parsed.memberNames, [
      'M1',
      'M2',
      'M3',
      'M4',
      'M5',
      'M6',
      'Adele',
    ]);
    // Must skip blank line and 'Total balance' summary row
    assert.strictEqual(parsed.transactions.length, 1);

    const txn = parsed.transactions[0];
    assert.strictEqual(txn.paidByMemberName, 'Adele');
    assert.strictEqual(txn.amountCents, 55000);
    assert.strictEqual(txn.currency, 'EUR');
    assert.strictEqual(txn.type, 'expense');
    assert.strictEqual(txn.splits.length, 7);

    const adeleSplit = txn.splits.find((s) => s.memberName === 'Adele');
    const otherSplits = txn.splits.filter((s) => s.memberName !== 'Adele');

    assert.ok(adeleSplit);
    assert.strictEqual(adeleSplit.splitAmountCents, 7858);
    assert.strictEqual(otherSplits.length, 6);
    for (const s of otherSplits) {
      assert.strictEqual(s.splitAmountCents, 7857);
    }

    const totalSplitCents = txn.splits.reduce(
      (acc, s) => acc + s.splitAmountCents,
      0
    );
    assert.strictEqual(totalSplitCents, 55000);

    // Verify filename group name derivation
    assert.strictEqual(
      deriveGroupNameFromCsvFilename('orphans_2026-10-18_export.csv'),
      'orphans'
    );

    // Verify generateGroupCsv exports exact matching format
    const sevenMembers: MemberRecord[] = [
      { id: 'id-1', name: 'M1' },
      { id: 'id-2', name: 'M2' },
      { id: 'id-3', name: 'M3' },
      { id: 'id-4', name: 'M4' },
      { id: 'id-5', name: 'M5' },
      { id: 'id-6', name: 'M6' },
      { id: 'id-7', name: 'Adele' },
    ];
    const exportedCsv = generateGroupCsv(
      sevenMembers,
      [
        {
          id: 'exp-villa',
          date: '2026-10-18',
          description: 'Villa Rental',
          amountCents: 55000,
          currency: 'EUR',
          type: 'expense',
          paidByMemberId: 'id-7',
          splits: [
            { memberId: 'id-1', splitAmountCents: 7857 },
            { memberId: 'id-2', splitAmountCents: 7857 },
            { memberId: 'id-3', splitAmountCents: 7857 },
            { memberId: 'id-4', splitAmountCents: 7857 },
            { memberId: 'id-5', splitAmountCents: 7857 },
            { memberId: 'id-6', splitAmountCents: 7857 },
            { memberId: 'id-7', splitAmountCents: 7858 },
          ],
        },
      ],
      '2026-10-18'
    );
    assert.strictEqual(exportedCsv, csvSample);
  });

  // --------------------------------------------------------------------------
  // Edge Case 10: Direct Payment Overpayment & Balance Inversion ($20 debt, $22 payment -> $2 reverse settlement)
  // --------------------------------------------------------------------------
  it('Edge Case 10: Overpayment Inversion never clamps at $0.00 ($20 debt, $22 payment -> Murph pays Kevin $2.00)', () => {
    const kevin: MemberRecord = { id: 'mem-kevin', name: 'Kevin' };
    const groupMembers = [murph, kevin];

    // 1. Kevin owes Murph $20.00 (Murph paid $40.00 split equally: $20.00 each)
    const initialExpense: ExpenseRecord = {
      id: 'exp-initial-20',
      paidByMemberId: murph.id,
      amountCents: 4000,
      currency: 'USD',
      type: 'expense',
      splits: [
        { memberId: murph.id, splitAmountCents: 2000 },
        { memberId: kevin.id, splitAmountCents: 2000 },
      ],
    };

    // 2. Kevin sends a direct payment of $22.00 (2200 cents) to Murph
    const overpayment: ExpenseRecord = {
      id: 'pay-over-22',
      paidByMemberId: kevin.id,
      amountCents: 2200,
      currency: 'USD',
      type: 'payment',
      splits: [{ memberId: murph.id, splitAmountCents: 2200 }],
    };

    const balances = calculateBalancesByCurrency(groupMembers, [
      initialExpense,
      overpayment,
    ]).get('USD');

    assert.ok(balances);
    // Kevin: -2000 + 2200 = +200 cents (+$2.00 Creditor)
    assert.strictEqual(balances.get(kevin.id), 200);
    // Murph: +2000 - 2200 = -200 cents (-$2.00 Debtor)
    assert.strictEqual(balances.get(murph.id), -200);

    const settlements = calculateSettlements(groupMembers, [
      initialExpense,
      overpayment,
    ]);

    assert.strictEqual(settlements.length, 1);
    assert.strictEqual(settlements[0].fromMemberId, murph.id);
    assert.strictEqual(settlements[0].fromMemberName, 'Murph');
    assert.strictEqual(settlements[0].toMemberId, kevin.id);
    assert.strictEqual(settlements[0].toMemberName, 'Kevin');
    assert.strictEqual(settlements[0].amountCents, 200);
    assert.strictEqual(settlements[0].amountFormatted, '2.00');
    assert.strictEqual(
      `${settlements[0].fromUser} pays ${settlements[0].toUser} : $${settlements[0].amountFormatted}`,
      'Murph pays Kevin : $2.00'
    );
  });

  // --------------------------------------------------------------------------
  // Edge Case 11: Expense with missing/empty splits falls back to equal split and preserves zero-sum balance
  // --------------------------------------------------------------------------
  it('Edge Case 11: Expense with empty splits falls back to equal split and never creates non-zero-sum phantom balance', () => {
    const unsplitExpense: ExpenseRecord = {
      id: 'exp-unsplit-7289',
      paidByMemberId: fitz.id,
      amountCents: 7289,
      currency: 'USD',
      type: 'expense',
      splits: [],
    };

    const balances = calculateBalancesByCurrency(allMembers, [unsplitExpense]).get('USD');
    assert.ok(balances);

    const sumBalances =
      (balances.get(murph.id) || 0) +
      (balances.get(kev.id) || 0) +
      (balances.get(fitz.id) || 0);
    assert.strictEqual(sumBalances, 0);
    assert.strictEqual(balances.get(murph.id), -2430);
    assert.strictEqual(balances.get(kev.id), -2430);
    assert.strictEqual(balances.get(fitz.id), 4860);
  });
});

