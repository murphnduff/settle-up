import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  splitAmountEqually,
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
});
