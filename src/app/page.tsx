'use client';

import { useEffect, useState, useTransition } from 'react';
import { createClient } from '@/lib/supabase';
import { calculateSettlements, SettlementInstruction } from '@/lib/reconciliation';

export default function App() {
  const supabase = createClient();
  const [user, setUser] = useState<any>(null);
  const [groups, setGroups] = useState<any[]>([]);
  const [activeGroupId, setActiveGroupId] = useState<string>('');
  const [members, setMembers] = useState<any[]>([]);
  const [expenses, setExpenses] = useState<any[]>([]);
  const [settlements, setSettlements] = useState<SettlementInstruction[]>([]);

  // Form state
  const [description, setDescription] = useState('');
  const [amount, setAmount] = useState('');
  const [currency, setCurrency] = useState('$');
  const [payerId, setPayerId] = useState('');
  const [type, setType] = useState<'expense' | 'payment'>('expense');
  const [selectedMembers, setSelectedMembers] = useState<string[]>([]);
  const [, startTransition] = useTransition();

  useEffect(() => {
    supabase.auth.getUser().then(({ data }) => setUser(data.user));
    const { data: authListener } = supabase.auth.onAuthStateChange((_, session) => {
      setUser(session?.user ?? null);
    });
    return () => authListener.subscription.unsubscribe();
  }, []);

  useEffect(() => {
    if (!user) return;
    supabase
      .from('groups')
      .select('*')
      .then(({ data }) => {
        if (data && data.length > 0) {
          setGroups(data);
          setActiveGroupId(data[0].id);
        }
      });
  }, [user]);

  useEffect(() => {
    if (!activeGroupId) return;

    // Load group members
    supabase
      .from('group_members')
      .select('user_id, role, profiles(id, full_name, email)')
      .eq('group_id', activeGroupId)
      .then(({ data }) => {
        if (data) {
          const list = data.map((m: any) => ({
            id: m.profiles.id,
            name: m.profiles.full_name || m.profiles.email,
            role: m.role,
          }));
          setMembers(list);
          setSelectedMembers(list.map((u: any) => u.id));
        }
      });

    // Load group expenses with splits
    supabase
      .from('expenses')
      .select('id, payer_id, description, amount, currency, type, date, expense_splits(user_id, amount)')
      .eq('group_id', activeGroupId)
      .order('date', { ascending: false })
      .then(({ data }) => {
        if (data) {
          const formatted = data.map((e: any) => ({
            id: e.id,
            payerId: e.payer_id,
            description: e.description,
            amount: Number(e.amount),
            currency: e.currency,
            type: e.type,
            date: e.date,
            splits: e.expense_splits.map((s: any) => ({
              userId: s.user_id,
              amount: Number(s.amount),
            })),
          }));
          setExpenses(formatted);
        }
      });
  }, [activeGroupId]);

  useEffect(() => {
    if (members.length > 0 && expenses.length > 0) {
      const plan = calculateSettlements(members, expenses);
      setSettlements(plan);
    } else {
      setSettlements([]);
    }
  }, [members, expenses]);

  const handleAddExpense = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!amount || !payerId || selectedMembers.length === 0) return;

    const parsedAmount = parseFloat(amount);
    const splitAmount = Number((parsedAmount / selectedMembers.length).toFixed(2));

    const { data: newExp, error } = await supabase
      .from('expenses')
      .insert({
        group_id: activeGroupId,
        created_by: user.id,
        payer_id: payerId,
        description,
        amount: parsedAmount,
        currency,
        type,
      })
      .select()
      .single();

    if (error) {
      alert(error.message);
      return;
    }

    const splitsPayload = selectedMembers.map((uid) => ({
      expense_id: newExp.id,
      user_id: uid,
      amount: splitAmount,
    }));

    await supabase.from('expense_splits').insert(splitsPayload);

    // Refresh UI
    setDescription('');
    setAmount('');
    startTransition(() => setActiveGroupId(activeGroupId));
  };

  const signInWithGoogle = () => {
    supabase.auth.signInWithOAuth({
      provider: 'google',
      options: { redirectTo: window.location.origin },
    });
  };

  if (!user) {
    return (
      <main className="flex min-h-screen flex-col items-center justify-center p-6 bg-slate-50">
        <div className="p-8 bg-white border border-slate-200 rounded-xl shadow-sm text-center max-w-sm w-full">
          <h1 className="text-2xl font-bold tracking-tight mb-2">Settle Up</h1>
          <p className="text-sm text-slate-500 mb-6">Multi-group expense settlement tracker</p>
          <button
            onClick={signInWithGoogle}
            className="w-full bg-blue-600 hover:bg-blue-700 text-white font-medium py-2.5 px-4 rounded-lg transition"
          >
            Sign in with Google
          </button>
        </div>
      </main>
    );
  }

  return (
    <div className="min-h-screen bg-slate-50">
      <header className="bg-white border-b border-slate-200 px-6 py-4 flex items-center justify-between">
        <h1 className="text-xl font-bold text-slate-900">Settle Up</h1>
        <div className="flex items-center gap-4">
          <span className="text-sm text-slate-600">{user.email}</span>
          <button
            onClick={() => supabase.auth.signOut()}
            className="text-xs text-red-600 hover:underline"
          >
            Sign out
          </button>
        </div>
      </header>

      <div className="max-w-7xl mx-auto p-6 grid grid-cols-1 md:grid-cols-4 gap-6">
        {/* Groups Sidebar */}
        <aside className="bg-white border border-slate-200 p-4 rounded-xl h-fit">
          <h2 className="font-semibold text-slate-800 mb-3 text-sm">Your Groups</h2>
          <div className="space-y-1">
            {groups.map((g) => (
              <button
                key={g.id}
                onClick={() => setActiveGroupId(g.id)}
                className={`w-full text-left px-3 py-2 text-sm rounded-lg transition ${
                  activeGroupId === g.id
                    ? 'bg-blue-50 text-blue-700 font-medium'
                    : 'text-slate-600 hover:bg-slate-100'
                }`}
              >
                {g.name}
              </button>
            ))}
          </div>
        </aside>

        {/* Expense Entry & Settlement Panel */}
        <section className="md:col-span-2 space-y-6">
          <form onSubmit={handleAddExpense} className="bg-white border border-slate-200 p-6 rounded-xl space-y-4">
            <h2 className="font-semibold text-slate-800">Add Transaction</h2>
            <div className="flex gap-4">
              <label className="text-sm font-medium flex items-center gap-2">
                <input
                  type="radio"
                  checked={type === 'expense'}
                  onChange={() => setType('expense')}
                />
                Group Expense
              </label>
              <label className="text-sm font-medium flex items-center gap-2">
                <input
                  type="radio"
                  checked={type === 'payment'}
                  onChange={() => setType('payment')}
                />
                Direct Payment
              </label>
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="text-xs font-semibold text-slate-500 block mb-1">Paid By</label>
                <select
                  value={payerId}
                  onChange={(e) => setPayerId(e.target.value)}
                  className="w-full border border-slate-300 rounded-lg p-2 text-sm"
                  required
                >
                  <option value="">Select Member</option>
                  {members.map((m) => (
                    <option key={m.id} value={m.id}>{m.name}</option>
                  ))}
                </select>
              </div>

              <div>
                <label className="text-xs font-semibold text-slate-500 block mb-1">Amount & Currency</label>
                <div className="flex gap-2">
                  <input
                    type="number"
                    step="0.01"
                    placeholder="0.00"
                    value={amount}
                    onChange={(e) => setAmount(e.target.value)}
                    className="w-full border border-slate-300 rounded-lg p-2 text-sm"
                    required
                  />
                  <select
                    value={currency}
                    onChange={(e) => setCurrency(e.target.value)}
                    className="border border-slate-300 rounded-lg p-2 text-sm"
                  >
                    <option value="$">$</option>
                    <option value="€">€</option>
                  </select>
                </div>
              </div>
            </div>

            <div>
              <label className="text-xs font-semibold text-slate-500 block mb-1">Description</label>
              <input
                type="text"
                placeholder="e.g. Dinner, Fuel, Lodging"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                className="w-full border border-slate-300 rounded-lg p-2 text-sm"
                required
              />
            </div>

            <div>
              <label className="text-xs font-semibold text-slate-500 block mb-1">Split Among</label>
              <div className="flex flex-wrap gap-2">
                {members.map((m) => (
                  <button
                    type="button"
                    key={m.id}
                    onClick={() => {
                      if (type === 'payment') {
                        setSelectedMembers([m.id]);
                      } else {
                        setSelectedMembers((prev) =>
                          prev.includes(m.id) ? prev.filter((id) => id !== m.id) : [...prev, m.id]
                        );
                      }
                    }}
                    className={`px-3 py-1 rounded-full text-xs font-medium border ${
                      selectedMembers.includes(m.id)
                        ? 'bg-blue-600 text-white border-blue-600'
                        : 'bg-white text-slate-600 border-slate-300'
                    }`}
                  >
                    {m.name}
                  </button>
                ))}
              </div>
            </div>

            <button
              type="submit"
              className="w-full bg-slate-900 text-white py-2 rounded-lg text-sm font-semibold hover:bg-slate-800 transition"
            >
              Save Transaction
            </button>
          </form>

          {/* Ledger Table */}
          <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
            <div className="px-6 py-4 border-b border-slate-200 font-semibold text-sm text-slate-800">
              Transaction History
            </div>
            <div className="divide-y divide-slate-100 max-h-96 overflow-y-auto">
              {expenses.map((exp) => (
                <div key={exp.id} className="p-4 flex items-center justify-between text-sm">
                  <div>
                    <div className="font-medium text-slate-900">{exp.description}</div>
                    <div className="text-xs text-slate-500">
                      Paid by {members.find((m) => m.id === exp.payerId)?.name || 'Unknown'} on {exp.date}
                    </div>
                  </div>
                  <div className="text-right">
                    <span className="font-semibold text-slate-900">
                      {exp.currency}{exp.amount.toFixed(2)}
                    </span>
                    <span className="block text-xs uppercase tracking-wide text-slate-400">
                      {exp.type}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* Settlement Minimization Plan */}
        <aside className="bg-white border border-slate-200 p-6 rounded-xl h-fit">
          <h2 className="font-semibold text-slate-800 mb-2">Optimal Settlement Plan</h2>
          <p className="text-xs text-slate-500 mb-4">Minimizes total payments needed to settle debts across all members.</p>
          <div className="space-y-2">
            {settlements.length === 0 ? (
              <p className="text-xs text-slate-400 italic">All debts are settled up.</p>
            ) : (
              settlements.map((s, idx) => (
                <div key={idx} className="p-3 bg-slate-50 border border-slate-200 rounded-lg text-xs">
                  <span className="font-semibold text-slate-800">{s.fromUser}</span> pays{' '}
                  <span className="font-semibold text-slate-800">{s.toUser}</span>:
                  <div className="text-sm font-bold text-blue-600 mt-1">
                    {s.currency}{s.amount.toFixed(2)}
                  </div>
                </div>
              ))
            )}
          </div>
        </aside>
      </div>
    </div>
  );
}

