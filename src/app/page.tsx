"use client";

import {
  useEffect,
  useState,
  useTransition,
  useMemo,
  useCallback,
  Suspense,
} from "react";
import { createClient } from "@/lib/supabase";
import {
  calculateSettlements,
  splitAmountEqually,
  splitAmountByPercentage,
  validateExactSplits,
  parseGroupCsv,
  generateGroupCsv,
  deriveGroupNameFromCsvFilename,
  ParsedGroupCsvResult,
  SettlementInstruction,
} from "@/lib/reconciliation";
import MemberInviteModal, {
  Group,
  GroupMember,
  generateGroupSlug,
} from "@/components/MemberInviteModal";
import EditExpenseModal, {
  ExpenseItem,
  SplitMode,
  getTodayLocalDate,
  formatTransactionDate,
} from "@/components/EditExpenseModal";
import {
  UserPlus,
  Users,
  CheckCircle2,
  Trash2,
  LogOut,
  LogIn,
  Plus,
  Receipt,
  ArrowRightLeft,
  Wallet,
  Sparkles,
  Edit3,
  Share2,
  Check,
  Shield,
  UserCheck,
  Download,
  Upload,
  AlertCircle,
  X,
} from "lucide-react";
import type { User, SupabaseClient } from "@supabase/supabase-js";

const SUPER_ADMIN_EMAIL = "murph@murphnduff.org";
const RECENT_GROUPS_STORAGE_KEY = "settle_up_recent_groups";
const memberStorageKey = (groupId: string) => `settle_up_member_${groupId}`;
const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function normalizeGroup(row: any): Group {
  const name = typeof row?.name === "string" ? row.name : "Group";
  const slug =
    typeof row?.slug === "string" && row.slug.trim().length > 0
      ? row.slug.trim()
      : generateGroupSlug(name) || row.id;
  return {
    id: row.id,
    name,
    slug,
    created_by: row.created_by ?? null,
    created_at: row.created_at,
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function mapAndSortExpenses(rows: any[]): ExpenseItem[] {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const mapped: ExpenseItem[] = rows.map((e: any) => {
    const amtCents = Number(
      e.amount_cents ?? Math.round(Number(e.amount || 0) * 100)
    );
    const amt = amtCents / 100;
    const curr = e.currency === "EUR" || e.currency === "€" ? "€" : "$";
    const cleanDate =
      typeof e.date === "string" ? e.date.split("T")[0] : getTodayLocalDate();
    return {
      id: e.id,
      paidByMemberId: e.paid_by_member_id,
      payerId: e.paid_by_member_id,
      description: e.description,
      amount: amt,
      amountCents: amtCents,
      currency: curr,
      type: (e.type === "payment" ? "payment" : "expense") as
        | "expense"
        | "payment",
      date: cleanDate,
      createdAt: typeof e.created_at === "string" ? e.created_at : "",
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      splits: (e.expense_splits || []).map((s: any) => {
        const splitCents = Number(
          s.split_amount_cents ?? Math.round(Number(s.amount || 0) * 100)
        );
        return {
          memberId: s.member_id,
          userId: s.member_id,
          amount: splitCents / 100,
          splitAmountCents: splitCents,
        };
      }),
    };
  });

  // Sort chronologically by date descending, with created_at descending as tie-breaker
  return mapped.sort((a, b) => {
    const dateCmp = (b.date || "").localeCompare(a.date || "");
    if (dateCmp !== 0) return dateCmp;
    const createdCmp = (b.createdAt || "").localeCompare(a.createdAt || "");
    if (createdCmp !== 0) return createdCmp;
    return b.id.localeCompare(a.id);
  });
}

function getRecentGroupIds(): string[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = localStorage.getItem(RECENT_GROUPS_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.filter(
          (id): id is string => typeof id === "string" && id.length > 0
        )
      : [];
  } catch {
    return [];
  }
}

function addRecentGroupId(groupId: string): string[] {
  if (typeof window === "undefined" || !groupId) return [];
  try {
    const existing = getRecentGroupIds().filter((id) => id !== groupId);
    const updated = [groupId, ...existing].slice(0, 25);
    localStorage.setItem(RECENT_GROUPS_STORAGE_KEY, JSON.stringify(updated));
    return updated;
  } catch {
    return [groupId];
  }
}

function removeRecentGroupId(groupId: string): void {
  if (typeof window === "undefined" || !groupId) return;
  try {
    const updated = getRecentGroupIds().filter((id) => id !== groupId);
    localStorage.setItem(RECENT_GROUPS_STORAGE_KEY, JSON.stringify(updated));
    localStorage.removeItem(memberStorageKey(groupId));
  } catch {
    // ignore storage errors
  }
}

async function resolveGroupBySlugOrId(
  supabase: SupabaseClient,
  rawSlugOrId: string
): Promise<Group | null> {
  const cleanParam = decodeURIComponent(rawSlugOrId).trim();
  if (!cleanParam) return null;

  const isUuid = UUID_REGEX.test(cleanParam);

  // 1. Try direct query using ilike(slug, cleanParam) or id = cleanParam
  if (isUuid) {
    const { data, error } = await supabase
      .from("groups")
      .select("*")
      .or(`slug.ilike.${cleanParam},id.eq.${cleanParam}`)
      .maybeSingle();

    if (!error && data) {
      return normalizeGroup(data);
    }

    // Fallback if slug column does not exist yet on public.groups
    const { data: byId } = await supabase
      .from("groups")
      .select("*")
      .eq("id", cleanParam)
      .maybeSingle();

    if (byId) {
      return normalizeGroup(byId);
    }
  } else {
    const { data, error } = await supabase
      .from("groups")
      .select("*")
      .ilike("slug", cleanParam)
      .maybeSingle();

    if (!error && data) {
      return normalizeGroup(data);
    }
  }

  // 2. Targeted fallback by space-normalized name (never runs an unfiltered SELECT * FROM groups)
  const spaceNormalizedTarget = cleanParam.replace(/_/g, " ").trim();
  if (spaceNormalizedTarget) {
    const { data: byName } = await supabase
      .from("groups")
      .select("*")
      .ilike("name", spaceNormalizedTarget)
      .maybeSingle();

    if (byName) {
      return normalizeGroup(byName);
    }
  }

  return null;
}

export function SettleUpDashboard({
  initialSlug,
  initialGroupId,
}: {
  initialSlug?: string;
  initialGroupId?: string;
}) {
  const supabase = useMemo(() => createClient(), []);
  const routeTarget = initialSlug || initialGroupId || "";

  const [user, setUser] = useState<User | null>(null);
  const [authInitialized, setAuthInitialized] = useState(false);
  const [groups, setGroups] = useState<Group[]>([]);
  const [activeGroupId, setActiveGroupId] = useState<string>("");
  const [members, setMembers] = useState<GroupMember[]>([]);
  const [activeMemberId, setActiveMemberId] = useState<string>("");
  const [newGroupName, setNewGroupName] = useState("");
  const [addAdminAsMember, setAddAdminAsMember] = useState<boolean>(true);
  const [expenses, setExpenses] = useState<ExpenseItem[]>([]);
  const [isInviteModalOpen, setIsInviteModalOpen] = useState(false);
  const [editingExpense, setEditingExpense] = useState<ExpenseItem | null>(null);
  const [copiedGroupLink, setCopiedGroupLink] = useState(false);
  const [historyCurrencyFilter, setHistoryCurrencyFilter] = useState<
    "all" | "$" | "€"
  >("all");
  const [notification, setNotification] = useState<{
    type: "success" | "error";
    message: string;
  } | null>(null);

  // Add Transaction Form state
  const [description, setDescription] = useState("");
  const [amount, setAmount] = useState("");
  const [currency, setCurrency] = useState<"$" | "€">("$");
  const [payerId, setPayerId] = useState("");
  const [transactionDate, setTransactionDate] = useState<string>(() =>
    getTodayLocalDate()
  );
  const [type, setType] = useState<"expense" | "payment">("expense");
  const [splitMode, setSplitMode] = useState<SplitMode>("equal");
  const [selectedMembers, setSelectedMembers] = useState<string[]>([]);
  const [percentageValues, setPercentageValues] = useState<
    Record<string, string>
  >({});
  const [exactValues, setExactValues] = useState<Record<string, string>>({});

  // CSV Import Modal state (Super-Admin only)
  const [isCsvModalOpen, setIsCsvModalOpen] = useState(false);
  const [csvTargetMode, setCsvTargetMode] = useState<"new" | "active">("new");
  const [csvGroupName, setCsvGroupName] = useState("");
  const [parsedCsv, setParsedCsv] = useState<ParsedGroupCsvResult | null>(null);
  const [csvFileName, setCsvFileName] = useState("");
  const [isImportingCsv, setIsImportingCsv] = useState(false);
  const [csvError, setCsvError] = useState<string | null>(null);

  const [, startTransition] = useTransition();

  // Super-Admin strictly restricted to murph@murphnduff.org
  const isSuperAdmin = useMemo(
    () => user?.email?.toLowerCase() === SUPER_ADMIN_EMAIL,
    [user]
  );

  // Active group derived
  const activeGroup = useMemo(
    () => groups.find((g) => g.id === activeGroupId) || null,
    [groups, activeGroupId]
  );

  // Auth listener
  useEffect(() => {
    supabase.auth.getUser().then(({ data }) => {
      setUser(data.user);
      setAuthInitialized(true);
    });
    const { data: authListener } = supabase.auth.onAuthStateChange(
      (_, session) => {
        setUser(session?.user ?? null);
        setAuthInitialized(true);
      }
    );
    return () => authListener.subscription.unsubscribe();
  }, [supabase]);

  // Refresh members callback (queries ONLY id, group_id, display_name so it never fails on missing columns)
  const refreshMembers = useCallback(
    async (groupId: string) => {
      if (!groupId) return;
      const { data, error } = await supabase
        .from("group_members")
        .select("id, group_id, display_name")
        .eq("group_id", groupId);

      if (error) {
        console.error("Failed to fetch group_members:", error.message);
        return;
      }

      if (data) {
        const list: GroupMember[] = data.map((m) => ({
          id: m.id,
          groupId: m.group_id,
          name: m.display_name || "Member",
          displayName: m.display_name || "Member",
        }));
        setMembers(list);
        setSelectedMembers((prev) => {
          if (prev.length === 0) {
            return list.map((u) => u.id);
          }
          const valid = prev.filter((id) => list.some((u) => u.id === id));
          return valid.length > 0 ? valid : list.map((u) => u.id);
        });
      }
    },
    [supabase]
  );

  // Refresh expenses callback (sorted by date descending, with created_at descending as tie-breaker)
  const refreshExpenses = useCallback(
    async (groupId: string) => {
      if (!groupId) return;
      const { data, error } = await supabase
        .from("expenses")
        .select("*, expense_splits(member_id, split_amount_cents)")
        .eq("group_id", groupId)
        .order("date", { ascending: false });

      if (error) {
        console.error("Failed to fetch expenses:", error.message);
        return;
      }

      if (data) {
        setExpenses(mapAndSortExpenses(data));
      }
    },
    [supabase]
  );

  // Load target group from URL (/[slug]) and sidebar groups list
  useEffect(() => {
    let cancelled = false;

    const params =
      typeof window !== "undefined"
        ? new URLSearchParams(window.location.search)
        : null;
    const queryGroupParam = params?.get("groupId") || params?.get("join") || "";
    const targetSlugOrId = routeTarget || queryGroupParam;

    async function loadGroupsAndActiveTarget() {
      // 1. If a URL slug or group ID was visited, resolve it immediately (regardless of auth status!)
      let resolvedTargetGroup: Group | null = null;
      if (targetSlugOrId) {
        resolvedTargetGroup = await resolveGroupBySlugOrId(
          supabase,
          targetSlugOrId
        );
        if (cancelled) return;

        if (resolvedTargetGroup) {
          addRecentGroupId(resolvedTargetGroup.id);
          setActiveGroupId(resolvedTargetGroup.id);
          // Immediately ensure the resolved group is in groups state so the UI never flashes "No active group selected"
          setGroups((prev) => {
            if (prev.some((g) => g.id === resolvedTargetGroup!.id)) {
              return prev;
            }
            return [resolvedTargetGroup!, ...prev];
          });
        }
      }

      // 2. Load the full sidebar list based on Super-Admin status vs recent_groups in localStorage
      if (isSuperAdmin) {
        const { data: allRows } = await supabase.from("groups").select("*");
        if (cancelled) return;

        const normalizedList = (allRows || []).map(normalizeGroup);
        if (
          resolvedTargetGroup &&
          !normalizedList.some((g) => g.id === resolvedTargetGroup!.id)
        ) {
          normalizedList.unshift(resolvedTargetGroup);
        }

        setGroups(normalizedList);
        setActiveGroupId((prev) => {
          if (resolvedTargetGroup) return resolvedTargetGroup.id;
          if (prev && normalizedList.some((g) => g.id === prev)) return prev;
          return normalizedList[0]?.id || "";
        });
      } else {
        const recentIds = getRecentGroupIds();
        if (
          resolvedTargetGroup &&
          !recentIds.includes(resolvedTargetGroup.id)
        ) {
          recentIds.unshift(resolvedTargetGroup.id);
        }

        if (recentIds.length === 0) {
          if (!cancelled) {
            setGroups([]);
            setActiveGroupId("");
          }
          return;
        }

        const { data: recentRows } = await supabase
          .from("groups")
          .select("*")
          .in("id", recentIds);

        if (cancelled) return;

        const normalizedList = (recentRows || [])
          .map(normalizeGroup)
          .sort((a, b) => recentIds.indexOf(a.id) - recentIds.indexOf(b.id));

        if (
          resolvedTargetGroup &&
          !normalizedList.some((g) => g.id === resolvedTargetGroup!.id)
        ) {
          normalizedList.unshift(resolvedTargetGroup);
        }

        setGroups(normalizedList);
        setActiveGroupId((prev) => {
          if (resolvedTargetGroup) return resolvedTargetGroup.id;
          if (prev && normalizedList.some((g) => g.id === prev)) return prev;
          return normalizedList[0]?.id || "";
        });
      }
    }

    loadGroupsAndActiveTarget();

    return () => {
      cancelled = true;
    };
  }, [authInitialized, isSuperAdmin, routeTarget, supabase]);

  // Load group members & expenses when activeGroupId changes, and resolve ?m=<display_name> or localStorage identity
  useEffect(() => {
    if (!activeGroupId) return;
    let cancelled = false;

    // Save activeGroupId to recent groups in localStorage
    addRecentGroupId(activeGroupId);

    const params =
      typeof window !== "undefined"
        ? new URLSearchParams(window.location.search)
        : null;
    const urlMemberParam = params?.get("m")?.trim() || "";
    const storedMemberValue =
      typeof window !== "undefined"
        ? localStorage.getItem(memberStorageKey(activeGroupId)) || ""
        : "";

    supabase
      .from("group_members")
      .select("id, group_id, display_name")
      .eq("group_id", activeGroupId)
      .then(({ data, error }) => {
        if (cancelled) return;
        if (error) {
          console.error("Error loading group_members:", error.message);
          return;
        }
        if (!data) return;

        const list: GroupMember[] = data.map((m) => ({
          id: m.id,
          groupId: m.group_id,
          name: m.display_name || "Member",
          displayName: m.display_name || "Member",
        }));
        setMembers(list);
        setSelectedMembers(list.map((u) => u.id));

        // Match member by ?m=<display_name> (case-insensitive) or ?m=<member_id>, or fallback to localStorage
        let matchedMember: GroupMember | undefined;

        if (urlMemberParam) {
          const lowerUrlParam = urlMemberParam.toLowerCase();
          matchedMember = list.find(
            (m) =>
              m.name.trim().toLowerCase() === lowerUrlParam ||
              m.id.toLowerCase() === lowerUrlParam
          );
        }

        if (!matchedMember && storedMemberValue) {
          const lowerStored = storedMemberValue.toLowerCase();
          matchedMember = list.find(
            (m) =>
              m.id.toLowerCase() === lowerStored ||
              m.name.trim().toLowerCase() === lowerStored
          );
        }

        if (matchedMember) {
          setActiveMemberId(matchedMember.id);
          setPayerId(matchedMember.id);
          if (typeof window !== "undefined") {
            localStorage.setItem(
              memberStorageKey(activeGroupId),
              matchedMember.id
            );
          }
        } else {
          setActiveMemberId("");
          setPayerId(list[0]?.id || "");
        }
      });

    supabase
      .from("expenses")
      .select("*, expense_splits(member_id, split_amount_cents)")
      .eq("group_id", activeGroupId)
      .order("date", { ascending: false })
      .then(({ data, error }) => {
        if (cancelled) return;
        if (error) {
          console.error("Error loading expenses:", error.message);
          return;
        }
        if (!data) return;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        setExpenses(mapAndSortExpenses(data as any[]));
      });

    return () => {
      cancelled = true;
    };
  }, [activeGroupId, supabase]);

  // Select member identity ("Who are you in this group?")
  const handleSelectIdentity = (member: GroupMember) => {
    setActiveMemberId(member.id);
    setPayerId(member.id);
    if (activeGroupId && typeof window !== "undefined") {
      localStorage.setItem(memberStorageKey(activeGroupId), member.id);
      addRecentGroupId(activeGroupId);

      const slugOrId = activeGroup
        ? activeGroup.slug ||
          generateGroupSlug(activeGroup.name) ||
          activeGroup.id
        : activeGroupId;

      window.history.replaceState(
        null,
        "",
        `/${slugOrId}?m=${encodeURIComponent(member.name)}`
      );
    }
  };

  // Switch active group and sync browser URL to /<slug>
  const handleSelectGroup = (group: Group) => {
    setActiveGroupId(group.id);
    addRecentGroupId(group.id);
    if (typeof window !== "undefined") {
      const slugOrId = group.slug || generateGroupSlug(group.name) || group.id;
      window.history.pushState(null, "", `/${slugOrId}`);
    }
  };

  // Copy Main Group Link (https://split.murphnduff.org/<group.slug>)
  const handleCopyGroupLink = async () => {
    if (!activeGroup) return;
    const origin =
      typeof window !== "undefined" && window.location?.origin
        ? window.location.origin
        : "https://split.murphnduff.org";
    const slugOrId =
      activeGroup.slug || generateGroupSlug(activeGroup.name) || activeGroup.id;
    const url = `${origin}/${slugOrId}`;
    try {
      await navigator.clipboard.writeText(url);
      setCopiedGroupLink(true);
      setTimeout(() => setCopiedGroupLink(false), 2500);
    } catch {
      // fallback
    }
  };

  // Effective payer defaults to selected identity or first group member
  const effectivePayerId = useMemo(() => {
    if (payerId && members.some((m) => m.id === payerId)) {
      return payerId;
    }
    if (activeMemberId && members.some((m) => m.id === activeMemberId)) {
      return activeMemberId;
    }
    return members[0]?.id || "";
  }, [payerId, activeMemberId, members]);

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
      settlements.filter((s) => s.currency === "$" || s.currency === "USD"),
    [settlements]
  );
  const eurSettlements = useMemo(
    () =>
      settlements.filter((s) => s.currency === "€" || s.currency === "EUR"),
    [settlements]
  );

  // Live split computation
  const parsedAmount = parseFloat(amount);
  const totalCents =
    !isNaN(parsedAmount) && parsedAmount > 0
      ? Math.round(parsedAmount * 100)
      : 0;
  const perPersonAmount =
    totalCents > 0 && selectedMembers.length > 0
      ? (totalCents / 100 / selectedMembers.length).toFixed(2)
      : null;

  // Live percentage summary for Add Transaction form
  const percentageSummary = useMemo(() => {
    const inputs = members.map((m) => ({
      memberId: m.id,
      percentage: parseFloat(percentageValues[m.id] || "0") || 0,
    }));
    const totalPct = inputs.reduce((acc, i) => acc + i.percentage, 0);
    const remainingPct = 100 - totalPct;
    const isValid =
      Math.abs(remainingPct) <= 0.01 && inputs.some((i) => i.percentage > 0);
    const splits =
      isValid && totalCents > 0
        ? splitAmountByPercentage(totalCents, inputs)
        : [];
    const splitMap = new Map(
      splits.map((s) => [s.memberId, s.splitAmountCents])
    );
    return {
      inputs,
      totalPct,
      remainingPct,
      isValid,
      splits,
      splitMap,
    };
  }, [members, percentageValues, totalCents]);

  // Live exact split validation for Add Transaction form
  const exactSummary = useMemo(() => {
    const inputs = members.map((m) => {
      const val = parseFloat(exactValues[m.id] || "0");
      return {
        memberId: m.id,
        splitAmountCents: !isNaN(val) && val > 0 ? Math.round(val * 100) : 0,
      };
    });
    return validateExactSplits(totalCents, inputs);
  }, [members, exactValues, totalCents]);

  // Export CSV (<slug>_<YYYY-MM-DD>_export.csv) — Available to all users in group header
  const handleExportCsv = () => {
    if (!activeGroup) return;
    const todayStr = getTodayLocalDate();
    const slugOrName =
      activeGroup.slug ||
      generateGroupSlug(activeGroup.name) ||
      activeGroup.id;
    const filename = `${slugOrName}_${todayStr}_export.csv`;
    const csvContent = generateGroupCsv(members, expenses, todayStr);

    const blob = new Blob([csvContent], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.setAttribute("download", filename);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  };

  // Handle CSV File Upload Selection (Super-Admin only)
  const handleCsvFileChange = async (
    e: React.ChangeEvent<HTMLInputElement>
  ) => {
    setCsvError(null);
    const file = e.target.files?.[0];
    if (!file) {
      setParsedCsv(null);
      setCsvFileName("");
      return;
    }

    setCsvFileName(file.name);
    const derivedName = deriveGroupNameFromCsvFilename(file.name);
    if (!csvGroupName.trim()) {
      setCsvGroupName(derivedName);
    }

    try {
      const text = await file.text();
      const parsed = parseGroupCsv(text);
      if (parsed.memberNames.length === 0) {
        setCsvError(
          "Invalid CSV header: Expected Date,Description,Category,Cost,Currency,<Member 1>,..."
        );
        setParsedCsv(null);
        return;
      }
      setParsedCsv(parsed);
    } catch (err: unknown) {
      setCsvError(
        err instanceof Error ? err.message : "Failed to read CSV file."
      );
      setParsedCsv(null);
    }
  };

  // Execute CSV Import into a New Group or Active Group (Super-Admin only)
  const handleImportCsv = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!isSuperAdmin || !user || !parsedCsv) return;

    setIsImportingCsv(true);
    setCsvError(null);

    try {
      let targetGroup: Group | null = null;

      if (csvTargetMode === "new" || !activeGroup) {
        const trimmedName =
          csvGroupName.trim() ||
          deriveGroupNameFromCsvFilename(csvFileName) ||
          "Imported Group";
        const generatedSlug = generateGroupSlug(trimmedName);

        let { data: newGroupRow, error: groupError } = await supabase
          .from("groups")
          .insert({
            name: trimmedName,
            slug: generatedSlug,
            created_by: user.id,
          })
          .select("*")
          .single();

        if (groupError && groupError.message?.toLowerCase().includes("slug")) {
          const retry = await supabase
            .from("groups")
            .insert({
              name: trimmedName,
              created_by: user.id,
            })
            .select("*")
            .single();
          newGroupRow = retry.data;
          groupError = retry.error;
        }

        if (groupError || !newGroupRow) {
          setCsvError(
            "Error creating group: " + (groupError?.message || "Unknown error")
          );
          setIsImportingCsv(false);
          return;
        }

        targetGroup = normalizeGroup({
          ...newGroupRow,
          slug: newGroupRow.slug || generatedSlug,
        });
      } else {
        targetGroup = activeGroup;
      }

      // 1. Ensure all CSV header member names exist in group_members
      const { data: existingMemberRows } = await supabase
        .from("group_members")
        .select("id, group_id, display_name")
        .eq("group_id", targetGroup.id);

      const memberIdByLowerName = new Map<string, string>();
      for (const m of existingMemberRows || []) {
        if (m.display_name) {
          memberIdByLowerName.set(m.display_name.trim().toLowerCase(), m.id);
        }
      }

      for (const rawName of parsedCsv.memberNames) {
        const cleanName = rawName.trim();
        if (!cleanName) continue;
        const lower = cleanName.toLowerCase();
        if (!memberIdByLowerName.has(lower)) {
          const { data: insertedMem, error: memErr } = await supabase
            .from("group_members")
            .insert({
              group_id: targetGroup.id,
              display_name: cleanName,
            })
            .select("id, display_name")
            .single();

          if (memErr) {
            setCsvError(
              `Error adding member "${cleanName}": ${memErr.message}`
            );
            setIsImportingCsv(false);
            return;
          }
          if (insertedMem) {
            memberIdByLowerName.set(lower, insertedMem.id);
          }
        }
      }

      // 2. Insert each transaction and its exact reconstructed splits
      for (const txn of parsedCsv.transactions) {
        const payerMemberId = memberIdByLowerName.get(
          txn.paidByMemberName.trim().toLowerCase()
        );
        if (!payerMemberId) continue;

        const expensePayload: Record<string, unknown> = {
          group_id: targetGroup.id,
          paid_by_member_id: payerMemberId,
          description: txn.description,
          amount_cents: txn.amountCents,
          currency: txn.currencySymbol,
          type: txn.type,
          date: txn.date || getTodayLocalDate(),
        };

        let { data: newExp, error: expError } = await supabase
          .from("expenses")
          .insert(expensePayload)
          .select("id")
          .single();

        for (let attempt = 0; attempt < 4 && expError; attempt++) {
          const msg = expError.message?.toLowerCase() || "";
          let updated = false;
          if (
            (msg.includes("expenses_currency_check") ||
              msg.includes("currency")) &&
            expensePayload.currency !== txn.currency
          ) {
            expensePayload.currency = txn.currency;
            updated = true;
          }
          if (msg.includes('"amount"') && !("amount" in expensePayload)) {
            expensePayload.amount = Number((txn.amountCents / 100).toFixed(2));
            updated = true;
          }
          if (
            msg.includes('"created_by"') &&
            !("created_by" in expensePayload)
          ) {
            expensePayload.created_by = user.id;
            updated = true;
          }
          if (msg.includes('"payer_id"') && !("payer_id" in expensePayload)) {
            expensePayload.payer_id = user.id || payerMemberId;
            updated = true;
          }
          if (!updated) break;
          const retry = await supabase
            .from("expenses")
            .insert(expensePayload)
            .select("id")
            .single();
          newExp = retry.data;
          expError = retry.error;
        }

        if (expError || !newExp) {
          setCsvError(
            `Error importing transaction "${txn.description}": ${expError?.message || "Unknown error"}`
          );
          setIsImportingCsv(false);
          return;
        }

        let splitsPayload: Array<Record<string, unknown>> = txn.splits
          .map((s) => {
            const mId = memberIdByLowerName.get(
              s.memberName.trim().toLowerCase()
            );
            if (!mId) return null;
            return {
              expense_id: newExp.id,
              member_id: mId,
              split_amount_cents: s.splitAmountCents,
            };
          })
          .filter((s): s is NonNullable<typeof s> => s !== null);

        if (splitsPayload.length > 0) {
          let { error: splitsError } = await supabase
            .from("expense_splits")
            .insert(splitsPayload);

          for (
            let attempt = 0;
            attempt < 2 && splitsError && splitsPayload.length > 0;
            attempt++
          ) {
            const msg = splitsError.message?.toLowerCase() || "";
            let updated = false;
            if (msg.includes('"amount"') && !("amount" in splitsPayload[0])) {
              splitsPayload = splitsPayload.map((s) => ({
                ...s,
                amount: Number(
                  ((s.split_amount_cents as number) / 100).toFixed(2)
                ),
              }));
              updated = true;
            }
            if (msg.includes('"user_id"') && !("user_id" in splitsPayload[0])) {
              splitsPayload = splitsPayload.map((s) => ({
                ...s,
                user_id: user.id || s.member_id,
              }));
              updated = true;
            }
            if (!updated) break;
            const retrySplits = await supabase
              .from("expense_splits")
              .insert(splitsPayload);
            splitsError = retrySplits.error;
          }

          if (splitsError) {
            setCsvError(
              `Error importing splits for "${txn.description}": ${splitsError.message}`
            );
            setIsImportingCsv(false);
            return;
          }
        }
      }

      // Refresh state & select targetGroup
      setGroups((prev) =>
        prev.some((g) => g.id === targetGroup!.id)
          ? prev
          : [targetGroup!, ...prev]
      );
      handleSelectGroup(targetGroup);
      await refreshMembers(targetGroup.id);
      await refreshExpenses(targetGroup.id);

      setNotification({
        type: "success",
        message: `Imported ${parsedCsv.transactions.length} transactions and ${parsedCsv.memberNames.length} members into "${targetGroup.name}".`,
      });
      setIsCsvModalOpen(false);
      setParsedCsv(null);
      setCsvFileName("");
      setCsvGroupName("");
    } catch (err: unknown) {
      setCsvError(
        err instanceof Error ? err.message : "Failed to import CSV."
      );
    } finally {
      setIsImportingCsv(false);
    }
  };

  // Create new group (Strictly Super-Admin only, generates friendly slug from name)
  const handleCreateGroup = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!isSuperAdmin || !newGroupName.trim() || !user) return;

    const trimmedName = newGroupName.trim();
    const generatedSlug = generateGroupSlug(trimmedName);

    // 1. Try inserting with slug column included
    let { data: newGroupRow, error: groupError } = await supabase
      .from("groups")
      .insert({
        name: trimmedName,
        slug: generatedSlug,
        created_by: user.id,
      })
      .select("*")
      .single();

    // Fallback if slug column has not yet been added in Supabase SQL
    if (groupError && groupError.message?.toLowerCase().includes("slug")) {
      const retry = await supabase
        .from("groups")
        .insert({
          name: trimmedName,
          created_by: user.id,
        })
        .select("*")
        .single();
      newGroupRow = retry.data;
      groupError = retry.error;
    }

    if (groupError || !newGroupRow) {
      alert(
        "Error creating group: " + (groupError?.message || "Unknown error")
      );
      return;
    }

    const normalizedNewGroup = normalizeGroup({
      ...newGroupRow,
      slug: newGroupRow.slug || generatedSlug,
    });

    if (addAdminAsMember) {
      await supabase.from("group_members").insert({
        group_id: normalizedNewGroup.id,
        display_name: "Murph",
      });
    }

    setNewGroupName("");
    setAddAdminAsMember(true);
    setGroups((prev) => [normalizedNewGroup, ...prev]);
    handleSelectGroup(normalizedNewGroup);
    setIsInviteModalOpen(true);
  };

  // Delete group (Strictly Super-Admin only)
  const handleDeleteGroup = async (groupId: string, groupName: string) => {
    if (!isSuperAdmin) return;
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

    removeRecentGroupId(groupId);
    const remaining = groups.filter((g) => g.id !== groupId);
    setGroups(remaining);
    if (activeGroupId === groupId) {
      const nextGroup = remaining[0] || null;
      setActiveGroupId(nextGroup ? nextGroup.id : "");
      if (typeof window !== "undefined") {
        const nextPath = nextGroup
          ? `/${nextGroup.slug || generateGroupSlug(nextGroup.name) || nextGroup.id}`
          : "/";
        window.history.pushState(null, "", nextPath);
      }
    }
  };

  // Add transaction with penny-split precision (Supports Equal, % Percentage, and $ Exact splits)
  const handleAddExpense = async (e: React.FormEvent) => {
    e.preventDefault();
    const finalPayerId = payerId || effectivePayerId;
    if (!activeGroupId || totalCents <= 0 || !finalPayerId) {
      return;
    }

    let calculatedSplits: Array<{
      memberId: string;
      splitAmountCents: number;
    }> = [];

    if (type === "payment") {
      if (selectedMembers.length === 0) return;
      calculatedSplits = [
        {
          memberId: selectedMembers[0],
          splitAmountCents: totalCents,
        },
      ];
    } else if (splitMode === "equal") {
      if (selectedMembers.length === 0) return;
      calculatedSplits = splitAmountEqually(totalCents, selectedMembers);
    } else if (splitMode === "percentage") {
      if (!percentageSummary.isValid || percentageSummary.splits.length === 0) {
        alert(
          `Percentages must total 100% (currently ${percentageSummary.totalPct.toFixed(2)}%).`
        );
        return;
      }
      calculatedSplits = percentageSummary.splits;
    } else {
      if (!exactSummary.valid) {
        alert(
          exactSummary.error ||
            "Exact split amounts must equal the transaction total."
        );
        return;
      }
      calculatedSplits = exactSummary.splits;
    }

    const expensePayload: Record<string, unknown> = {
      group_id: activeGroupId,
      paid_by_member_id: finalPayerId,
      description:
        description.trim() ||
        (type === "payment" ? "Direct Payment" : "Group Expense"),
      amount_cents: totalCents,
      currency,
      type,
      date: transactionDate || getTodayLocalDate(),
    };

    // 1. Insert into expenses (auto-adapts if legacy NOT NULL or currency check constraints exist in DB)
    let { data: newExp, error: expError } = await supabase
      .from("expenses")
      .insert(expensePayload)
      .select("id")
      .single();

    for (let attempt = 0; attempt < 4 && expError; attempt++) {
      const msg = expError.message?.toLowerCase() || "";
      let updated = false;
      const isoCurrency = currency === "€" ? "EUR" : "USD";
      if (
        (msg.includes("expenses_currency_check") || msg.includes("currency")) &&
        expensePayload.currency !== isoCurrency
      ) {
        expensePayload.currency = isoCurrency;
        updated = true;
      }
      if (msg.includes('"amount"') && !("amount" in expensePayload)) {
        expensePayload.amount = Number((totalCents / 100).toFixed(2));
        updated = true;
      }
      if (msg.includes('"created_by"') && !("created_by" in expensePayload)) {
        const fallbackUser = user?.id || activeGroup?.created_by;
        if (fallbackUser) {
          expensePayload.created_by = fallbackUser;
          updated = true;
        }
      }
      if (msg.includes('"payer_id"') && !("payer_id" in expensePayload)) {
        expensePayload.payer_id =
          user?.id || activeGroup?.created_by || finalPayerId;
        updated = true;
      }
      if (!updated) break;
      const retry = await supabase
        .from("expenses")
        .insert(expensePayload)
        .select("id")
        .single();
      newExp = retry.data;
      expError = retry.error;
    }

    if (expError || !newExp) {
      alert(
        "Error adding transaction: " + (expError?.message || "Unknown error")
      );
      return;
    }

    // 2. Insert calculated splits
    let splitsPayload: Array<Record<string, unknown>> = calculatedSplits.map(
      (s) => ({
        expense_id: newExp.id,
        member_id: s.memberId,
        split_amount_cents: s.splitAmountCents,
      })
    );

    let { error: splitsError } = await supabase
      .from("expense_splits")
      .insert(splitsPayload);

    for (
      let attempt = 0;
      attempt < 2 && splitsError && splitsPayload.length > 0;
      attempt++
    ) {
      const msg = splitsError.message?.toLowerCase() || "";
      let updated = false;
      if (msg.includes('"amount"') && !("amount" in splitsPayload[0])) {
        splitsPayload = splitsPayload.map((s) => ({
          ...s,
          amount: Number(((s.split_amount_cents as number) / 100).toFixed(2)),
        }));
        updated = true;
      }
      if (msg.includes('"user_id"') && !("user_id" in splitsPayload[0])) {
        const fallbackUser = user?.id || activeGroup?.created_by;
        splitsPayload = splitsPayload.map((s) => ({
          ...s,
          user_id: fallbackUser || s.member_id,
        }));
        updated = true;
      }
      if (!updated) break;
      const retrySplits = await supabase
        .from("expense_splits")
        .insert(splitsPayload);
      splitsError = retrySplits.error;
    }

    if (splitsError) {
      alert("Error adding splits: " + splitsError.message);
      return;
    }

    // Refresh UI
    setDescription("");
    setAmount("");
    setPercentageValues({});
    setExactValues({});
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
      options: { redirectTo: window.location.href },
    });
  };

  const activeMemberObj = members.find((m) => m.id === activeMemberId);

  return (
    <div className="min-h-screen bg-slate-50">
      <header className="bg-white border-b border-slate-200 px-6 py-4 flex items-center justify-between">
        <div className="flex items-center gap-2.5">
          <div className="w-8 h-8 rounded-lg bg-blue-600 text-white font-black flex items-center justify-center text-base shadow-2xs">
            $
          </div>
          <div>
            <h1 className="text-lg font-bold text-slate-900 tracking-tight leading-none">
              Settle Up
            </h1>
            <p className="text-[11px] text-slate-400 mt-0.5">
              Instant group expense & settlement tracker
            </p>
          </div>
        </div>

        <div className="flex items-center gap-3">
          {user ? (
            <>
              <div className="flex items-center gap-2">
                {isSuperAdmin && (
                  <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-bold bg-indigo-50 text-indigo-700 border border-indigo-200">
                    <Shield className="w-3 h-3" />
                    Super-Admin
                  </span>
                )}
                <span className="text-xs sm:text-sm text-slate-600 font-medium">
                  {user.email}
                </span>
              </div>
              <button
                type="button"
                onClick={() => supabase.auth.signOut()}
                className="inline-flex items-center gap-1 text-xs text-slate-500 hover:text-red-600 font-medium transition cursor-pointer"
              >
                <LogOut className="w-3.5 h-3.5" />
                Sign out
              </button>
            </>
          ) : (
            <button
              type="button"
              onClick={signInWithGoogle}
              className="inline-flex items-center gap-1.5 text-xs text-slate-600 hover:text-slate-900 bg-slate-100 hover:bg-slate-200 px-3 py-1.5 rounded-lg font-medium transition cursor-pointer"
            >
              <LogIn className="w-3.5 h-3.5" />
              Admin Sign In
            </button>
          )}
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
              type="button"
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
              <span>{isSuperAdmin ? "All Groups" : "Your Groups"}</span>
              <span className="text-xs text-slate-400 font-normal">
                {groups.length}
              </span>
            </h2>
            <div className="space-y-1">
              {groups.length === 0 ? (
                <p className="text-xs text-slate-400 italic py-2">
                  {isSuperAdmin
                    ? "No groups yet. Create one below!"
                    : "Open a shared group link (e.g. /SoCal_2026) to access your group."}
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
                      onClick={() => handleSelectGroup(g)}
                      className="flex-1 text-left truncate mr-2 cursor-pointer"
                    >
                      {g.name}
                    </button>
                    {isSuperAdmin && (
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

          {/* Create Group Form & CSV Import: Strictly visible ONLY to Super-Admin (murph@murphnduff.org) */}
          {isSuperAdmin && (
            <div className="pt-4 border-t border-slate-100 space-y-2.5">
              <form onSubmit={handleCreateGroup} className="flex flex-col gap-2">
                <label className="text-xs font-semibold text-slate-600">
                  Create New Group
                </label>
                <input
                  type="text"
                  placeholder="Group Name (e.g. SoCal 2026)"
                  value={newGroupName}
                  onChange={(e) => setNewGroupName(e.target.value)}
                  className="w-full border border-slate-300 rounded-lg p-2 text-sm text-slate-900 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent transition"
                  required
                />
                {newGroupName.trim() && (
                  <span className="text-[11px] text-slate-400 font-mono truncate">
                    URL: /{generateGroupSlug(newGroupName)}
                  </span>
                )}
                <label className="inline-flex items-center gap-2 text-xs text-slate-600 cursor-pointer select-none py-0.5">
                  <input
                    type="checkbox"
                    checked={addAdminAsMember}
                    onChange={(e) => setAddAdminAsMember(e.target.checked)}
                    className="rounded border-slate-300 text-blue-600 focus:ring-blue-500 cursor-pointer"
                  />
                  <span>Add me as a member</span>
                </label>
                <button
                  type="submit"
                  className="w-full bg-blue-600 text-white py-2 rounded-lg text-xs font-semibold hover:bg-blue-700 transition flex items-center justify-center gap-1.5 cursor-pointer shadow-xs"
                >
                  <Plus className="w-3.5 h-3.5" />
                  Create Group
                </button>
              </form>

              <button
                type="button"
                onClick={() => {
                  setCsvTargetMode("new");
                  setCsvError(null);
                  setIsCsvModalOpen(true);
                }}
                className="w-full bg-slate-100 hover:bg-slate-200 text-slate-700 border border-slate-200 py-2 rounded-lg text-xs font-semibold transition flex items-center justify-center gap-1.5 cursor-pointer"
              >
                <Upload className="w-3.5 h-3.5" />
                Import CSV
              </button>
            </div>
          )}
        </aside>

        {/* Expense Entry & Settlement Panel */}
        <section className="md:col-span-2 space-y-6">
          {activeGroup ? (
            <div className="bg-white border border-slate-200 p-5 rounded-2xl shadow-xs space-y-4">
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                <div>
                  <div className="flex items-center gap-2.5 flex-wrap">
                    <h2 className="text-xl font-bold text-slate-900 tracking-tight">
                      {activeGroup.name}
                    </h2>
                    <span className="px-2.5 py-0.5 rounded-full text-xs font-semibold bg-slate-100 text-slate-700">
                      {members.length}{" "}
                      {members.length === 1 ? "member" : "members"}
                    </span>
                  </div>
                </div>

                {/* Action Buttons: Copy Group Link, Export CSV (All Users), Import CSV + Manage Members (Super-Admin) */}
                <div className="flex items-center gap-2 shrink-0 flex-wrap">
                  <button
                    type="button"
                    onClick={handleCopyGroupLink}
                    className={`inline-flex items-center justify-center gap-1.5 px-3.5 py-2 text-xs font-semibold rounded-xl transition shadow-2xs cursor-pointer ${
                      copiedGroupLink
                        ? "bg-emerald-600 text-white"
                        : "bg-slate-100 hover:bg-slate-200 text-slate-700 border border-slate-200"
                    }`}
                  >
                    {copiedGroupLink ? (
                      <>
                        <Check className="w-3.5 h-3.5" />
                        Copied Group Link!
                      </>
                    ) : (
                      <>
                        <Share2 className="w-3.5 h-3.5" />
                        Copy Group Link
                      </>
                    )}
                  </button>

                  <button
                    type="button"
                    onClick={handleExportCsv}
                    className="inline-flex items-center justify-center gap-1.5 px-3.5 py-2 text-xs font-semibold rounded-xl transition shadow-2xs bg-slate-100 hover:bg-slate-200 text-slate-700 border border-slate-200 cursor-pointer"
                  >
                    <Download className="w-3.5 h-3.5" />
                    Export CSV
                  </button>

                  {isSuperAdmin && (
                    <>
                      <button
                        type="button"
                        onClick={() => {
                          setCsvTargetMode("active");
                          setCsvError(null);
                          setIsCsvModalOpen(true);
                        }}
                        className="inline-flex items-center justify-center gap-1.5 px-3.5 py-2 text-xs font-semibold rounded-xl transition shadow-2xs bg-slate-100 hover:bg-slate-200 text-slate-700 border border-slate-200 cursor-pointer"
                      >
                        <Upload className="w-3.5 h-3.5" />
                        Import CSV
                      </button>

                      <button
                        type="button"
                        onClick={() => setIsInviteModalOpen(true)}
                        className="inline-flex items-center justify-center gap-1.5 px-4 py-2 text-xs font-semibold rounded-xl transition shadow-xs bg-blue-600 hover:bg-blue-700 text-white cursor-pointer"
                      >
                        <UserPlus className="w-4 h-4" />
                        Manage Members
                      </button>
                    </>
                  )}
                </div>
              </div>

              {/* Zero-Login Identity Pill Selector (Non-nagging for non-participant Super-Admin) */}
              {members.length > 0 ? (
                <div className="p-3 bg-slate-50 border border-slate-200/80 rounded-xl space-y-2">
                  <div className="flex items-center justify-between gap-2 flex-wrap">
                    <span className="text-xs font-semibold text-slate-700 flex items-center gap-1.5">
                      {isSuperAdmin && !activeMemberObj ? (
                        <Shield className="w-3.5 h-3.5 text-indigo-600" />
                      ) : (
                        <UserCheck className="w-3.5 h-3.5 text-blue-600" />
                      )}
                      {activeMemberObj
                        ? `Viewing as ${activeMemberObj.name} (tap another name to switch):`
                        : isSuperAdmin
                          ? "Admin View (non-participant) — optionally tap a member to act as them:"
                          : "Who are you in this group? Tap your name:"}
                    </span>
                    {isSuperAdmin && activeMemberObj && (
                      <button
                        type="button"
                        onClick={() => {
                          setActiveMemberId("");
                          if (activeGroupId && typeof window !== "undefined") {
                            localStorage.removeItem(
                              memberStorageKey(activeGroupId)
                            );
                            const slugOrId =
                              activeGroup.slug ||
                              generateGroupSlug(activeGroup.name) ||
                              activeGroup.id;
                            window.history.replaceState(
                              null,
                              "",
                              `/${slugOrId}`
                            );
                          }
                        }}
                        className="text-[11px] font-semibold text-indigo-600 hover:text-indigo-800 cursor-pointer"
                      >
                        Reset to Admin View
                      </button>
                    )}
                  </div>
                  <div className="flex items-center gap-1.5 flex-wrap">
                    {members.map((m) => {
                      const isMe = m.id === activeMemberId;
                      return (
                        <button
                          key={m.id}
                          type="button"
                          onClick={() => handleSelectIdentity(m)}
                          className={`inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-semibold transition cursor-pointer border ${
                            isMe
                              ? "bg-blue-600 text-white border-blue-600 shadow-2xs"
                              : "bg-white text-slate-700 border-slate-200 hover:bg-blue-50 hover:border-blue-200"
                          }`}
                        >
                          <span>{m.name}</span>
                          {isMe && (
                            <span className="text-[10px] opacity-90">
                              (You)
                            </span>
                          )}
                        </button>
                      );
                    })}
                  </div>
                </div>
              ) : (
                <div className="p-3 bg-amber-50 border border-amber-200 rounded-xl text-xs text-amber-800 flex items-center justify-between">
                  <span>No members have been added to this group yet.</span>
                  {isSuperAdmin && (
                    <button
                      type="button"
                      onClick={() => setIsInviteModalOpen(true)}
                      className="font-bold underline cursor-pointer ml-2"
                    >
                      Add Members
                    </button>
                  )}
                </div>
              )}

              {/* Multi-Currency Ledger Summary Metrics */}
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 pt-2 border-t border-slate-100 text-xs">
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
            <div className="bg-white border border-slate-200 p-8 rounded-2xl text-center space-y-3">
              <div className="mx-auto w-11 h-11 rounded-xl bg-blue-50 text-blue-600 flex items-center justify-center">
                <Users className="w-5 h-5" />
              </div>
              <div className="space-y-1">
                <h2 className="text-base font-bold text-slate-900">
                  {isSuperAdmin
                    ? "Select or create a group"
                    : "No active group selected"}
                </h2>
                <p className="text-xs text-slate-500 max-w-md mx-auto">
                  {isSuperAdmin
                    ? "Choose a group from the left sidebar or create a new group to start adding members and transactions."
                    : "Open your shared group link (e.g. split.murphnduff.org/SoCal_2026) to immediately view and add expenses without needing to log in."}
                </p>
              </div>
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
                        if (
                          members.length > 0 &&
                          selectedMembers.length !== 1
                        ) {
                          const defaultRecipient =
                            members.find((m) => m.id !== effectivePayerId) ||
                            members[0];
                          setSelectedMembers([defaultRecipient.id]);
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
                          {m.name} {m.id === activeMemberId ? "(You)" : ""}
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

                <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                  <div className="sm:col-span-2">
                    <label className="text-xs font-semibold text-slate-600 block mb-1">
                      Description
                    </label>
                    <input
                      type="text"
                      placeholder="e.g. Dinner, Fuel, Groceries, Green Fees"
                      value={description}
                      onChange={(e) => setDescription(e.target.value)}
                      className="w-full border border-slate-300 rounded-lg p-2 text-sm text-slate-900 placeholder:text-slate-400 bg-white focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent transition"
                      required
                    />
                  </div>
                  <div>
                    <label className="text-xs font-semibold text-slate-600 block mb-1">
                      Date
                    </label>
                    <input
                      type="date"
                      value={transactionDate}
                      onChange={(e) => setTransactionDate(e.target.value)}
                      className="w-full border border-slate-300 rounded-lg p-2 text-sm text-slate-900 bg-white focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent transition"
                      required
                    />
                  </div>
                </div>

                {/* Split Mode (Equal | % Percentage | $ Exact) & Participants */}
                <div className="space-y-3">
                  <div className="flex items-center justify-between flex-wrap gap-2">
                    <label className="text-xs font-semibold text-slate-600">
                      {type === "expense"
                        ? splitMode === "equal"
                          ? `Split Among (${selectedMembers.length} selected)`
                          : splitMode === "percentage"
                            ? "Split by Percentage (%)"
                            : `Split by Exact Amount (${currency})`
                        : "Paid To (Recipient)"}
                    </label>

                    {type === "expense" && (
                      <div className="flex bg-slate-100 p-0.5 rounded-lg border border-slate-200 text-xs">
                        <button
                          type="button"
                          onClick={() => setSplitMode("equal")}
                          className={`px-2.5 py-1 rounded-md font-semibold transition cursor-pointer ${
                            splitMode === "equal"
                              ? "bg-white text-blue-700 shadow-2xs"
                              : "text-slate-500 hover:text-slate-800"
                          }`}
                        >
                          Equal
                        </button>
                        <button
                          type="button"
                          onClick={() => setSplitMode("percentage")}
                          className={`px-2.5 py-1 rounded-md font-semibold transition cursor-pointer ${
                            splitMode === "percentage"
                              ? "bg-white text-blue-700 shadow-2xs"
                              : "text-slate-500 hover:text-slate-800"
                          }`}
                        >
                          % Percentage
                        </button>
                        <button
                          type="button"
                          onClick={() => setSplitMode("exact")}
                          className={`px-2.5 py-1 rounded-md font-semibold transition cursor-pointer ${
                            splitMode === "exact"
                              ? "bg-white text-blue-700 shadow-2xs"
                              : "text-slate-500 hover:text-slate-800"
                          }`}
                        >
                          $ Exact
                        </button>
                      </div>
                    )}
                  </div>

                  {type === "payment" || splitMode === "equal" ? (
                    <>
                      {type === "expense" && members.length > 0 && (
                        <div className="flex items-center justify-end gap-2 text-xs">
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
                              {isSelected && (
                                <span className="text-[10px]">✓</span>
                              )}
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
                              {selectedMembers.length === 1
                                ? "person"
                                : "people"}
                              :
                            </span>
                          </span>
                          <span className="font-bold text-blue-900 text-sm">
                            {currency}
                            {perPersonAmount} each
                          </span>
                        </div>
                      )}
                    </>
                  ) : splitMode === "percentage" ? (
                    <div className="space-y-2">
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                        {members.map((m) => {
                          const allocCents =
                            percentageSummary.splitMap.get(m.id) || 0;
                          return (
                            <div
                              key={m.id}
                              className="flex items-center justify-between gap-2 p-2.5 rounded-xl border border-slate-200 bg-slate-50/60"
                            >
                              <div className="min-w-0 flex-1">
                                <span className="text-xs font-semibold text-slate-800 block truncate">
                                  {m.name}
                                </span>
                                {totalCents > 0 && allocCents > 0 && (
                                  <span className="text-[11px] text-slate-500">
                                    {currency}
                                    {(allocCents / 100).toFixed(2)}
                                  </span>
                                )}
                              </div>
                              <div className="relative w-24 shrink-0">
                                <input
                                  type="number"
                                  step="0.01"
                                  min="0"
                                  max="100"
                                  placeholder="0"
                                  value={percentageValues[m.id] ?? ""}
                                  onChange={(e) =>
                                    setPercentageValues((prev) => ({
                                      ...prev,
                                      [m.id]: e.target.value,
                                    }))
                                  }
                                  className="w-full pr-6 pl-2 py-1 border border-slate-300 rounded-lg text-xs text-right text-slate-900 bg-white focus:outline-none focus:ring-2 focus:ring-blue-500"
                                />
                                <span className="absolute right-2 top-1.5 text-xs text-slate-400 font-semibold">
                                  %
                                </span>
                              </div>
                            </div>
                          );
                        })}
                      </div>

                      <div
                        className={`p-2.5 rounded-xl text-xs flex items-center justify-between border ${
                          percentageSummary.isValid
                            ? "bg-emerald-50 border-emerald-200 text-emerald-800"
                            : "bg-amber-50 border-amber-200 text-amber-800"
                        }`}
                      >
                        <span className="flex items-center gap-1.5 font-medium">
                          {percentageSummary.isValid ? (
                            <CheckCircle2 className="w-3.5 h-3.5 text-emerald-600 shrink-0" />
                          ) : (
                            <AlertCircle className="w-3.5 h-3.5 text-amber-600 shrink-0" />
                          )}
                          <span>
                            Total: {percentageSummary.totalPct.toFixed(2)}% /
                            100%
                          </span>
                        </span>
                        <span className="font-bold">
                          {percentageSummary.isValid
                            ? "100% Allocated"
                            : `${percentageSummary.remainingPct > 0 ? percentageSummary.remainingPct.toFixed(2) + "% remaining" : Math.abs(percentageSummary.remainingPct).toFixed(2) + "% over"}`}
                        </span>
                      </div>
                    </div>
                  ) : (
                    <div className="space-y-2">
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                        {members.map((m) => (
                          <div
                            key={m.id}
                            className="flex items-center justify-between gap-2 p-2.5 rounded-xl border border-slate-200 bg-slate-50/60"
                          >
                            <span className="text-xs font-semibold text-slate-800 truncate flex-1">
                              {m.name}
                            </span>
                            <div className="relative w-28 shrink-0">
                              <span className="absolute left-2.5 top-1.5 text-xs text-slate-400 font-semibold">
                                {currency}
                              </span>
                              <input
                                type="number"
                                step="0.01"
                                min="0"
                                placeholder="0.00"
                                value={exactValues[m.id] ?? ""}
                                onChange={(e) =>
                                  setExactValues((prev) => ({
                                    ...prev,
                                    [m.id]: e.target.value,
                                  }))
                                }
                                className="w-full pl-6 pr-2 py-1 border border-slate-300 rounded-lg text-xs text-right text-slate-900 bg-white focus:outline-none focus:ring-2 focus:ring-blue-500"
                              />
                            </div>
                          </div>
                        ))}
                      </div>

                      <div
                        className={`p-2.5 rounded-xl text-xs flex items-center justify-between border ${
                          exactSummary.valid
                            ? "bg-emerald-50 border-emerald-200 text-emerald-800"
                            : "bg-amber-50 border-amber-200 text-amber-800"
                        }`}
                      >
                        <span className="flex items-center gap-1.5 font-medium">
                          {exactSummary.valid ? (
                            <CheckCircle2 className="w-3.5 h-3.5 text-emerald-600 shrink-0" />
                          ) : (
                            <AlertCircle className="w-3.5 h-3.5 text-amber-600 shrink-0" />
                          )}
                          <span>
                            Allocated: {currency}
                            {(exactSummary.totalSplitCents / 100).toFixed(2)} of{" "}
                            {currency}
                            {(totalCents / 100).toFixed(2)}
                          </span>
                        </span>
                        <span className="font-bold">
                          {exactSummary.valid
                            ? "Exact Match"
                            : exactSummary.remainingCents > 0
                              ? `${currency}${(exactSummary.remainingCents / 100).toFixed(2)} remaining`
                              : `${currency}${(Math.abs(exactSummary.remainingCents) / 100).toFixed(2)} over`}
                        </span>
                      </div>
                    </div>
                  )}
                </div>

                <button
                  type="submit"
                  disabled={members.length === 0}
                  className="w-full bg-slate-900 text-white py-2.5 rounded-xl text-sm font-semibold hover:bg-slate-800 transition cursor-pointer shadow-xs disabled:opacity-50 disabled:cursor-not-allowed"
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
                      records • Anyone with the group link can edit or delete
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
                        (m) =>
                          m.id === exp.paidByMemberId || m.id === exp.payerId
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
                                • {formatTransactionDate(exp.date)}
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
                                  isPayment ? "text-blue-700" : "text-rose-600"
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
              Greedy cash-flow minimization pairing largest debtors with largest
              creditors across isolated currency ledgers.
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
                    <span className="font-bold text-slate-900">
                      {s.fromUser}
                    </span>{" "}
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
                    <span className="font-bold text-slate-900">
                      {s.fromUser}
                    </span>{" "}
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

      {/* Member Management Modal (Super-Admin) */}
      <MemberInviteModal
        isOpen={isInviteModalOpen}
        onClose={() => setIsInviteModalOpen(false)}
        group={activeGroup}
        currentMembers={members}
        isSuperAdmin={isSuperAdmin}
        activeMemberId={activeMemberId}
        expenses={expenses}
        onMemberAdded={async (newMember) => {
          if (newMember) {
            setMembers((prev) =>
              prev.some((m) => m.id === newMember.id)
                ? prev
                : [...prev, newMember]
            );
            setSelectedMembers((prev) =>
              prev.includes(newMember.id) ? prev : [...prev, newMember.id]
            );
            setPayerId((prev) => prev || newMember.id);
          }
          if (activeGroupId) {
            await refreshMembers(activeGroupId);
          }
        }}
      />

      {/* Unified CSV Import Modal (Super-Admin Only) */}
      {isSuperAdmin && isCsvModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/60 backdrop-blur-xs">
          <div className="bg-white border border-slate-200 rounded-2xl shadow-2xl max-w-lg w-full p-6 space-y-4">
            <div className="flex items-start justify-between">
              <div className="flex items-center gap-3">
                <div className="p-2.5 bg-blue-50 text-blue-600 rounded-xl">
                  <Upload className="w-5 h-5" />
                </div>
                <div>
                  <h2 className="text-lg font-bold text-slate-900">
                    Import Group CSV
                  </h2>
                  <p className="text-xs text-slate-500">
                    Upload a standard Settle Up CSV file (e.g.
                    orphans_2026-10-18_export.csv)
                  </p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => setIsCsvModalOpen(false)}
                className="text-slate-400 hover:text-slate-600 p-1.5 rounded-lg hover:bg-slate-100 transition cursor-pointer"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            {csvError && (
              <div className="p-3 bg-red-50 border border-red-200 rounded-xl text-xs text-red-800 flex items-start gap-2">
                <AlertCircle className="w-4 h-4 text-red-600 shrink-0 mt-0.5" />
                <span>{csvError}</span>
              </div>
            )}

            <form onSubmit={handleImportCsv} className="space-y-4">
              {activeGroup && (
                <div className="flex bg-slate-100 p-0.5 rounded-lg border border-slate-200 text-xs">
                  <button
                    type="button"
                    onClick={() => setCsvTargetMode("new")}
                    className={`flex-1 py-1.5 rounded-md font-semibold transition cursor-pointer ${
                      csvTargetMode === "new"
                        ? "bg-white text-blue-700 shadow-2xs"
                        : "text-slate-500 hover:text-slate-800"
                    }`}
                  >
                    Create New Group
                  </button>
                  <button
                    type="button"
                    onClick={() => setCsvTargetMode("active")}
                    className={`flex-1 py-1.5 rounded-md font-semibold transition cursor-pointer ${
                      csvTargetMode === "active"
                        ? "bg-white text-blue-700 shadow-2xs"
                        : "text-slate-500 hover:text-slate-800"
                    }`}
                  >
                    Import into &ldquo;{activeGroup.name}&rdquo;
                  </button>
                </div>
              )}

              <div>
                <label className="text-xs font-semibold text-slate-600 block mb-1">
                  Select CSV File (.csv)
                </label>
                <input
                  type="file"
                  accept=".csv,text/csv"
                  onChange={handleCsvFileChange}
                  className="w-full border border-slate-300 rounded-lg p-2 text-xs text-slate-700 bg-white file:mr-3 file:py-1 file:px-3 file:rounded-md file:border-0 file:text-xs file:font-semibold file:bg-blue-50 file:text-blue-700 hover:file:bg-blue-100 cursor-pointer"
                  required
                />
              </div>

              {(csvTargetMode === "new" || !activeGroup) && (
                <div>
                  <label className="text-xs font-semibold text-slate-600 block mb-1">
                    New Group Name
                  </label>
                  <input
                    type="text"
                    placeholder="e.g. orphans"
                    value={csvGroupName}
                    onChange={(e) => setCsvGroupName(e.target.value)}
                    className="w-full border border-slate-300 rounded-lg p-2 text-sm text-slate-900 bg-white focus:outline-none focus:ring-2 focus:ring-blue-500"
                    required
                  />
                </div>
              )}

              {parsedCsv && (
                <div className="p-3 bg-blue-50/70 border border-blue-100 rounded-xl text-xs text-blue-900 space-y-1">
                  <div className="font-bold flex items-center gap-1.5">
                    <CheckCircle2 className="w-4 h-4 text-blue-600" />
                    <span>Ready to Import</span>
                  </div>
                  <p>
                    <strong>{parsedCsv.memberNames.length} Members:</strong>{" "}
                    {parsedCsv.memberNames.join(", ")}
                  </p>
                  <p>
                    <strong>
                      {parsedCsv.transactions.length} Transactions
                    </strong>{" "}
                    detected (summary rows automatically skipped).
                  </p>
                </div>
              )}

              <div className="pt-2 border-t border-slate-100 flex items-center justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setIsCsvModalOpen(false)}
                  className="px-4 py-2 text-xs font-semibold text-slate-600 hover:bg-slate-100 rounded-xl transition cursor-pointer"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={!parsedCsv || isImportingCsv}
                  className="px-4 py-2 text-xs font-semibold bg-blue-600 hover:bg-blue-700 text-white rounded-xl transition cursor-pointer shadow-xs disabled:opacity-50"
                >
                  {isImportingCsv ? "Importing..." : "Import CSV"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

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

export default function App() {
  return (
    <Suspense
      fallback={
        <div className="min-h-screen flex items-center justify-center p-6 bg-slate-50">
          <div className="text-xs text-slate-500 font-medium">
            Loading Settle Up...
          </div>
        </div>
      }
    >
      <SettleUpDashboard />
    </Suspense>
  );
}
