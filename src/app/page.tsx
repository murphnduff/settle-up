"use client";

import { useEffect, useState, useTransition, useMemo, useCallback } from "react";
import { createClient } from "@/lib/supabase";
import {
  calculateSettlements,
  splitAmountEqually,
  SettlementInstruction,
} from "@/lib/reconciliation";
import MemberInviteModal, {
  Group,
  GroupMember,
} from "@/components/MemberInviteModal";
import EditExpenseModal, {
  ExpenseItem,
} from "@/components/EditExpenseModal";
import {
  UserPlus,
  Users,
  CheckCircle2,
  Trash2,
  LogOut,
  Plus,
  Receipt,
  ArrowRightLeft,
  Wallet,
  Sparkles,
  Edit3,
} from "lucide-react";
import type { User } from "@supabase/supabase-js";

export default function App() {
  const supabase = useMemo(() => createClient(), []);
  const [user, setUser] = useState<User | null>(null);
  const [groups, setGroups] = useState<Group[]>([]);
  const [activeGroupId, setActiveGroupId] = useState<string>("");
  const [members, setMembers] = useState<GroupMember[]>([]);
  const [newGroupName, setNewGroupName] = useState("");
  const [expenses, setExpenses] = useState<ExpenseItem[]>([]);
  const [isInviteModalOpen, setIsInviteModalOpen] = useState(false);
  const [editingExpense, setEditingExpense] = useState<ExpenseItem | null>(null);
  const [historyCurrencyFilter, setHistoryCurrencyFilter] = useState<
    "all" | "$" | "€"
  >("all");
  const [notification, setNotification] = useState<{
    type: "success" | "error";
    message: string;
  } | null>(null);

  // Lazy-initialize pending invite from URL or sessionStorage without triggering an effect
  const [hasPendingInvite] = useState<boolean>(() => {
    if (typeof window === "undefined") return false;
    const params = new URLSearchParams(window.location.search);
    const joinId = params.get("join");
    const token = params.get("token");
    if (token) {
      sessionStorage.setItem("settle_up_invite_token", token);
      return true;
    }
    if (joinId) {
      sessionStorage.setItem("settle_up_join_group", joinId);
      return true;
    }
    return (
      !!sessionStorage.getItem("settle_up_invite_token") ||
      !!sessionStorage.getItem("settle_up_join_group")
    );
  });

  // Form state
  const [description, setDescription] = useState("");
  const [amount, setAmount] = useState("");
  const [currency, setCurrency] = useState<"$" | "€">("$");
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

  // Refresh members callback
  const refreshMembers = useCallback(
    async (groupId: string) => {
      if (!groupId) return;
      const { data } = await supabase
        .from("group_members")
        .select("id, group_id, user_id, display_name, invited_email, invite_token, role")
        .eq("group_id", groupId);

      if (data) {
        const list: GroupMember[] = data.map((m) => ({
          id: m.id,
          groupId: m.group_id,
          userId: m.user_id,
          name: m.display_name || "Member",
          displayName: m.display_name,
          email: m.invited_email,
          invitedEmail: m.invited_email,
          inviteToken: m.invite_token,
          role: m.role || "member",
        }));
        setMembers(list);
        setSelectedMembers((prev) => {
          if (prev.length === 0) {
            return list.map((u) => u.id);
          }
          // retain currently selected members that still exist in the group
          const valid = prev.filter((id) => list.some((u) => u.id === id));
          return valid.length > 0 ? valid : list.map((u) => u.id);
        });
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
          "id, paid_by_member_id, description, amount_cents, currency, type, date, created_by, expense_splits(member_id, split_amount_cents)"
        )
        .eq("group_id", groupId)
        .order("date", { ascending: false });

      if (data) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const formatted: ExpenseItem[] = (data as any[]).map((e) => {
          const amtCents = Number(e.amount_cents || 0);
          const amt = amtCents / 100;
          const curr = e.currency === "EUR" ? "€" : "$";
          return {
            id: e.id,
            paidByMemberId: e.paid_by_member_id,
            payerId: e.paid_by_member_id,
            description: e.description,
            amount: amt,
            amountCents: amtCents,
            currency: curr,
            type: (e.type === "payment" ? "payment" : "expense") as "expense" | "payment",
            date: e.date,
            createdBy: e.created_by,
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            splits: (e.expense_splits || []).map((s: any) => {
              const splitCents = Number(s.split_amount_cents || 0);
              return {
                memberId: s.member_id,
                userId: s.member_id,
                amount: splitCents / 100,
                splitAmountCents: splitCents,
              };
            }),
          };
        });
        setExpenses(formatted);
      }
    },
    [supabase]
  );

  // Load groups or handle invite token / join link when user is authenticated
  useEffect(() => {
    if (!user) return;

    const params =
      typeof window !== "undefined"
        ? new URLSearchParams(window.location.search)
        : null;

    const pendingToken =
      params?.get("token") ||
      (typeof window !== "undefined"
        ? sessionStorage.getItem("settle_up_invite_token")
        : null);

    const joinId =
      params?.get("join") ||
      (typeof window !== "undefined"
        ? sessionStorage.getItem("settle_up_join_group")
        : null);

    const targetGroupId = params?.get("groupId");

    // Clean URL parameters
    if (typeof window !== "undefined" && (pendingToken || joinId || targetGroupId)) {
      const url = new URL(window.location.href);
      url.searchParams.delete("token");
      url.searchParams.delete("join");
      url.searchParams.delete("groupId");
      window.history.replaceState({}, "", url.pathname + (url.search ? url.search : ""));
    }

    async function initializeGroups() {
      const currentUser = user;
      if (!currentUser) return;

      // 1. Process pending token invite
      if (pendingToken) {
        sessionStorage.removeItem("settle_up_invite_token");
        try {
          const { data, error } = await supabase.rpc("claim_invite_token", {
            p_token: pendingToken,
          });
          if (!error && data?.group_id) {
            setNotification({
              type: "success",
              message: "Welcome! You have successfully claimed your group member spot.",
            });
            setActiveGroupId(data.group_id);
          }
        } catch (err) {
          console.error("Failed to claim token:", err);
        }
      } else if (joinId) {
        // 2. Process legacy group join
        sessionStorage.removeItem("settle_up_join_group");
        const { data: existing } = await supabase
          .from("group_members")
          .select("id")
          .eq("group_id", joinId)
          .eq("user_id", currentUser.id)
          .maybeSingle();

        if (!existing) {
          const { error } = await supabase.from("group_members").insert({
            group_id: joinId,
            user_id: currentUser.id,
            display_name:
              currentUser.user_metadata?.full_name ||
              currentUser.email?.split("@")[0] ||
              "Member",
            role: "member",
          });
          if (!error) {
            setNotification({
              type: "success",
              message: "Welcome! You have successfully joined the group.",
            });
          }
        }
        setActiveGroupId(joinId);
      } else if (targetGroupId) {
        setActiveGroupId(targetGroupId);
      }

      // 3. Fetch user groups
      const { data: userGroups } = await supabase.from("groups").select("*");
      if (userGroups && userGroups.length > 0) {
        setGroups(userGroups);
        setActiveGroupId((prev) => {
          if (prev && userGroups.some((g: Group) => g.id === prev)) {
            return prev;
          }
          return userGroups[0].id;
        });
      } else {
        setGroups([]);
        setActiveGroupId("");
      }
    }

    initializeGroups();
  }, [user, supabase]);

  // Load group members & expenses on active group change
  useEffect(() => {
    if (!activeGroupId) return;
    let cancelled = false;

    supabase
      .from("group_members")
      .select("id, group_id, user_id, display_name, invited_email, invite_token, role")
      .eq("group_id", activeGroupId)
      .then(({ data }) => {
        if (cancelled || !data) return;
        const list: GroupMember[] = data.map((m) => ({
          id: m.id,
          groupId: m.group_id,
          userId: m.user_id,
          name: m.display_name || "Member",
          displayName: m.display_name,
          email: m.invited_email,
          invitedEmail: m.invited_email,
          inviteToken: m.invite_token,
          role: m.role || "member",
        }));
        setMembers(list);
        setSelectedMembers((prev) => {
          if (prev.length === 0) {
            return list.map((u) => u.id);
          }
          const valid = prev.filter((id) => list.some((u) => u.id === id));
          return valid.length > 0 ? valid : list.map((u) => u.id);
        });
      });

    supabase
      .from("expenses")
      .select(
        "id, paid_by_member_id, description, amount_cents, currency, type, date, created_by, expense_splits(member_id, split_amount_cents)"
      )
      .eq("group_id", activeGroupId)
      .order("date", { ascending: false })
      .then(({ data }) => {
        if (cancelled || !data) return;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const formatted: ExpenseItem[] = (data as any[]).map((e) => {
          const amtCents = Number(e.amount_cents || 0);
          const amt = amtCents / 100;
          const curr = e.currency === "EUR" ? "€" : "$";
          return {
            id: e.id,
            paidByMemberId: e.paid_by_member_id,
            payerId: e.paid_by_member_id,
            description: e.description,
            amount: amt,
            amountCents: amtCents,
            currency: curr,
            type: (e.type === "payment" ? "payment" : "expense") as "expense" | "payment",
            date: e.date,
            createdBy: e.created_by,
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            splits: (e.expense_splits || []).map((s: any) => {
              const splitCents = Number(s.split_amount_cents || 0);
              return {
                memberId: s.member_id,
                userId: s.member_id,
                amount: splitCents / 100,
                splitAmountCents: splitCents,
              };
            }),
          };
        });
        setExpenses(formatted);
      });

    return () => {
      cancelled = true;
    };
  }, [activeGroupId, supabase]);

  // Effective payer defaults to current user's member row or first group member
  const effectivePayerId = useMemo(() => {
    if (payerId && members.some((m) => m.id === payerId)) {
      return payerId;
    }
    const userMember = members.find((m) => m.userId === user?.id);
    if (userMember) return userMember.id;
    return members[0]?.id || "";
  }, [payerId, members, user]);

  // Check if current user is admin or creator of active group
  const isGroupAdmin = useMemo(() => {
    if (!user || !activeGroup) return false;
    if (activeGroup.created_by === user.id) return true;
    return members.some((m) => m.userId === user.id && m.role === "admin");
  }, [user, activeGroup, members]);

  // Currency totals
  const usdTotal = useMemo(
    () =>
      expenses
        .filter((e) => e.currency === "$" || e.currency === "USD")
        .reduce((acc, e) => acc + e.amount, 0),
    [expenses]
  );

  const eurTotal = useMemo(
    () =>
      expenses
        .filter((e) => e.currency === "€" || e.currency === "EUR")
        .reduce((acc, e) => acc + e.amount, 0),
    [expenses]
  );

  // Filtered transactions for the ledger
  const filteredExpenses = useMemo(() => {
    if (historyCurrencyFilter === "all") return expenses;
    return expenses.filter(
      (e) =>
        e.currency === historyCurrencyFilter ||
        (historyCurrencyFilter === "$" && e.currency === "USD") ||
        (historyCurrencyFilter === "€" && e.currency === "EUR")
    );
  }, [expenses, historyCurrencyFilter]);

  // Memoized settlement calculations
  const settlements: SettlementInstruction[] = useMemo(() => {
    if (members.length > 0 && expenses.length > 0) {
      return calculateSettlements(members, expenses);
    }
    return [];
  }, [members, expenses]);

  // Isolate settlements by currency
  const usdSettlements = useMemo(
    () =>
      settlements.filter(
        (s) => s.currency === "$" || s.currency === "USD"
      ),
    [settlements]
  );
  const eurSettlements = useMemo(
    () =>
      settlements.filter(
        (s) => s.currency === "€" || s.currency === "EUR"
      ),
    [settlements]
  );

  // Live split computation
  const parsedAmount = parseFloat(amount);
  const perPersonAmount =
    !isNaN(parsedAmount) && parsedAmount > 0 && selectedMembers.length > 0
      ? (parsedAmount / selectedMembers.length).toFixed(2)
      : null;

  // Create new group
  const handleCreateGroup = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newGroupName.trim()) return;

    const {
      data: { user: currentUser },
    } = await supabase.auth.getUser();
    if (!currentUser) {
      alert("You must be logged in to create a group.");
      return;
    }

    // 1. Create the Group
    const { data: newGroup, error: groupError } = await supabase
      .from("groups")
      .insert({ name: newGroupName.trim(), created_by: currentUser.id })
      .select()
      .single();

    if (groupError) {
      alert("Error creating group: " + groupError.message);
      return;
    }

    // 2. Add creator as Admin with required display_name
    const creatorDisplayName =
      currentUser.user_metadata?.full_name ||
      currentUser.email?.split("@")[0] ||
      "Admin";

    const { error: memberError } = await supabase.from("group_members").insert({
      group_id: newGroup.id,
      user_id: currentUser.id,
      display_name: creatorDisplayName,
      role: "admin",
    });

    if (memberError) {
      alert("Error adding admin member: " + memberError.message);
      return;
    }

    setNewGroupName("");
    setGroups((prev) => [...prev, newGroup]);
    setActiveGroupId(newGroup.id);
  };

  // Delete group
  const handleDeleteGroup = async (groupId: string, groupName: string) => {
    const confirmed = window.confirm(
      `Are you sure you want to delete the group "${groupName}"? This will remove all associated expenses and settlements.`
    );
    if (!confirmed) return;

    await supabase.from("expenses").delete().eq("group_id", groupId);
    await supabase.from("group_members").delete().eq("group_id", groupId);

    const { error } = await supabase.from("groups").delete().eq("id", groupId);

    if (error) {
      alert("Error deleting group: " + error.message);
      return;
    }

    const remaining = groups.filter((g) => g.id !== groupId);
    setGroups(remaining);
    if (activeGroupId === groupId) {
      setActiveGroupId(remaining.length > 0 ? remaining[0].id : "");
    }
  };

  // Add transaction with penny-split precision
  const handleAddExpense = async (e: React.FormEvent) => {
    e.preventDefault();
    const finalPayerId = payerId || effectivePayerId;
    if (!amount || !finalPayerId || selectedMembers.length === 0 || !user) return;

    const parsed = parseFloat(amount);
    if (isNaN(parsed) || parsed <= 0) return;
    const totalCents = Math.round(parsed * 100);

    // 1. Insert into expenses
    const { data: newExp, error: expError } = await supabase
      .from("expenses")
      .insert({
        group_id: activeGroupId,
        created_by: user.id,
        paid_by_member_id: finalPayerId,
        description:
          description.trim() ||
          (type === "payment" ? "Direct Payment" : "Group Expense"),
        amount_cents: totalCents,
        currency: currency === "€" ? "EUR" : "USD",
        type,
        date: new Date().toISOString().split("T")[0],
      })
      .select()
      .single();

    if (expError) {
      alert("Error adding transaction: " + expError.message);
      return;
    }

    // 2. Prepare splits with integer remainder distribution
    let splitsPayload: Array<{
      expense_id: string;
      member_id: string;
      split_amount_cents: number;
    }> = [];

    if (type === "payment") {
      // Strictly 1-to-1 payment
      const recipientId = selectedMembers[0];
      splitsPayload = [
        {
          expense_id: newExp.id,
          member_id: recipientId,
          split_amount_cents: totalCents,
        },
      ];
    } else {
      // Group expense equal split with penny remainder distribution
      const equalSplits = splitAmountEqually(totalCents, selectedMembers);
      splitsPayload = equalSplits.map((s) => ({
        expense_id: newExp.id,
        member_id: s.memberId,
        split_amount_cents: s.splitAmountCents,
      }));
    }

    const { error: splitsError } = await supabase
      .from("expense_splits")
      .insert(splitsPayload);

    if (splitsError) {
      alert("Error adding splits: " + splitsError.message);
      return;
    }

    // Refresh UI
    setDescription("");
    setAmount("");
    startTransition(() => {
      refreshExpenses(activeGroupId);
    });
  };

  // Delete transaction (Group-wide permission)
  const handleDeleteExpense = async (expenseId: string, desc: string) => {
    const confirmed = window.confirm(
      `Are you sure you want to delete "${desc || "this transaction"}"?`
    );
    if (!confirmed) return;

    const { error } = await supabase
      .from("expenses")
      .delete()
      .eq("id", expenseId);

    if (error) {
      alert("Error deleting transaction: " + error.message);
      return;
    }

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
                You have been invited to join a group! Sign in with Google to claim your member spot.
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
        <aside className="bg-white border border-slate-200 p-4 rounded-2xl h-fit flex flex-col gap-4">
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
                    className={`group flex items-center justify-between px-3 py-2 text-sm rounded-xl transition ${
                      activeGroupId === g.id
                        ? "bg-blue-50 text-blue-700 font-semibold border border-blue-100 shadow-2xs"
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
                    {g.created_by === user.id && (
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
                    )}
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
          {activeGroup ? (
            <div className="bg-white border border-slate-200 p-5 rounded-2xl shadow-xs space-y-4">
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                <div>
                  <div className="flex items-center gap-2.5">
                    <h2 className="text-xl font-bold text-slate-900 tracking-tight">
                      {activeGroup.name}
                    </h2>
                    <span className="px-2.5 py-0.5 rounded-full text-xs font-semibold bg-slate-100 text-slate-700">
                      {members.length} {members.length === 1 ? "member" : "members"}
                    </span>
                  </div>
                  <div className="flex items-center gap-1.5 mt-2 flex-wrap">
                    {members.map((m) => (
                      <span
                        key={m.id}
                        className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs bg-slate-50 border border-slate-200 text-slate-700"
                      >
                        <span
                          className={`w-1.5 h-1.5 rounded-full ${
                            m.userId ? "bg-emerald-500" : "bg-amber-400"
                          }`}
                        ></span>
                        <span className="font-medium">{m.name}</span>
                        {m.role === "admin" && (
                          <span className="text-[10px] text-indigo-600 font-bold uppercase tracking-wider ml-0.5">
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
                  className={`inline-flex items-center justify-center gap-1.5 px-4 py-2 text-xs font-semibold rounded-xl transition shadow-xs shrink-0 cursor-pointer ${
                    isGroupAdmin
                      ? "bg-blue-600 hover:bg-blue-700 text-white"
                      : "bg-slate-100 hover:bg-slate-200 text-slate-700 border border-slate-200"
                  }`}
                >
                  {isGroupAdmin ? (
                    <>
                      <UserPlus className="w-4 h-4" />
                      Manage Members
                    </>
                  ) : (
                    <>
                      <Users className="w-4 h-4" />
                      View Members
                    </>
                  )}
                </button>
              </div>

              {/* Multi-Currency Ledger Summary Metrics */}
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 pt-3 border-t border-slate-100 text-xs">
                <div className="p-2.5 bg-slate-50/80 rounded-xl border border-slate-100">
                  <span className="text-slate-400 font-medium block text-[11px] mb-0.5">
                    USD Spent
                  </span>
                  <span className="text-base font-bold text-slate-900">
                    ${usdTotal.toFixed(2)}
                  </span>
                </div>
                <div className="p-2.5 bg-slate-50/80 rounded-xl border border-slate-100">
                  <span className="text-slate-400 font-medium block text-[11px] mb-0.5">
                    EUR Spent
                  </span>
                  <span className="text-base font-bold text-slate-900">
                    €{eurTotal.toFixed(2)}
                  </span>
                </div>
                <div className="p-2.5 bg-slate-50/80 rounded-xl border border-slate-100 col-span-2 sm:col-span-1">
                  <span className="text-slate-400 font-medium block text-[11px] mb-0.5">
                    Total Transactions
                  </span>
                  <span className="text-base font-bold text-slate-900">
                    {expenses.length}
                  </span>
                </div>
              </div>
            </div>
          ) : (
            <div className="bg-white border border-slate-200 p-8 rounded-2xl text-center text-slate-500 text-sm">
              Select or create a group to start tracking expenses.
            </div>
          )}

          {activeGroup && (
            <>
              {/* Add Transaction Form */}
              <form
                onSubmit={handleAddExpense}
                className="bg-white border border-slate-200 p-6 rounded-2xl shadow-xs space-y-4"
              >
                <div className="flex items-center justify-between">
                  <h2 className="font-bold text-slate-900 text-base">
                    Add Transaction
                  </h2>
                  <div className="flex bg-slate-100 p-0.5 rounded-lg border border-slate-200">
                    <button
                      type="button"
                      onClick={() => setType("expense")}
                      className={`px-3 py-1 rounded-md text-xs font-semibold transition cursor-pointer ${
                        type === "expense"
                          ? "bg-white text-slate-900 shadow-2xs"
                          : "text-slate-500 hover:text-slate-800"
                      }`}
                    >
                      Group Expense
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setType("payment");
                        if (members.length > 0 && selectedMembers.length !== 1) {
                          setSelectedMembers([members[0].id]);
                        }
                      }}
                      className={`px-3 py-1 rounded-md text-xs font-semibold transition cursor-pointer ${
                        type === "payment"
                          ? "bg-white text-slate-900 shadow-2xs"
                          : "text-slate-500 hover:text-slate-800"
                      }`}
                    >
                      Direct Payment
                    </button>
                  </div>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <div>
                    <label className="text-xs font-semibold text-slate-600 block mb-1">
                      Paid By
                    </label>
                    <select
                      value={effectivePayerId}
                      onChange={(e) => setPayerId(e.target.value)}
                      className="w-full border border-slate-300 rounded-lg p-2 text-sm text-slate-900 bg-white focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent transition"
                      required
                    >
                      <option value="">Select Member</option>
                      {members.map((m) => (
                        <option key={m.id} value={m.id}>
                          {m.name} {m.userId === user.id ? "(You)" : ""}
                        </option>
                      ))}
                    </select>
                  </div>

                  <div>
                    <label className="text-xs font-semibold text-slate-600 block mb-1">
                      Amount & Currency
                    </label>
                    <div className="flex gap-2">
                      <div className="relative flex-1">
                        <span className="absolute left-3 top-2 text-sm font-semibold text-slate-400">
                          {currency}
                        </span>
                        <input
                          type="number"
                          step="0.01"
                          placeholder="0.00"
                          value={amount}
                          onChange={(e) => setAmount(e.target.value)}
                          className="w-full pl-7 pr-3 py-2 border border-slate-300 rounded-lg text-sm text-slate-900 placeholder:text-slate-400 bg-white focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent transition"
                          required
                        />
                      </div>
                      <div className="flex border border-slate-300 rounded-lg p-0.5 bg-slate-100">
                        <button
                          type="button"
                          onClick={() => setCurrency("$")}
                          className={`px-3 py-1 text-xs font-bold rounded-md transition cursor-pointer ${
                            currency === "$"
                              ? "bg-white text-blue-700 shadow-2xs"
                              : "text-slate-500 hover:text-slate-800"
                          }`}
                        >
                          $ USD
                        </button>
                        <button
                          type="button"
                          onClick={() => setCurrency("€")}
                          className={`px-3 py-1 text-xs font-bold rounded-md transition cursor-pointer ${
                            currency === "€"
                              ? "bg-white text-blue-700 shadow-2xs"
                              : "text-slate-500 hover:text-slate-800"
                          }`}
                        >
                          € EUR
                        </button>
                      </div>
                    </div>
                  </div>
                </div>

                <div>
                  <label className="text-xs font-semibold text-slate-600 block mb-1">
                    Description
                  </label>
                  <input
                    type="text"
                    placeholder="e.g. Dinner, Fuel, Groceries, Hotel"
                    value={description}
                    onChange={(e) => setDescription(e.target.value)}
                    className="w-full border border-slate-300 rounded-lg p-2 text-sm text-slate-900 placeholder:text-slate-400 bg-white focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent transition"
                    required
                  />
                </div>

                {/* Split Among with Live Preview and Select All */}
                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <label className="text-xs font-semibold text-slate-600">
                      {type === "expense"
                        ? `Split Among (${selectedMembers.length} selected)`
                        : "Paid To (Recipient)"}
                    </label>
                    {type === "expense" && members.length > 0 && (
                      <div className="flex items-center gap-2 text-xs">
                        <button
                          type="button"
                          onClick={() =>
                            setSelectedMembers(members.map((m) => m.id))
                          }
                          className="text-blue-600 hover:text-blue-700 font-semibold cursor-pointer"
                        >
                          Select All
                        </button>
                        <span className="text-slate-300">•</span>
                        <button
                          type="button"
                          onClick={() => setSelectedMembers([])}
                          className="text-slate-400 hover:text-slate-600 cursor-pointer"
                        >
                          Clear
                        </button>
                      </div>
                    )}
                  </div>

                  <div className="flex flex-wrap gap-2">
                    {members.map((m) => {
                      const isSelected = selectedMembers.includes(m.id);
                      return (
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
                          className={`px-3 py-1.5 rounded-full text-xs font-medium border transition cursor-pointer flex items-center gap-1.5 ${
                            isSelected
                              ? "bg-blue-600 text-white border-blue-600 shadow-xs"
                              : "bg-white text-slate-700 border-slate-200 hover:bg-slate-50"
                          }`}
                        >
                          <span>{m.name}</span>
                          {isSelected && <span className="text-[10px]">✓</span>}
                        </button>
                      );
                    })}
                  </div>

                  {/* Live split calculation preview */}
                  {perPersonAmount && type === "expense" && (
                    <div className="p-2.5 bg-blue-50/70 border border-blue-100 rounded-xl text-xs text-blue-800 flex items-center justify-between animate-in fade-in-50">
                      <span className="flex items-center gap-1.5">
                        <Sparkles className="w-3.5 h-3.5 text-blue-600 shrink-0" />
                        <span>
                          Equal split across {selectedMembers.length}{" "}
                          {selectedMembers.length === 1 ? "person" : "people"}:
                        </span>
                      </span>
                      <span className="font-bold text-blue-900 text-sm">
                        {currency}
                        {perPersonAmount} each
                      </span>
                    </div>
                  )}
                </div>

                <button
                  type="submit"
                  className="w-full bg-slate-900 text-white py-2.5 rounded-xl text-sm font-semibold hover:bg-slate-800 transition cursor-pointer shadow-xs"
                >
                  Save Transaction
                </button>
              </form>

              {/* Ledger Table with Currency Isolation Filter and Group-Wide Editing */}
              <div className="bg-white border border-slate-200 rounded-2xl shadow-xs overflow-hidden">
                <div className="px-6 py-4 border-b border-slate-200 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                  <div>
                    <h3 className="font-bold text-sm text-slate-900">
                      Transaction History
                    </h3>
                    <p className="text-xs text-slate-400">
                      Showing {filteredExpenses.length} of {expenses.length}{" "}
                      records • Group members can edit or delete any transaction
                    </p>
                  </div>

                  {/* Currency Segmented Tabs */}
                  <div className="flex bg-slate-100 p-0.5 rounded-lg border border-slate-200 text-xs">
                    <button
                      type="button"
                      onClick={() => setHistoryCurrencyFilter("all")}
                      className={`px-3 py-1 rounded-md font-semibold transition cursor-pointer ${
                        historyCurrencyFilter === "all"
                          ? "bg-white text-slate-900 shadow-2xs"
                          : "text-slate-500 hover:text-slate-800"
                      }`}
                    >
                      All
                    </button>
                    <button
                      type="button"
                      onClick={() => setHistoryCurrencyFilter("$")}
                      className={`px-3 py-1 rounded-md font-semibold transition cursor-pointer ${
                        historyCurrencyFilter === "$"
                          ? "bg-white text-blue-700 shadow-2xs"
                          : "text-slate-500 hover:text-slate-800"
                      }`}
                    >
                      $ USD (
                      {
                        expenses.filter(
                          (e) => e.currency === "$" || e.currency === "USD"
                        ).length
                      }
                      )
                    </button>
                    <button
                      type="button"
                      onClick={() => setHistoryCurrencyFilter("€")}
                      className={`px-3 py-1 rounded-md font-semibold transition cursor-pointer ${
                        historyCurrencyFilter === "€"
                          ? "bg-white text-blue-700 shadow-2xs"
                          : "text-slate-500 hover:text-slate-800"
                      }`}
                    >
                      € EUR (
                      {
                        expenses.filter(
                          (e) => e.currency === "€" || e.currency === "EUR"
                        ).length
                      }
                      )
                    </button>
                  </div>
                </div>

                <div className="divide-y divide-slate-100 max-h-96 overflow-y-auto">
                  {filteredExpenses.length === 0 ? (
                    <div className="p-8 text-center text-xs text-slate-400 italic">
                      No transactions recorded for this currency filter.
                    </div>
                  ) : (
                    filteredExpenses.map((exp) => {
                      const isPayment = exp.type === "payment";
                      const payerMember = members.find(
                        (m) => m.id === exp.paidByMemberId || m.id === exp.payerId
                      );

                      return (
                        <div
                          key={exp.id}
                          className={`p-4 flex items-center justify-between text-sm hover:bg-slate-50/60 transition gap-3 border-l-4 ${
                            isPayment
                              ? "border-l-[#BDE0FF] bg-[#F8FBFF]"
                              : "border-l-[#FFC4C4] bg-[#FFFBFB]"
                          }`}
                        >
                          <div className="flex items-start gap-3 min-w-0">
                            <div
                              className={`p-2 rounded-xl shrink-0 mt-0.5 border ${
                                isPayment
                                  ? "bg-[#EBF5FF] text-[#1976D2] border-[#BDE0FF]"
                                  : "bg-[#FFF0F0] text-[#D32F2F] border-[#FFC4C4]"
                              }`}
                            >
                              {isPayment ? (
                                <ArrowRightLeft className="w-4 h-4" />
                              ) : (
                                <Receipt className="w-4 h-4" />
                              )}
                            </div>
                            <div className="min-w-0">
                              <div className="font-semibold text-slate-900 truncate">
                                {exp.description}
                              </div>
                              <div className="text-xs text-slate-500 mt-0.5">
                                Paid by{" "}
                                <span className="font-medium text-slate-700">
                                  {payerMember?.name || "Unknown"}
                                </span>{" "}
                                • {exp.date}
                                {isPayment && exp.splits.length > 0 && (
                                  <span className="text-slate-400 ml-1">
                                    → To{" "}
                                    {members.find(
                                      (m) => m.id === exp.splits[0].memberId
                                    )?.name || "Member"}
                                  </span>
                                )}
                              </div>
                            </div>
                          </div>

                          <div className="flex items-center gap-3 shrink-0">
                            <div className="text-right">
                              <span className="font-bold text-slate-900 text-sm">
                                {exp.currency}
                                {exp.amount.toFixed(2)}
                              </span>
                              <span
                                className={`block text-[10px] uppercase font-bold tracking-wider mt-0.5 ${
                                  isPayment
                                    ? "text-blue-700"
                                    : "text-rose-600"
                                }`}
                              >
                                {exp.type}
                              </span>
                            </div>

                            {/* Group-Wide Transaction Edit & Delete Actions */}
                            <div className="flex items-center gap-1 pl-2 border-l border-slate-200">
                              <button
                                type="button"
                                onClick={() => setEditingExpense(exp)}
                                title="Edit transaction"
                                className="p-1.5 text-slate-400 hover:text-blue-600 hover:bg-blue-50 rounded-lg transition cursor-pointer"
                              >
                                <Edit3 className="w-3.5 h-3.5" />
                              </button>
                              <button
                                type="button"
                                onClick={() =>
                                  handleDeleteExpense(exp.id, exp.description)
                                }
                                title="Delete transaction"
                                className="p-1.5 text-slate-400 hover:text-red-600 hover:bg-red-50 rounded-lg transition cursor-pointer"
                              >
                                <Trash2 className="w-3.5 h-3.5" />
                              </button>
                            </div>
                          </div>
                        </div>
                      );
                    })
                  )}
                </div>
              </div>
            </>
          )}
        </section>

        {/* Multi-Currency Settlement Minimization Plan */}
        <aside className="bg-white border border-slate-200 p-6 rounded-2xl shadow-xs h-fit space-y-4">
          <div>
            <h2 className="font-bold text-slate-900 text-base flex items-center gap-2">
              <Wallet className="w-4 h-4 text-blue-600" />
              Settlement Plan
            </h2>
            <p className="text-xs text-slate-500 mt-1">
              Greedy cash-flow minimization pairing largest debtors with largest creditors across isolated currency ledgers.
            </p>
          </div>

          {/* USD ($) Settlements */}
          <div className="space-y-2 pt-3 border-t border-slate-100">
            <div className="flex items-center justify-between text-xs font-bold text-slate-800">
              <span className="flex items-center gap-1.5">
                <span className="w-2 h-2 rounded-full bg-blue-600"></span>
                USD ($) Ledger
              </span>
              <span className="text-[10px] font-semibold text-slate-400 uppercase tracking-wider">
                {usdSettlements.length === 0
                  ? "Settled"
                  : `${usdSettlements.length} transfer(s)`}
              </span>
            </div>

            {usdSettlements.length === 0 ? (
              <div className="p-3 bg-slate-50 rounded-xl text-xs text-slate-400 italic text-center">
                All USD debts are settled up.
              </div>
            ) : (
              usdSettlements.map((s, idx) => (
                <div
                  key={idx}
                  className="p-3 bg-blue-50/50 border border-blue-100 rounded-xl text-xs space-y-1"
                >
                  <div className="text-slate-700">
                    <span className="font-bold text-slate-900">{s.fromUser}</span>{" "}
                    pays{" "}
                    <span className="font-bold text-slate-900">{s.toUser}</span>
                  </div>
                  <div className="text-sm font-bold text-blue-700">
                    ${s.amount.toFixed(2)}
                  </div>
                </div>
              ))
            )}
          </div>

          {/* EUR (€) Settlements */}
          <div className="space-y-2 pt-3 border-t border-slate-100">
            <div className="flex items-center justify-between text-xs font-bold text-slate-800">
              <span className="flex items-center gap-1.5">
                <span className="w-2 h-2 rounded-full bg-indigo-600"></span>
                EUR (€) Ledger
              </span>
              <span className="text-[10px] font-semibold text-slate-400 uppercase tracking-wider">
                {eurSettlements.length === 0
                  ? "Settled"
                  : `${eurSettlements.length} transfer(s)`}
              </span>
            </div>

            {eurSettlements.length === 0 ? (
              <div className="p-3 bg-slate-50 rounded-xl text-xs text-slate-400 italic text-center">
                All EUR debts are settled up.
              </div>
            ) : (
              eurSettlements.map((s, idx) => (
                <div
                  key={idx}
                  className="p-3 bg-indigo-50/50 border border-indigo-100 rounded-xl text-xs space-y-1"
                >
                  <div className="text-slate-700">
                    <span className="font-bold text-slate-900">{s.fromUser}</span>{" "}
                    pays{" "}
                    <span className="font-bold text-slate-900">{s.toUser}</span>
                  </div>
                  <div className="text-sm font-bold text-indigo-700">
                    €{s.amount.toFixed(2)}
                  </div>
                </div>
              ))
            )}
          </div>
        </aside>
      </div>

      {/* Member Management Modal */}
      <MemberInviteModal
        isOpen={isInviteModalOpen}
        onClose={() => setIsInviteModalOpen(false)}
        group={activeGroup}
        currentMembers={members}
        currentUserId={user.id}
        expenses={expenses}
        onMemberAdded={() => {
          if (activeGroupId) {
            refreshMembers(activeGroupId);
          }
        }}
      />

      {/* Edit Transaction Modal */}
      {editingExpense && (
        <EditExpenseModal
          key={editingExpense.id}
          isOpen={true}
          onClose={() => setEditingExpense(null)}
          expense={editingExpense}
          members={members}
          onSaved={() => {
            if (activeGroupId) {
              refreshExpenses(activeGroupId);
            }
          }}
        />
      )}
    </div>
  );
}
