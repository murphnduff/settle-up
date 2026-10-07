"use client";

import { useEffect, useState, useTransition, useMemo, useCallback } from "react";
import { createClient } from "@/lib/supabase";
import {
  calculateSettlements,
  SettlementInstruction,
  ExpenseRecord,
} from "@/lib/reconciliation";
import MemberInviteModal, {
  Group,
  GroupMember,
} from "@/components/MemberInviteModal";
import {
  UserPlus,
  Users,
  CheckCircle2,
  Trash2,
  LogOut,
  Plus,
} from "lucide-react";
import type { User } from "@supabase/supabase-js";

interface ExpenseItem extends ExpenseRecord {
  description: string;
  date: string;
}

export default function App() {
  const supabase = useMemo(() => createClient(), []);
  const [user, setUser] = useState<User | null>(null);
  const [groups, setGroups] = useState<Group[]>([]);
  const [activeGroupId, setActiveGroupId] = useState<string>("");
  const [members, setMembers] = useState<GroupMember[]>([]);
  const [newGroupName, setNewGroupName] = useState("");
  const [expenses, setExpenses] = useState<ExpenseItem[]>([]);
  const [isInviteModalOpen, setIsInviteModalOpen] = useState(false);
  const [notification, setNotification] = useState<{
    type: "success" | "error";
    message: string;
  } | null>(null);

  // Lazy-initialize pending invite from URL or sessionStorage without triggering an effect
  const [hasPendingInvite] = useState<boolean>(() => {
    if (typeof window === "undefined") return false;
    const params = new URLSearchParams(window.location.search);
    const joinId = params.get("join");
    if (joinId) {
      sessionStorage.setItem("settle_up_join_group", joinId);
      return true;
    }
    return !!sessionStorage.getItem("settle_up_join_group");
  });

  // Form state
  const [description, setDescription] = useState("");
  const [amount, setAmount] = useState("");
  const [currency, setCurrency] = useState("$");
  const [payerId, setPayerId] = useState("");
  const [type, setType] = useState<"expense" | "payment">("expense");
  const [selectedMembers, setSelectedMembers] = useState<string[]>([]);
  const [, startTransition] = useTransition();

  // Active group derived
  const activeGroup = useMemo(
    () => groups.find((g) => g.id === activeGroupId) || null,
    [groups, activeGroupId]
  );

  // Auth listener
  useEffect(() => {
    supabase.auth.getUser().then(({ data }) => setUser(data.user));
    const { data: authListener } = supabase.auth.onAuthStateChange(
      (_, session) => {
        setUser(session?.user ?? null);
      }
    );
    return () => authListener.subscription.unsubscribe();
  }, [supabase]);

  // Load groups or handle join invite link when user is authenticated
  useEffect(() => {
    if (!user) return;

    const params =
      typeof window !== "undefined"
        ? new URLSearchParams(window.location.search)
        : null;
    const joinId =
      params?.get("join") ||
      (typeof window !== "undefined"
        ? sessionStorage.getItem("settle_up_join_group")
        : null);

    if (joinId) {
      // Clear storage & URL parameter
      if (typeof window !== "undefined") {
        sessionStorage.removeItem("settle_up_join_group");
        const url = new URL(window.location.href);
        url.searchParams.delete("join");
        window.history.replaceState(
          {},
          "",
          url.pathname + (url.search ? url.search : "")
        );
      }

      // Check and join group
      supabase
        .from("group_members")
        .select("user_id")
        .eq("group_id", joinId)
        .eq("user_id", user.id)
        .maybeSingle()
        .then(async ({ data: existing }) => {
          if (!existing) {
            const { error } = await supabase.from("group_members").insert({
              group_id: joinId,
              user_id: user.id,
              role: "member",
            });
            if (!error) {
              setNotification({
                type: "success",
                message: "Welcome! You have successfully joined the group.",
              });
            }
          }
          const { data: userGroups } = await supabase
            .from("groups")
            .select("*");
          if (userGroups && userGroups.length > 0) {
            setGroups(userGroups);
            setActiveGroupId(joinId);
          }
        });
    } else {
      supabase
        .from("groups")
        .select("*")
        .then(({ data }) => {
          if (data && data.length > 0) {
            setGroups(data);
            setActiveGroupId((prev) => {
              if (prev && data.some((g: Group) => g.id === prev)) {
                return prev;
              }
              return data[0].id;
            });
          } else {
            setGroups([]);
            setActiveGroupId("");
          }
        });
    }
  }, [user, supabase]);

  // Load group members & expenses on active group change
  useEffect(() => {
    if (!activeGroupId) return;
    let cancelled = false;

    supabase
      .from("group_members")
      .select("user_id, role, profiles(id, full_name, email)")
      .eq("group_id", activeGroupId)
      .then(({ data }) => {
        if (cancelled || !data) return;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const list: GroupMember[] = (data as any[]).map((m) => {
          const profile = Array.isArray(m.profiles) ? m.profiles[0] : m.profiles;
          return {
            id: profile?.id || m.user_id,
            name: profile?.full_name || profile?.email || "Unknown Member",
            email: profile?.email,
            role: m.role || "member",
          };
        });
        setMembers(list);
        setSelectedMembers(list.map((u) => u.id));
      });

    supabase
      .from("expenses")
      .select(
        "id, payer_id, description, amount, currency, type, date, expense_splits(user_id, amount)"
      )
      .eq("group_id", activeGroupId)
      .order("date", { ascending: false })
      .then(({ data }) => {
        if (cancelled || !data) return;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const formatted: ExpenseItem[] = (data as any[]).map((e) => ({
          id: e.id,
          payerId: e.payer_id,
          description: e.description,
          amount: Number(e.amount),
          currency: e.currency,
          type: e.type,
          date: e.date,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          splits: (e.expense_splits || []).map((s: any) => ({
            userId: s.user_id,
            amount: Number(s.amount),
          })),
        }));
        setExpenses(formatted);
      });

    return () => {
      cancelled = true;
    };
  }, [activeGroupId, supabase]);

  // Refresh members callback for after invite modal adds a member
  const refreshMembers = useCallback(
    async (groupId: string) => {
      if (!groupId) return;
      const { data } = await supabase
        .from("group_members")
        .select("user_id, role, profiles(id, full_name, email)")
        .eq("group_id", groupId);

      if (data) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const list: GroupMember[] = (data as any[]).map((m) => {
          const profile = Array.isArray(m.profiles) ? m.profiles[0] : m.profiles;
          return {
            id: profile?.id || m.user_id,
            name: profile?.full_name || profile?.email || "Unknown Member",
            email: profile?.email,
            role: m.role || "member",
          };
        });
        setMembers(list);
        setSelectedMembers(list.map((u) => u.id));
      }
    },
    [supabase]
  );

  // Refresh expenses callback
  const refreshExpenses = useCallback(
    async (groupId: string) => {
      if (!groupId) return;
      const { data } = await supabase
        .from("expenses")
        .select(
          "id, payer_id, description, amount, currency, type, date, expense_splits(user_id, amount)"
        )
        .eq("group_id", groupId)
        .order("date", { ascending: false });

      if (data) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const formatted: ExpenseItem[] = (data as any[]).map((e) => ({
          id: e.id,
          payerId: e.payer_id,
          description: e.description,
          amount: Number(e.amount),
          currency: e.currency,
          type: e.type,
          date: e.date,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          splits: (e.expense_splits || []).map((s: any) => ({
            userId: s.user_id,
            amount: Number(s.amount),
          })),
        }));
        setExpenses(formatted);
      }
    },
    [supabase]
  );

  // Memoized settlement calculations
  const settlements: SettlementInstruction[] = useMemo(() => {
    if (members.length > 0 && expenses.length > 0) {
      return calculateSettlements(members, expenses);
    }
    return [];
  }, [members, expenses]);

  const handleCreateGroup = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newGroupName.trim()) return;

    // 1. Fetch the absolute latest user session to satisfy RLS
    const {
      data: { user: currentUser },
    } = await supabase.auth.getUser();
    if (!currentUser) {
      alert("You must be logged in to create a group.");
      return;
    }

    // 2. Create the Group
    const { data: newGroup, error: groupError } = await supabase
      .from("groups")
      .insert({ name: newGroupName.trim(), created_by: currentUser.id })
      .select()
      .single();

    if (groupError) {
      alert("Error creating group: " + groupError.message);
      return;
    }

    // 3. Add the creator as an Admin member
    const { error: memberError } = await supabase.from("group_members").insert({
      group_id: newGroup.id,
      user_id: currentUser.id,
      role: "admin",
    });

    if (memberError) {
      alert("Error adding admin member: " + memberError.message);
      return;
    }

    // 4. Update the UI
    setNewGroupName("");
    setGroups((prev) => [...prev, newGroup]);
    setActiveGroupId(newGroup.id);
  };

  const handleDeleteGroup = async (groupId: string, groupName: string) => {
    const confirmed = window.confirm(
      `Are you sure you want to delete the group "${groupName}"? This will remove all associated expenses and settlements.`
    );
    if (!confirmed) return;

    // 1. Delete associated expenses, splits, and members
    await supabase.from("expenses").delete().eq("group_id", groupId);
    await supabase.from("group_members").delete().eq("group_id", groupId);

    // 2. Delete the group
    const { error } = await supabase.from("groups").delete().eq("id", groupId);

    if (error) {
      alert("Error deleting group: " + error.message);
      return;
    }

    // 3. Update local state
    const remaining = groups.filter((g) => g.id !== groupId);
    setGroups(remaining);
    if (activeGroupId === groupId) {
      setActiveGroupId(remaining.length > 0 ? remaining[0].id : "");
    }
  };

  const handleAddExpense = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!amount || !payerId || selectedMembers.length === 0 || !user) return;

    const parsedAmount = parseFloat(amount);
    const splitAmount = Number(
      (parsedAmount / selectedMembers.length).toFixed(2)
    );

    const { data: newExp, error } = await supabase
      .from("expenses")
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

    await supabase.from("expense_splits").insert(splitsPayload);

    // Refresh UI
    setDescription("");
    setAmount("");
    startTransition(() => {
      refreshExpenses(activeGroupId);
    });
  };

  const signInWithGoogle = () => {
    supabase.auth.signInWithOAuth({
      provider: "google",
      options: { redirectTo: window.location.origin },
    });
  };

  if (!user) {
    return (
      <main className="flex min-h-screen flex-col items-center justify-center p-6 bg-slate-50">
        <div className="p-8 bg-white border border-slate-200 rounded-2xl shadow-sm text-center max-w-sm w-full space-y-4">
          <div className="mx-auto w-12 h-12 rounded-xl bg-blue-50 text-blue-600 flex items-center justify-center font-bold text-xl">
            $
          </div>
          <div>
            <h1 className="text-2xl font-bold tracking-tight text-slate-900 mb-1">
              Settle Up
            </h1>
            <p className="text-sm text-slate-500">
              Multi-group expense settlement tracker
            </p>
          </div>

          {hasPendingInvite && (
            <div className="p-3 bg-blue-50 border border-blue-200 rounded-xl text-xs text-blue-800 flex items-start gap-2 text-left">
              <Users className="w-4 h-4 text-blue-600 shrink-0 mt-0.5" />
              <span>
                You have been invited to join a group! Sign in with Google to accept and join.
              </span>
            </div>
          )}

          <button
            onClick={signInWithGoogle}
            className="w-full bg-blue-600 hover:bg-blue-700 text-white font-medium py-2.5 px-4 rounded-xl transition shadow-xs cursor-pointer"
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
        <div className="flex items-center gap-2">
          <span className="font-black text-blue-600 text-lg">$</span>
          <h1 className="text-xl font-bold text-slate-900 tracking-tight">
            Settle Up
          </h1>
        </div>
        <div className="flex items-center gap-4">
          <span className="text-sm text-slate-600 font-medium">{user.email}</span>
          <button
            onClick={() => supabase.auth.signOut()}
            className="inline-flex items-center gap-1 text-xs text-slate-500 hover:text-red-600 font-medium transition cursor-pointer"
          >
            <LogOut className="w-3.5 h-3.5" />
            Sign out
          </button>
        </div>
      </header>

      {/* Global Notification Banner */}
      {notification && (
        <div className="max-w-7xl mx-auto px-6 pt-4">
          <div
            className={`p-3 rounded-xl text-xs flex items-center justify-between ${
              notification.type === "success"
                ? "bg-emerald-50 text-emerald-800 border border-emerald-200"
                : "bg-red-50 text-red-800 border border-red-200"
            }`}
          >
            <div className="flex items-center gap-2">
              <CheckCircle2 className="w-4 h-4 text-emerald-600 shrink-0" />
              <span>{notification.message}</span>
            </div>
            <button
              onClick={() => setNotification(null)}
              className="text-slate-400 hover:text-slate-600 text-xs px-2 py-0.5 rounded cursor-pointer"
            >
              ✕
            </button>
          </div>
        </div>
      )}

      <div className="max-w-7xl mx-auto p-6 grid grid-cols-1 md:grid-cols-4 gap-6">
        {/* Groups Sidebar */}
        <aside className="bg-white border border-slate-200 p-4 rounded-xl h-fit flex flex-col gap-4">
          <div>
            <h2 className="font-semibold text-slate-800 mb-3 text-sm flex items-center justify-between">
              <span>Your Groups</span>
              <span className="text-xs text-slate-400 font-normal">
                {groups.length}
              </span>
            </h2>
            <div className="space-y-1">
              {groups.length === 0 ? (
                <p className="text-xs text-slate-400 italic py-2">
                  No groups yet. Create one below!
                </p>
              ) : (
                groups.map((g) => (
                  <div
                    key={g.id}
                    className={`group flex items-center justify-between px-3 py-2 text-sm rounded-lg transition ${
                      activeGroupId === g.id
                        ? "bg-blue-50 text-blue-700 font-medium border border-blue-100"
                        : "text-slate-600 hover:bg-slate-100 border border-transparent"
                    }`}
                  >
                    <button
                      type="button"
                      onClick={() => setActiveGroupId(g.id)}
                      className="flex-1 text-left truncate mr-2 cursor-pointer"
                    >
                      {g.name}
                    </button>
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        handleDeleteGroup(g.id, g.name);
                      }}
                      title="Delete group"
                      className="opacity-0 group-hover:opacity-100 text-slate-400 hover:text-red-600 p-1 rounded transition cursor-pointer"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                ))
              )}
            </div>
          </div>

          <div className="pt-4 border-t border-slate-100">
            <form onSubmit={handleCreateGroup} className="flex flex-col gap-2">
              <label className="text-xs font-semibold text-slate-600">
                Create New Group
              </label>
              <input
                type="text"
                placeholder="Group Name"
                value={newGroupName}
                onChange={(e) => setNewGroupName(e.target.value)}
                className="w-full border border-slate-300 rounded-lg p-2 text-sm text-slate-900 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent transition"
                required
              />
              <button
                type="submit"
                className="w-full bg-blue-600 text-white py-2 rounded-lg text-xs font-semibold hover:bg-blue-700 transition flex items-center justify-center gap-1.5 cursor-pointer shadow-xs"
              >
                <Plus className="w-3.5 h-3.5" />
                Create Group
              </button>
            </form>
          </div>
        </aside>

        {/* Expense Entry & Settlement Panel */}
        <section className="md:col-span-2 space-y-6">
          {/* Active Group Header with Member Info and Invite Trigger */}
          {activeGroup ? (
            <div className="bg-white border border-slate-200 p-5 rounded-xl flex flex-col sm:flex-row sm:items-center justify-between gap-4">
              <div>
                <div className="flex items-center gap-2">
                  <h2 className="text-lg font-bold text-slate-900">
                    {activeGroup.name}
                  </h2>
                  <span className="px-2 py-0.5 rounded-full text-xs font-medium bg-slate-100 text-slate-600">
                    {members.length} {members.length === 1 ? "member" : "members"}
                  </span>
                </div>
                <div className="flex items-center gap-1.5 mt-2 flex-wrap">
                  {members.map((m) => (
                    <span
                      key={m.id}
                      className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs bg-slate-50 border border-slate-200 text-slate-700"
                    >
                      <span className="w-1.5 h-1.5 rounded-full bg-emerald-500"></span>
                      <span className="font-medium">{m.name}</span>
                      {m.role === "admin" && (
                        <span className="text-[10px] text-indigo-600 font-semibold uppercase tracking-wider ml-0.5">
                          Admin
                        </span>
                      )}
                    </span>
                  ))}
                </div>
              </div>
              <button
                type="button"
                onClick={() => setIsInviteModalOpen(true)}
                className="inline-flex items-center justify-center gap-1.5 px-3.5 py-2 text-xs font-semibold rounded-lg bg-blue-600 hover:bg-blue-700 text-white transition shadow-xs shrink-0 cursor-pointer"
              >
                <UserPlus className="w-4 h-4" />
                Invite Members
              </button>
            </div>
          ) : (
            <div className="bg-white border border-slate-200 p-6 rounded-xl text-center text-slate-500 text-sm">
              Select or create a group to start tracking expenses.
            </div>
          )}

          {activeGroup && (
            <>
              <form
                onSubmit={handleAddExpense}
                className="bg-white border border-slate-200 p-6 rounded-xl space-y-4"
              >
                <h2 className="font-semibold text-slate-800 text-base">
                  Add Transaction
                </h2>
                <div className="flex gap-4">
                  <label className="text-sm font-medium flex items-center gap-2 cursor-pointer text-slate-700">
                    <input
                      type="radio"
                      checked={type === "expense"}
                      onChange={() => setType("expense")}
                      className="text-blue-600 focus:ring-blue-500"
                    />
                    Group Expense
                  </label>
                  <label className="text-sm font-medium flex items-center gap-2 cursor-pointer text-slate-700">
                    <input
                      type="radio"
                      checked={type === "payment"}
                      onChange={() => setType("payment")}
                      className="text-blue-600 focus:ring-blue-500"
                    />
                    Direct Payment
                  </label>
                </div>

                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="text-xs font-semibold text-slate-600 block mb-1">
                      Paid By
                    </label>
                    <select
                      value={payerId}
                      onChange={(e) => setPayerId(e.target.value)}
                      className="w-full border border-slate-300 rounded-lg p-2 text-sm text-slate-900 bg-white focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent transition"
                      required
                    >
                      <option value="">Select Member</option>
                      {members.map((m) => (
                        <option key={m.id} value={m.id}>
                          {m.name}
                        </option>
                      ))}
                    </select>
                  </div>

                  <div>
                    <label className="text-xs font-semibold text-slate-600 block mb-1">
                      Amount & Currency
                    </label>
                    <div className="flex gap-2">
                      <input
                        type="number"
                        step="0.01"
                        placeholder="0.00"
                        value={amount}
                        onChange={(e) => setAmount(e.target.value)}
                        className="w-full border border-slate-300 rounded-lg p-2 text-sm text-slate-900 placeholder:text-slate-400 bg-white focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent transition"
                        required
                      />
                      <select
                        value={currency}
                        onChange={(e) => setCurrency(e.target.value)}
                        className="border border-slate-300 rounded-lg p-2 text-sm text-slate-900 bg-white focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent transition"
                      >
                        <option value="$">$</option>
                        <option value="€">€</option>
                      </select>
                    </div>
                  </div>
                </div>

                <div>
                  <label className="text-xs font-semibold text-slate-600 block mb-1">
                    Description
                  </label>
                  <input
                    type="text"
                    placeholder="e.g. Dinner, Fuel, Lodging"
                    value={description}
                    onChange={(e) => setDescription(e.target.value)}
                    className="w-full border border-slate-300 rounded-lg p-2 text-sm text-slate-900 placeholder:text-slate-400 bg-white focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent transition"
                    required
                  />
                </div>

                <div>
                  <label className="text-xs font-semibold text-slate-600 block mb-1">
                    Split Among
                  </label>
                  <div className="flex flex-wrap gap-2">
                    {members.map((m) => (
                      <button
                        type="button"
                        key={m.id}
                        onClick={() => {
                          if (type === "payment") {
                            setSelectedMembers([m.id]);
                          } else {
                            setSelectedMembers((prev) =>
                              prev.includes(m.id)
                                ? prev.filter((id) => id !== m.id)
                                : [...prev, m.id]
                            );
                          }
                        }}
                        className={`px-3 py-1 rounded-full text-xs font-medium border transition cursor-pointer ${
                          selectedMembers.includes(m.id)
                            ? "bg-blue-600 text-white border-blue-600 shadow-xs"
                            : "bg-white text-slate-700 border-slate-300 hover:bg-slate-50"
                        }`}
                      >
                        {m.name}
                      </button>
                    ))}
                  </div>
                </div>

                <button
                  type="submit"
                  className="w-full bg-slate-900 text-white py-2 rounded-lg text-sm font-semibold hover:bg-slate-800 transition cursor-pointer shadow-xs"
                >
                  Save Transaction
                </button>
              </form>

              {/* Ledger Table */}
              <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
                <div className="px-6 py-4 border-b border-slate-200 font-semibold text-sm text-slate-800 flex items-center justify-between">
                  <span>Transaction History</span>
                  <span className="text-xs text-slate-400 font-normal">
                    {expenses.length} {expenses.length === 1 ? "entry" : "entries"}
                  </span>
                </div>
                <div className="divide-y divide-slate-100 max-h-96 overflow-y-auto">
                  {expenses.length === 0 ? (
                    <p className="p-6 text-center text-xs text-slate-400 italic">
                      No transactions recorded yet for this group.
                    </p>
                  ) : (
                    expenses.map((exp) => (
                      <div
                        key={exp.id}
                        className="p-4 flex items-center justify-between text-sm hover:bg-slate-50/50 transition"
                      >
                        <div>
                          <div className="font-medium text-slate-900">
                            {exp.description}
                          </div>
                          <div className="text-xs text-slate-500 mt-0.5">
                            Paid by{" "}
                            <span className="font-medium text-slate-700">
                              {members.find((m) => m.id === exp.payerId)?.name ||
                                "Unknown"}
                            </span>{" "}
                            on {exp.date}
                          </div>
                        </div>
                        <div className="text-right">
                          <span className="font-semibold text-slate-900">
                            {exp.currency}
                            {exp.amount.toFixed(2)}
                          </span>
                          <span className="block text-[10px] uppercase font-semibold tracking-wider text-slate-400">
                            {exp.type}
                          </span>
                        </div>
                      </div>
                    ))
                  )}
                </div>
              </div>
            </>
          )}
        </section>

        {/* Settlement Minimization Plan */}
        <aside className="bg-white border border-slate-200 p-6 rounded-xl h-fit space-y-3">
          <div>
            <h2 className="font-semibold text-slate-800 text-sm">
              Optimal Settlement Plan
            </h2>
            <p className="text-xs text-slate-500 mt-0.5">
              Minimizes total payments needed to settle debts across all members.
            </p>
          </div>
          <div className="space-y-2">
            {settlements.length === 0 ? (
              <p className="text-xs text-slate-400 italic py-2">
                All debts are settled up.
              </p>
            ) : (
              settlements.map((s, idx) => (
                <div
                  key={idx}
                  className="p-3 bg-slate-50 border border-slate-200 rounded-lg text-xs"
                >
                  <span className="font-semibold text-slate-800">
                    {s.fromUser}
                  </span>{" "}
                  pays{" "}
                  <span className="font-semibold text-slate-800">
                    {s.toUser}
                  </span>
                  :
                  <div className="text-sm font-bold text-blue-600 mt-1">
                    {s.currency}
                    {s.amount.toFixed(2)}
                  </div>
                </div>
              ))
            )}
          </div>
        </aside>
      </div>

      {/* Member Invitation Modal */}
      <MemberInviteModal
        isOpen={isInviteModalOpen}
        onClose={() => setIsInviteModalOpen(false)}
        group={activeGroup}
        currentMembers={members}
        currentUserId={user.id}
        onMemberAdded={() => {
          if (activeGroupId) {
            refreshMembers(activeGroupId);
          }
        }}
      />
    </div>
  );
}
