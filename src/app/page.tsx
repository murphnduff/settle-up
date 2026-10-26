"use client";

import {
  useEffect,
  useState,
  useTransition,
  useMemo,
  useCallback,
  useRef,
  Suspense,
} from "react";
import { createClient } from "@/lib/supabase";
import {
  calculateSettlements,
  calculateMemberBreakdown,
  calculateCategorySpend,
  calculateUnifiedReconciliation,
  splitAmountEqually,
  splitAmountByPercentage,
  validateExactSplits,
  parseGroupCsv,
  generateGroupCsv,
  deriveGroupNameFromCsvFilename,
  EXPENSE_CATEGORIES,
  buildGroupCategories,
  ParsedGroupCsvResult,
  SettlementInstruction,
  MemberSummaryRecord,
  CategorySpendRecord,
} from "@/lib/reconciliation";
import {
  SUPPORTED_CURRENCIES,
  normalizeCurrencyCode,
  getCurrencyInfo,
  getCurrencySymbol,
  formatCurrency,
  buildGroupCurrencies,
} from "@/lib/currencies";
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
  compressReceiptFile,
  compressRemoteReceiptForAi,
  uploadReceiptToStorage,
  parseReceiptWithAi,
  isPdfReceiptUrl,
} from "@/lib/receipts";
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
  Archive,
  ArchiveRestore,
  ChevronDown,
  ChevronRight,
  Lock,
  Tag,
  Camera,
  FileText,
  ExternalLink,
  Loader2,
  Globe,
  RefreshCw,
  Settings2,
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
  const defaultCurrency = normalizeCurrencyCode(
    row?.default_currency ||
      (Array.isArray(row?.currencies) ? row.currencies[0] : "USD")
  );
  const currencies = buildGroupCurrencies(
    Array.isArray(row?.currencies) ? row.currencies : [defaultCurrency],
    defaultCurrency
  );
  const exchangeRates: Record<string, number> = {};
  if (
    row?.exchange_rates &&
    typeof row.exchange_rates === "object" &&
    !Array.isArray(row.exchange_rates)
  ) {
    for (const [k, v] of Object.entries(row.exchange_rates)) {
      const num = Number(v);
      if (!isNaN(num) && num > 0) {
        exchangeRates[normalizeCurrencyCode(k)] = num;
      }
    }
  }
  return {
    id: row.id,
    name,
    slug,
    created_by: row.created_by ?? null,
    is_archived: Boolean(row?.is_archived),
    currencies,
    default_currency: defaultCurrency,
    exchange_rates: exchangeRates,
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
    const curr = normalizeCurrencyCode(e.currency);
    const cleanDate =
      typeof e.date === "string" ? e.date.split("T")[0] : getTodayLocalDate();
    const isPayment = e.type === "payment";
    const resolvedCategory = isPayment
      ? "Payment"
      : typeof e.category === "string" && e.category.trim().length > 0
        ? e.category.trim()
        : "General";
    const resolvedReceiptUrl =
      typeof e.receipt_url === "string" && e.receipt_url.trim().length > 0
        ? e.receipt_url.trim()
        : null;
    return {
      id: e.id,
      groupId: e.group_id,
      paidByMemberId: e.paid_by_member_id,
      payerId: e.paid_by_member_id,
      description: e.description,
      amount: amt,
      amountCents: amtCents,
      currency: curr,
      type: (isPayment ? "payment" : "expense") as "expense" | "payment",
      category: resolvedCategory,
      receiptUrl: resolvedReceiptUrl,
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
  const [showNewGroupCurrencies, setShowNewGroupCurrencies] =
    useState<boolean>(false);
  const [newGroupCurrencies, setNewGroupCurrencies] = useState<string[]>([
    "USD",
  ]);
  const [newGroupDefaultCurrency, setNewGroupDefaultCurrency] =
    useState<string>("USD");
  const [expenses, setExpenses] = useState<ExpenseItem[]>([]);
  const [isInviteModalOpen, setIsInviteModalOpen] = useState(false);
  const [isCurrencyModalOpen, setIsCurrencyModalOpen] = useState(false);
  const [editingGroupCurrencies, setEditingGroupCurrencies] = useState<
    string[]
  >(["USD"]);
  const [editingDefaultCurrency, setEditingDefaultCurrency] =
    useState<string>("USD");
  const [customIsoInput, setCustomIsoInput] = useState<string>("");
  const [isSavingCurrencies, setIsSavingCurrencies] = useState<boolean>(false);
  const [editingExpense, setEditingExpense] = useState<ExpenseItem | null>(null);
  const [copiedGroupLink, setCopiedGroupLink] = useState(false);
  const [showArchivedGroups, setShowArchivedGroups] = useState(false);
  const [historyCurrencyFilter, setHistoryCurrencyFilter] =
    useState<string>("all");
  const [notification, setNotification] = useState<{
    type: "success" | "error";
    message: string;
  } | null>(null);

  // Unified Settlement (Cross-Currency Conversion) state
  const [isUnifiedMode, setIsUnifiedMode] = useState<boolean>(false);
  const [unifiedTargetCurrency, setUnifiedTargetCurrency] =
    useState<string>("USD");
  const [exchangeRatesInput, setExchangeRatesInput] = useState<
    Record<string, string>
  >({});
  const [isFetchingRates, setIsFetchingRates] = useState<boolean>(false);
  const [isSavingRates, setIsSavingRates] = useState<boolean>(false);

  // Add Transaction Form state
  const [description, setDescription] = useState("");
  const [amount, setAmount] = useState("");
  const [currency, setCurrency] = useState<string>("USD");
  const [payerId, setPayerId] = useState("");
  const [transactionDate, setTransactionDate] = useState<string>(() =>
    getTodayLocalDate()
  );
  const [type, setType] = useState<"expense" | "payment">("expense");
  const [category, setCategory] = useState<string>("General");
  const [isCustomCategory, setIsCustomCategory] = useState<boolean>(false);
  const [customCategoryInput, setCustomCategoryInput] = useState<string>("");
  const [splitMode, setSplitMode] = useState<SplitMode>("equal");
  const splitModeRef = useRef<SplitMode>("equal");
  useEffect(() => {
    splitModeRef.current = splitMode;
  }, [splitMode]);
  const [selectedMembers, setSelectedMembers] = useState<string[]>([]);
  const [percentageValues, setPercentageValues] = useState<
    Record<string, string>
  >({});
  const [exactValues, setExactValues] = useState<Record<string, string>>({});

  // Add Transaction Receipt & AI Extraction state
  const addTransactionFormRef = useRef<HTMLFormElement>(null);
  const [isFormHighlighted, setIsFormHighlighted] = useState<boolean>(false);
  const addReceiptCameraInputRef = useRef<HTMLInputElement>(null);
  const addReceiptInputRef = useRef<HTMLInputElement>(null);
  const addReceiptPdfInputRef = useRef<HTMLInputElement>(null);
  const receiptLightboxRef = useRef<HTMLDialogElement>(null);
  const [receiptUrl, setReceiptUrl] = useState<string | null>(null);
  const [receiptPreviewUrl, setReceiptPreviewUrl] = useState<string | null>(
    null
  );
  const [receiptFileName, setReceiptFileName] = useState<string>("");
  const [isScanningReceipt, setIsScanningReceipt] = useState<boolean>(false);
  const [isUploadingReceipt, setIsUploadingReceipt] = useState<boolean>(false);
  const [receiptStatusMessage, setReceiptStatusMessage] = useState<
    string | null
  >(null);
  const [receiptScanError, setReceiptScanError] = useState<string | null>(null);
  const [scannedCategories, setScannedCategories] = useState<string[]>([]);
  const [sharedReceiptBannerUrl, setSharedReceiptBannerUrl] = useState<
    string | null
  >(null);
  const processedSharedReceiptRef = useRef<string | null>(null);
  const [viewingReceipt, setViewingReceipt] = useState<{
    url: string;
    title: string;
    date?: string;
    amountFormatted?: string;
  } | null>(null);

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

  // Separate active groups vs. archived groups for sidebar organization
  const activeGroups = useMemo(
    () => groups.filter((g) => !g.is_archived),
    [groups]
  );
  const archivedGroups = useMemo(
    () => groups.filter((g) => g.is_archived),
    [groups]
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

  // Active group currencies & default currency
  const activeGroupCurrencies: string[] = useMemo(() => {
    const expenseCurrencies = expenses.map((e) =>
      normalizeCurrencyCode(e.currency)
    );
    return buildGroupCurrencies(
      activeGroup?.currencies || ["USD"],
      activeGroup?.default_currency || "USD",
      expenseCurrencies
    );
  }, [activeGroup, expenses]);

  const activeDefaultCurrency: string = useMemo(
    () =>
      normalizeCurrencyCode(
        activeGroup?.default_currency || activeGroupCurrencies[0] || "USD"
      ),
    [activeGroup, activeGroupCurrencies]
  );

  // Sync default transaction currency, unified target currency, and saved exchange rates when switching groups
  const [syncedGroupId, setSyncedGroupId] = useState<string>("");
  if (activeGroup && activeGroup.id !== syncedGroupId) {
    setSyncedGroupId(activeGroup.id);
    const defCur = normalizeCurrencyCode(
      activeGroup.default_currency || activeGroup.currencies?.[0] || "USD"
    );
    setCurrency(defCur);
    setUnifiedTargetCurrency(defCur);
    setHistoryCurrencyFilter("all");
    setIsUnifiedMode(false);

    const savedRates = activeGroup.exchange_rates || {};
    const initialInputs: Record<string, string> = { [defCur]: "1" };
    for (const [k, v] of Object.entries(savedRates)) {
      if (typeof v === "number" && v > 0) {
        initialInputs[normalizeCurrencyCode(k)] = String(v);
      }
    }
    setExchangeRatesInput(initialInputs);
  }

  // Helper to automatically append newly discovered currencies (e.g. from AI receipt scan or CSV import) to the group
  const ensureCurrenciesInGroup = useCallback(
    async (newCurrencyCodes: string[], targetGrp?: Group | null) => {
      const grp = targetGrp || activeGroup;
      if (!grp) return;
      const merged = buildGroupCurrencies(
        grp.currencies || ["USD"],
        grp.default_currency || "USD",
        newCurrencyCodes
      );
      const currentList = grp.currencies || ["USD"];
      const hasNew =
        merged.length !== currentList.length ||
        merged.some((c, i) => c !== currentList[i]);
      if (!hasNew) return;

      setGroups((prev) =>
        prev.map((g) => (g.id === grp.id ? { ...g, currencies: merged } : g))
      );

      await supabase
        .from("groups")
        .update({ currencies: merged })
        .eq("id", grp.id);
    },
    [activeGroup, supabase]
  );

  // Currency totals (strictly aggregate rows where type === 'expense', excluding settlement payments)
  const currencyTotalsCents = useMemo(() => {
    const totals: Record<string, number> = {};
    for (const code of activeGroupCurrencies) {
      totals[code] = 0;
    }
    for (const e of expenses) {
      if (e.type !== "expense") continue;
      const code = normalizeCurrencyCode(e.currency);
      const cents =
        typeof e.amountCents === "number"
          ? e.amountCents
          : Math.round(Number(e.amount || 0) * 100);
      totals[code] = (totals[code] || 0) + cents;
    }
    return totals;
  }, [expenses, activeGroupCurrencies]);

  // Currencies that should be displayed in breakdowns/ledgers (enabled on group OR have transactions)
  const displayCurrencies = useMemo(() => {
    if (activeGroupCurrencies.length <= 1) {
      return activeGroupCurrencies;
    }
    const withActivity = activeGroupCurrencies.filter((code) =>
      expenses.some((e) => normalizeCurrencyCode(e.currency) === code)
    );
    return withActivity.length > 0 ? withActivity : activeGroupCurrencies;
  }, [activeGroupCurrencies, expenses]);

  const hasMultipleCurrencies = useMemo(
    () => activeGroupCurrencies.length > 1 || displayCurrencies.length > 1,
    [activeGroupCurrencies, displayCurrencies]
  );

  // Filtered transactions for the ledger
  const filteredExpenses = useMemo(() => {
    if (historyCurrencyFilter === "all") return expenses;
    const filterCode = normalizeCurrencyCode(historyCurrencyFilter);
    return expenses.filter(
      (e) => normalizeCurrencyCode(e.currency) === filterCode
    );
  }, [expenses, historyCurrencyFilter]);

  // Memoized settlement calculations
  const settlements: SettlementInstruction[] = useMemo(() => {
    if (members.length > 0 && expenses.length > 0) {
      return calculateSettlements(members, expenses);
    }
    return [];
  }, [members, expenses]);

  // Isolate settlements by currency code
  const settlementsByCurrency = useMemo(() => {
    const map: Record<string, SettlementInstruction[]> = {};
    for (const code of activeGroupCurrencies) {
      map[code] = [];
    }
    for (const s of settlements) {
      const code = normalizeCurrencyCode(s.currency);
      if (!map[code]) map[code] = [];
      map[code].push(s);
    }
    return map;
  }, [settlements, activeGroupCurrencies]);

  // Cumulative Member Breakdown per currency
  const memberBreakdownByCurrency = useMemo(() => {
    const map: Record<string, MemberSummaryRecord[]> = {};
    for (const code of activeGroupCurrencies) {
      map[code] = calculateMemberBreakdown(members, expenses, code);
    }
    return map;
  }, [members, expenses, activeGroupCurrencies]);

  // Spend by Category Breakdown per currency
  const categorySpendByCurrency = useMemo(() => {
    const map: Record<string, CategorySpendRecord[]> = {};
    for (const code of activeGroupCurrencies) {
      map[code] = calculateCategorySpend(expenses, code);
    }
    return map;
  }, [expenses, activeGroupCurrencies]);

  // Numeric exchange rates map for Unified Reconciliation (1 unifiedTargetCurrency = X otherCurrency)
  const numericExchangeRates = useMemo(() => {
    const target = normalizeCurrencyCode(unifiedTargetCurrency);
    const map: Record<string, number> = { [target]: 1 };
    for (const code of activeGroupCurrencies) {
      if (code === target) {
        map[code] = 1;
        continue;
      }
      const raw = parseFloat(exchangeRatesInput[code] || "");
      if (!isNaN(raw) && raw > 0) {
        map[code] = raw;
      } else if (
        activeGroup?.exchange_rates?.[code] &&
        activeGroup.exchange_rates[code] > 0
      ) {
        map[code] = activeGroup.exchange_rates[code];
      } else {
        map[code] = 1;
      }
    }
    return map;
  }, [
    unifiedTargetCurrency,
    activeGroupCurrencies,
    exchangeRatesInput,
    activeGroup,
  ]);

  // Unified Cross-Currency Reconciliation Result
  const unifiedResult = useMemo(
    () =>
      calculateUnifiedReconciliation(
        members,
        expenses,
        unifiedTargetCurrency,
        numericExchangeRates
      ),
    [members, expenses, unifiedTargetCurrency, numericExchangeRates]
  );

  // Switch target currency in Unified Settlement mode and rebase existing rates so 1 newTarget = X otherCur remains consistent
  const handleSelectUnifiedTargetCurrency = (nextTargetRaw: string) => {
    const nextTarget = normalizeCurrencyCode(nextTargetRaw);
    const prevTarget = normalizeCurrencyCode(unifiedTargetCurrency);
    if (nextTarget === prevTarget) return;

    const pivotRate = numericExchangeRates[nextTarget];
    if (pivotRate && pivotRate > 0) {
      const rebased: Record<string, string> = { [nextTarget]: "1" };
      for (const code of activeGroupCurrencies) {
        if (code === nextTarget) {
          rebased[code] = "1";
        } else {
          const oldRate = numericExchangeRates[code] || 1;
          const newRate = Number((oldRate / pivotRate).toFixed(4));
          rebased[code] = String(newRate);
        }
      }
      setExchangeRatesInput(rebased);
    }
    setUnifiedTargetCurrency(nextTarget);
  };

  // Fetch live exchange rates from open.er-api.com and persist to group
  const handleFetchLiveRates = async () => {
    const baseCode = normalizeCurrencyCode(unifiedTargetCurrency);
    setIsFetchingRates(true);
    try {
      const res = await fetch(
        `https://open.er-api.com/v6/latest/${encodeURIComponent(baseCode)}`
      );
      if (!res.ok) {
        throw new Error(`HTTP ${res.status} fetching exchange rates`);
      }
      const data = await res.json();
      if (!data?.rates || typeof data.rates !== "object") {
        throw new Error("Invalid exchange rate payload");
      }

      const nextInputs: Record<string, string> = {
        ...exchangeRatesInput,
        [baseCode]: "1",
      };
      const numericToSave: Record<string, number> = {
        ...(activeGroup?.exchange_rates || {}),
        [baseCode]: 1,
      };

      for (const code of activeGroupCurrencies) {
        if (code === baseCode) {
          nextInputs[code] = "1";
          numericToSave[code] = 1;
        } else if (
          typeof data.rates[code] === "number" &&
          data.rates[code] > 0
        ) {
          const cleanRate = Number(Number(data.rates[code]).toFixed(4));
          nextInputs[code] = String(cleanRate);
          numericToSave[code] = cleanRate;
        }
      }

      setExchangeRatesInput(nextInputs);

      if (activeGroup) {
        setGroups((prev) =>
          prev.map((g) =>
            g.id === activeGroup.id
              ? { ...g, exchange_rates: numericToSave }
              : g
          )
        );
        await supabase
          .from("groups")
          .update({ exchange_rates: numericToSave })
          .eq("id", activeGroup.id);
      }

      setNotification({
        type: "success",
        message: `Updated live exchange rates for ${baseCode}.`,
      });
    } catch (err: unknown) {
      setNotification({
        type: "error",
        message:
          err instanceof Error
            ? err.message
            : "Could not fetch live exchange rates.",
      });
    } finally {
      setIsFetchingRates(false);
    }
  };

  // Save custom exchange rate overrides to Supabase
  const handleSaveExchangeRates = async () => {
    if (!activeGroup) return;
    setIsSavingRates(true);
    try {
      const baseCode = normalizeCurrencyCode(unifiedTargetCurrency);
      const toSave: Record<string, number> = {
        ...(activeGroup.exchange_rates || {}),
        [baseCode]: 1,
      };
      for (const code of activeGroupCurrencies) {
        if (code === baseCode) {
          toSave[code] = 1;
        } else {
          const parsed = parseFloat(exchangeRatesInput[code] || "");
          if (!isNaN(parsed) && parsed > 0) {
            toSave[code] = parsed;
          }
        }
      }

      const { error } = await supabase
        .from("groups")
        .update({ exchange_rates: toSave })
        .eq("id", activeGroup.id);

      if (error) {
        throw new Error(error.message);
      }

      setGroups((prev) =>
        prev.map((g) =>
          g.id === activeGroup.id ? { ...g, exchange_rates: toSave } : g
        )
      );
      setNotification({
        type: "success",
        message: "Saved group exchange rates.",
      });
    } catch (err: unknown) {
      setNotification({
        type: "error",
        message:
          err instanceof Error
            ? err.message
            : "Failed to save exchange rates.",
      });
    } finally {
      setIsSavingRates(false);
    }
  };

  // Save per-group currencies & default_currency (Super-Admin modal)
  const handleSaveGroupCurrencies = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!isSuperAdmin || !activeGroup) return;
    setIsSavingCurrencies(true);
    try {
      const defCur = normalizeCurrencyCode(editingDefaultCurrency || "USD");
      const finalCurrencies = buildGroupCurrencies(
        editingGroupCurrencies,
        defCur
      );

      const { error } = await supabase
        .from("groups")
        .update({
          currencies: finalCurrencies,
          default_currency: defCur,
        })
        .eq("id", activeGroup.id);

      if (error) {
        throw new Error(error.message);
      }

      setGroups((prev) =>
        prev.map((g) =>
          g.id === activeGroup.id
            ? {
                ...g,
                currencies: finalCurrencies,
                default_currency: defCur,
              }
            : g
        )
      );
      setCurrency(defCur);
      setIsCurrencyModalOpen(false);
      setNotification({
        type: "success",
        message: `Updated currencies for "${activeGroup.name}" (${finalCurrencies.join(", ")} • Default: ${defCur}).`,
      });
    } catch (err: unknown) {
      alert(
        "Error saving group currencies: " +
          (err instanceof Error ? err.message : "Unknown error")
      );
    } finally {
      setIsSavingCurrencies(false);
    }
  };

  // Dynamic per-group category options (merges EXPENSE_CATEGORIES presets with any unique custom categories in the group)
  const groupCategories: string[] = useMemo(
    () => buildGroupCategories(expenses, [category, ...scannedCategories]),
    [expenses, category, scannedCategories]
  );

  // Sync Receipt Lightbox native dialog
  useEffect(() => {
    const dialog = receiptLightboxRef.current;
    if (!dialog) return;
    if (viewingReceipt) {
      if (!dialog.open) {
        dialog.showModal();
      }
    } else if (dialog.open) {
      dialog.close();
    }
  }, [viewingReceipt]);

  const handleReceiptLightboxBackdropClick = (
    e: React.MouseEvent<HTMLDialogElement>
  ) => {
    const dialog = receiptLightboxRef.current;
    if (!dialog || e.target !== dialog) return;
    const rect = dialog.getBoundingClientRect();
    const isInside =
      rect.top <= e.clientY &&
      e.clientY <= rect.top + rect.height &&
      rect.left <= e.clientX &&
      e.clientX <= rect.left + rect.width;
    if (!isInside) {
      setViewingReceipt(null);
    }
  };

  // Scan / Attach Receipt Handler in Add Transaction Form
  // Uses dual-resolution compression (1024px @ 0.70 for AI OCR, 1600px @ 0.82 for Storage)
  // and decouples form auto-fill from the storage upload so fields populate the instant AI OCR finishes.
  const handleAddReceiptFileChange = async (
    e: React.ChangeEvent<HTMLInputElement>
  ) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file || !activeGroupId) return;

    setReceiptFileName(file.name);
    setReceiptScanError(null);
    setIsScanningReceipt(true);
    setIsUploadingReceipt(true);
    setReceiptStatusMessage("Scanning receipt...");

    try {
      const compressed = await compressReceiptFile(file);
      setReceiptPreviewUrl(compressed.previewUrl);

      // 1. Trigger AI OCR immediately using the compact 1024px @ 0.70 payload and populate form the instant it resolves
      const parseTask = parseReceiptWithAi(
        compressed.aiBase64,
        compressed.mimeType
      )
        .then(async (parsed) => {
          if (parsed.description) {
            setDescription(parsed.description);
          }
          if (parsed.currency) {
            const detectedIso = normalizeCurrencyCode(parsed.currency);
            setCurrency(detectedIso);
            await ensureCurrenciesInGroup([detectedIso]);
          }
          if (parsed.date) {
            setTransactionDate(parsed.date);
          }
          if (parsed.category) {
            const cleanScannedCat = parsed.category.trim();
            const existingMatch = groupCategories.find(
              (c) => c.toLowerCase() === cleanScannedCat.toLowerCase()
            );
            const resolvedCat = existingMatch || cleanScannedCat;
            if (!existingMatch && resolvedCat) {
              setScannedCategories((prev) =>
                prev.some((c) => c.toLowerCase() === resolvedCat.toLowerCase())
                  ? prev
                  : [...prev, resolvedCat]
              );
            }
            setIsCustomCategory(false);
            setCustomCategoryInput("");
            setCategory(resolvedCat);
          }
          // Only pre-fill Amount when NOT in '$ Exact' split mode (where Amount is auto-summed from member inputs)
          if (
            typeof parsed.amount === "number" &&
            parsed.amount > 0 &&
            splitModeRef.current !== "exact"
          ) {
            setAmount(parsed.amount.toFixed(2));
          }
          setReceiptStatusMessage(
            "Receipt scanned — fields pre-filled for review!"
          );
        })
        .catch((err: unknown) => {
          const reason =
            err instanceof Error ? err.message : "Unknown OCR error";
          setReceiptScanError(`Could not auto-scan receipt: ${reason}`);
          setReceiptStatusMessage("Receipt attached.");
        })
        .finally(() => {
          setIsScanningReceipt(false);
        });

      // 2. Upload crisp 1600px @ 0.82 receipt to Supabase Storage in parallel without blocking form auto-fill
      const uploadTask = uploadReceiptToStorage(
        supabase,
        activeGroupId,
        compressed.blob,
        compressed.extension,
        compressed.mimeType
      )
        .then((uploadedUrl) => {
          setReceiptUrl(uploadedUrl);
        })
        .catch((err: unknown) => {
          const msg =
            err instanceof Error
              ? err.message
              : "Failed to upload receipt to storage.";
          setNotification({ type: "error", message: msg });
        })
        .finally(() => {
          setIsUploadingReceipt(false);
        });

      await Promise.all([parseTask, uploadTask]);
    } catch (err: unknown) {
      const reason =
        err instanceof Error ? err.message : "Could not process receipt file.";
      setReceiptScanError(`Could not auto-scan receipt: ${reason}`);
      setReceiptStatusMessage(null);
      setIsScanningReceipt(false);
      setIsUploadingReceipt(false);
    }
  };

  // Auto-attach and auto-scan a shared receipt URL (from Web Share Target /share-receipt or ?shared_receipt=<url>)
  const attachAndScanSharedReceipt = useCallback(
    async (sharedUrl: string, targetGrp?: Group | null) => {
      const cleanUrl = sharedUrl.trim();
      if (!cleanUrl) return;

      setType("expense");
      setReceiptUrl(cleanUrl);
      setReceiptPreviewUrl(cleanUrl);
      setReceiptFileName("Shared Receipt");
      setReceiptScanError(null);
      setIsScanningReceipt(true);
      setIsUploadingReceipt(false);
      setReceiptStatusMessage("Scanning shared receipt...");

      setTimeout(() => {
        addTransactionFormRef.current?.scrollIntoView({
          behavior: "smooth",
          block: "center",
        });
      }, 120);

      try {
        const { base64, mimeType } =
          await compressRemoteReceiptForAi(cleanUrl);
        const parsed = await parseReceiptWithAi(base64, mimeType);

        if (parsed.description) {
          setDescription(parsed.description);
        }
        if (parsed.currency) {
          const detectedIso = normalizeCurrencyCode(parsed.currency);
          setCurrency(detectedIso);
          await ensureCurrenciesInGroup([detectedIso], targetGrp);
        }
        if (parsed.date) {
          setTransactionDate(parsed.date);
        }
        if (parsed.category) {
          const cleanScannedCat = parsed.category.trim();
          const existingMatch = groupCategories.find(
            (c) => c.toLowerCase() === cleanScannedCat.toLowerCase()
          );
          const resolvedCat = existingMatch || cleanScannedCat;
          if (!existingMatch && resolvedCat) {
            setScannedCategories((prev) =>
              prev.some((c) => c.toLowerCase() === resolvedCat.toLowerCase())
                ? prev
                : [...prev, resolvedCat]
            );
          }
          setIsCustomCategory(false);
          setCustomCategoryInput("");
          setCategory(resolvedCat);
        }
        if (
          typeof parsed.amount === "number" &&
          parsed.amount > 0 &&
          splitModeRef.current !== "exact"
        ) {
          setAmount(parsed.amount.toFixed(2));
        }
        setReceiptStatusMessage(
          "Shared receipt scanned — fields pre-filled for review!"
        );
      } catch (err: unknown) {
        const reason =
          err instanceof Error ? err.message : "Unknown OCR error";
        setReceiptScanError(`Could not auto-scan shared receipt: ${reason}`);
        setReceiptStatusMessage("Shared receipt attached.");
      } finally {
        setIsScanningReceipt(false);
      }
    },
    [ensureCurrenciesInGroup, groupCategories]
  );

  // Detect ?shared_receipt=<url> or ?share_error=<msg> on page load and auto-attach/scan when activeGroup resolves
  useEffect(() => {
    if (typeof window === "undefined") return;
    let cancelled = false;

    Promise.resolve().then(() => {
      if (cancelled) return;
      const params = new URLSearchParams(window.location.search);
      const shareError = params.get("share_error")?.trim();
      if (shareError) {
        setNotification({
          type: "error",
          message: `Could not share receipt: ${shareError}`,
        });
        params.delete("share_error");
        const nextSearch = params.toString();
        window.history.replaceState(
          null,
          "",
          `${window.location.pathname}${nextSearch ? `?${nextSearch}` : ""}`
        );
      }

      const sharedUrl = params.get("shared_receipt")?.trim();
      if (!sharedUrl) return;

      // Show the group picker banner if the user landed on "/" and has multiple groups
      if (!routeTarget) {
        setSharedReceiptBannerUrl(sharedUrl);
      }

      if (!activeGroup) return;
      const key = `${activeGroup.id}::${sharedUrl}`;
      if (processedSharedReceiptRef.current === key) return;
      processedSharedReceiptRef.current = key;

      // Clean up ?shared_receipt from the address bar via window.history.replaceState
      params.delete("shared_receipt");
      const nextSearch = params.toString();
      window.history.replaceState(
        null,
        "",
        `${window.location.pathname}${nextSearch ? `?${nextSearch}` : ""}`
      );

      attachAndScanSharedReceipt(sharedUrl, activeGroup);
    });

    return () => {
      cancelled = true;
    };
  }, [activeGroup, routeTarget, attachAndScanSharedReceipt]);

  // 1-Click "Settle" button handler in the Settlement Plan
  const handleQuickSettle = (
    instruction: SettlementInstruction,
    targetCurrencyCode: string
  ) => {
    if (activeGroup?.is_archived) return;
    const resolvedCurrency = normalizeCurrencyCode(targetCurrencyCode);

    setType("payment");
    setSplitMode("equal");
    setPayerId(instruction.fromMemberId);
    setSelectedMembers([instruction.toMemberId]);
    setAmount((instruction.amountCents / 100).toFixed(2));
    setCurrency(resolvedCurrency);
    setDescription("Settlement Payment");
    handleRemoveAddReceipt();

    setIsFormHighlighted(true);
    setTimeout(() => {
      setIsFormHighlighted(false);
    }, 2200);

    addTransactionFormRef.current?.scrollIntoView({
      behavior: "smooth",
      block: "center",
    });
  };

  const handleRemoveAddReceipt = () => {
    setReceiptUrl(null);
    setReceiptPreviewUrl(null);
    setReceiptFileName("");
    setReceiptStatusMessage(null);
    setReceiptScanError(null);
  };

  // Live exact split calculation & auto-summed total for Add Transaction form
  const exactSummary = useMemo(() => {
    const centsRecord: Record<string, number> = {};
    let totalSplitCents = 0;
    for (const m of members) {
      const val = parseFloat(exactValues[m.id] || "0");
      const cents = !isNaN(val) && val > 0 ? Math.round(val * 100) : 0;
      centsRecord[m.id] = cents;
      if (cents > 0) {
        totalSplitCents += cents;
      }
    }
    const valid = validateExactSplits(totalSplitCents, centsRecord);
    const splits = Object.entries(centsRecord)
      .filter(([, cents]) => cents > 0)
      .map(([memberId, splitAmountCents]) => ({
        memberId,
        splitAmountCents,
      }));
    const error = valid
      ? undefined
      : "Please enter at least one member amount greater than $0.00.";
    return {
      valid,
      totalSplitCents,
      splits,
      error,
    };
  }, [members, exactValues]);

  // Live split computation (in $ Exact mode, totalCents is automatically summed from member amounts)
  const isExactMode = type === "expense" && splitMode === "exact";
  const parsedAmount = parseFloat(amount);
  const manualTotalCents =
    !isNaN(parsedAmount) && parsedAmount > 0
      ? Math.round(parsedAmount * 100)
      : 0;
  const totalCents = isExactMode
    ? exactSummary.totalSplitCents
    : manualTotalCents;
  const perPersonAmount =
    totalCents > 0 && selectedMembers.length > 0
      ? (totalCents / 100 / selectedMembers.length).toFixed(2)
      : null;

  // Live percentage summary for Add Transaction form
  const percentageSummary = useMemo(() => {
    const pctRecord: Record<string, number> = {};
    let totalPct = 0;
    for (const m of members) {
      const pct = parseFloat(percentageValues[m.id] || "0") || 0;
      pctRecord[m.id] = pct;
      totalPct += pct;
    }
    const remainingPct = 100 - totalPct;
    const isValid =
      Math.abs(remainingPct) <= 0.01 &&
      Object.values(pctRecord).some((p) => p > 0);
    const allocatedRecord =
      isValid && totalCents > 0
        ? splitAmountByPercentage(totalCents, pctRecord)
        : {};
    const splits = Object.entries(allocatedRecord).map(
      ([memberId, splitAmountCents]) => ({
        memberId,
        splitAmountCents,
      })
    );
    const splitMap = new Map(
      splits.map((s) => [s.memberId, s.splitAmountCents])
    );
    return {
      totalPct,
      remainingPct,
      isValid,
      splits,
      splitMap,
    };
  }, [members, percentageValues, totalCents]);

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

  // Execute CSV Import into a New Group or Active Group using Bulk Batch Inserts (Super-Admin only)
  const handleImportCsv = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!isSuperAdmin || !user || !parsedCsv) return;

    setIsImportingCsv(true);
    setCsvError(null);

    try {
      let targetGroup: Group | null = null;
      const csvCurrencies = Array.from(
        new Set(
          parsedCsv.transactions.map((t) => normalizeCurrencyCode(t.currency))
        )
      );

      if (csvTargetMode === "new" || !activeGroup) {
        const trimmedName =
          csvGroupName.trim() ||
          deriveGroupNameFromCsvFilename(csvFileName) ||
          "Imported Group";
        const generatedSlug = generateGroupSlug(trimmedName);
        const defaultCur = csvCurrencies[0] || "USD";
        const groupCurrencies = buildGroupCurrencies(csvCurrencies, defaultCur);

        let { data: newGroupRow, error: groupError } = await supabase
          .from("groups")
          .insert({
            name: trimmedName,
            slug: generatedSlug,
            created_by: user.id,
            currencies: groupCurrencies,
            default_currency: defaultCur,
          })
          .select("*")
          .single();

        if (groupError) {
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
          currencies: newGroupRow.currencies || groupCurrencies,
          default_currency: newGroupRow.default_currency || defaultCur,
        });
      } else {
        targetGroup = activeGroup;
      }

      // 1. Batch-insert all missing CSV header member names in a single call and build name -> id map
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

      const missingMembersToInsert: Array<{
        group_id: string;
        display_name: string;
      }> = [];
      const seenMissingLower = new Set<string>();

      for (const rawName of parsedCsv.memberNames) {
        const cleanName = rawName.trim();
        if (!cleanName) continue;
        const lower = cleanName.toLowerCase();
        if (!memberIdByLowerName.has(lower) && !seenMissingLower.has(lower)) {
          seenMissingLower.add(lower);
          missingMembersToInsert.push({
            group_id: targetGroup.id,
            display_name: cleanName,
          });
        }
      }

      if (missingMembersToInsert.length > 0) {
        const { data: insertedMembers, error: memErr } = await supabase
          .from("group_members")
          .insert(missingMembersToInsert)
          .select("id, display_name");

        if (memErr) {
          setCsvError(`Error adding group members: ${memErr.message}`);
          setIsImportingCsv(false);
          return;
        }

        for (const m of insertedMembers || []) {
          if (m.display_name) {
            memberIdByLowerName.set(m.display_name.trim().toLowerCase(), m.id);
          }
        }
      }

      // 2. Build entire expensesToInsert and splitsToInsert arrays in memory using crypto.randomUUID()
      const expensesToInsert: Array<Record<string, unknown>> = [];
      const splitsToInsert: Array<Record<string, unknown>> = [];
      const fallbackCurrencyById = new Map<string, string>();
      const amountDollarsById = new Map<string, number>();

      for (const txn of parsedCsv.transactions) {
        const payerMemberId = memberIdByLowerName.get(
          txn.paidByMemberName.trim().toLowerCase()
        );
        if (!payerMemberId) continue;

        const expenseId =
          typeof crypto !== "undefined" &&
          typeof crypto.randomUUID === "function"
            ? crypto.randomUUID()
            : "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
                const r = (Math.random() * 16) | 0;
                const v = c === "x" ? r : (r & 0x3) | 0x8;
                return v.toString(16);
              });

        const isoCur = normalizeCurrencyCode(txn.currency);
        fallbackCurrencyById.set(expenseId, getCurrencySymbol(isoCur));
        amountDollarsById.set(
          expenseId,
          Number((txn.amountCents / 100).toFixed(2))
        );

        expensesToInsert.push({
          id: expenseId,
          group_id: targetGroup.id,
          paid_by_member_id: payerMemberId,
          description: txn.description,
          category:
            txn.type === "payment"
              ? "Payment"
              : (txn.category || "").trim() || "General",
          amount_cents: txn.amountCents,
          currency: isoCur,
          type: txn.type,
          date: txn.date || getTodayLocalDate(),
        });

        for (const s of txn.splits) {
          const mId = memberIdByLowerName.get(
            s.memberName.trim().toLowerCase()
          );
          if (!mId) continue;
          splitsToInsert.push({
            expense_id: expenseId,
            member_id: mId,
            split_amount_cents: s.splitAmountCents,
          });
        }
      }

      // 3. Execute single bulk insert into expenses
      if (expensesToInsert.length > 0) {
        let bulkExpensesPayload = expensesToInsert;
        let { error: expError } = await supabase
          .from("expenses")
          .insert(bulkExpensesPayload);

        for (let attempt = 0; attempt < 4 && expError; attempt++) {
          const msg = expError.message?.toLowerCase() || "";
          let updated = false;
          if (
            (msg.includes("expenses_currency_check") ||
              msg.includes("currency")) &&
            bulkExpensesPayload.some(
              (row) => row.currency !== fallbackCurrencyById.get(row.id as string)
            )
          ) {
            bulkExpensesPayload = bulkExpensesPayload.map((row) => ({
              ...row,
              currency:
                fallbackCurrencyById.get(row.id as string) || row.currency,
            }));
            updated = true;
          }
          if (
            msg.includes('"amount"') &&
            !("amount" in bulkExpensesPayload[0])
          ) {
            bulkExpensesPayload = bulkExpensesPayload.map((row) => ({
              ...row,
              amount: amountDollarsById.get(row.id as string) ?? 0,
            }));
            updated = true;
          }
          if (
            msg.includes('"created_by"') &&
            !("created_by" in bulkExpensesPayload[0])
          ) {
            bulkExpensesPayload = bulkExpensesPayload.map((row) => ({
              ...row,
              created_by: user.id,
            }));
            updated = true;
          }
          if (
            msg.includes('"payer_id"') &&
            !("payer_id" in bulkExpensesPayload[0])
          ) {
            bulkExpensesPayload = bulkExpensesPayload.map((row) => ({
              ...row,
              payer_id: user.id || row.paid_by_member_id,
            }));
            updated = true;
          }
          if (!updated) break;
          const retry = await supabase
            .from("expenses")
            .insert(bulkExpensesPayload);
          expError = retry.error;
        }

        if (expError) {
          setCsvError(`Error importing transactions: ${expError.message}`);
          setIsImportingCsv(false);
          return;
        }
      }

      // 4. Execute single bulk insert into expense_splits
      if (splitsToInsert.length > 0) {
        let bulkSplitsPayload = splitsToInsert;
        let { error: splitsError } = await supabase
          .from("expense_splits")
          .insert(bulkSplitsPayload);

        for (let attempt = 0; attempt < 2 && splitsError; attempt++) {
          const msg = splitsError.message?.toLowerCase() || "";
          let updated = false;
          if (msg.includes('"amount"') && !("amount" in bulkSplitsPayload[0])) {
            bulkSplitsPayload = bulkSplitsPayload.map((s) => ({
              ...s,
              amount: Number(
                ((s.split_amount_cents as number) / 100).toFixed(2)
              ),
            }));
            updated = true;
          }
          if (
            msg.includes('"user_id"') &&
            !("user_id" in bulkSplitsPayload[0])
          ) {
            bulkSplitsPayload = bulkSplitsPayload.map((s) => ({
              ...s,
              user_id: user.id || s.member_id,
            }));
            updated = true;
          }
          if (!updated) break;
          const retrySplits = await supabase
            .from("expense_splits")
            .insert(bulkSplitsPayload);
          splitsError = retrySplits.error;
        }

        if (splitsError) {
          setCsvError(`Error importing splits: ${splitsError.message}`);
          setIsImportingCsv(false);
          return;
        }
      }

      // Auto-enable any currencies present in the CSV on targetGroup
      if (csvCurrencies.length > 0) {
        const updatedCurrencies = buildGroupCurrencies(
          targetGroup.currencies || ["USD"],
          targetGroup.default_currency || "USD",
          csvCurrencies
        );
        targetGroup = {
          ...targetGroup,
          currencies: updatedCurrencies,
        };
        await supabase
          .from("groups")
          .update({ currencies: updatedCurrencies })
          .eq("id", targetGroup.id);
      }

      // Refresh state & select targetGroup
      setGroups((prev) =>
        prev.some((g) => g.id === targetGroup!.id)
          ? prev.map((g) => (g.id === targetGroup!.id ? targetGroup! : g))
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
    const defaultCur = normalizeCurrencyCode(newGroupDefaultCurrency || "USD");
    const groupCurrencies = buildGroupCurrencies(
      newGroupCurrencies,
      defaultCur
    );

    // 1. Try inserting with slug and currencies columns included
    let { data: newGroupRow, error: groupError } = await supabase
      .from("groups")
      .insert({
        name: trimmedName,
        slug: generatedSlug,
        created_by: user.id,
        currencies: groupCurrencies,
        default_currency: defaultCur,
      })
      .select("*")
      .single();

    // Fallback if slug or currency columns have not yet been added in Supabase SQL
    if (groupError) {
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
      currencies: newGroupRow.currencies || groupCurrencies,
      default_currency: newGroupRow.default_currency || defaultCur,
    });

    if (addAdminAsMember) {
      await supabase.from("group_members").insert({
        group_id: normalizedNewGroup.id,
        display_name: "Murph",
      });
    }

    setNewGroupName("");
    setAddAdminAsMember(true);
    setNewGroupCurrencies(["USD"]);
    setNewGroupDefaultCurrency("USD");
    setShowNewGroupCurrencies(false);
    setGroups((prev) => [normalizedNewGroup, ...prev]);
    handleSelectGroup(normalizedNewGroup);
    setIsInviteModalOpen(true);
  };

  // Archive / Unarchive group toggle (Strictly Super-Admin only)
  const handleToggleArchiveGroup = async (group: Group) => {
    if (!isSuperAdmin) return;
    const nextArchived = !group.is_archived;

    const { error } = await supabase
      .from("groups")
      .update({ is_archived: nextArchived })
      .eq("id", group.id);

    if (error) {
      alert("Error updating group archive status: " + error.message);
      return;
    }

    setGroups((prev) =>
      prev.map((g) =>
        g.id === group.id ? { ...g, is_archived: nextArchived } : g
      )
    );
    if (nextArchived) {
      setShowArchivedGroups(true);
    }
    setNotification({
      type: "success",
      message: nextArchived
        ? `Archived "${group.name}". The group is now locked in Read-Only mode.`
        : `Unarchived "${group.name}". Editing and adding transactions are re-enabled.`,
    });
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
    if (activeGroup?.is_archived) return;
    const finalPayerId = payerId || effectivePayerId;
    if (!activeGroupId || totalCents <= 0 || !finalPayerId) {
      return;
    }

    let calculatedSplits: Array<{
      memberId: string;
      splitAmountCents: number;
    }> = [];

    if (type === "payment") {
      if (selectedMembers.length === 0) {
        alert("Please select a recipient for the payment.");
        return;
      }
      calculatedSplits = [
        {
          memberId: selectedMembers[0],
          splitAmountCents: totalCents,
        },
      ];
    } else if (splitMode === "equal") {
      if (selectedMembers.length === 0) {
        alert("Please select at least one member to split this expense.");
        return;
      }
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

    const effectiveExpenseCategory = isCustomCategory
      ? customCategoryInput.trim() || category.trim() || "General"
      : (category || "").trim() || "General";

    const normalizedIsoCurrency = normalizeCurrencyCode(currency);

    const expensePayload: Record<string, unknown> = {
      group_id: activeGroupId,
      paid_by_member_id: finalPayerId,
      description:
        description.trim() ||
        (type === "payment" ? "Direct Payment" : "Group Expense"),
      category:
        type === "payment" ? "Payment" : effectiveExpenseCategory,
      receipt_url: type === "payment" ? null : receiptUrl,
      amount_cents: totalCents,
      currency: normalizedIsoCurrency,
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
      const symbolFallback = getCurrencySymbol(normalizedIsoCurrency);
      if (
        (msg.includes("expenses_currency_check") || msg.includes("currency")) &&
        expensePayload.currency !== symbolFallback
      ) {
        expensePayload.currency = symbolFallback;
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
      // Roll back the parent expense so an orphaned expense with 0 splits can never remain in the database
      await supabase.from("expenses").delete().eq("id", newExp.id);
      alert("Error adding splits: " + splitsError.message);
      return;
    }

    // Refresh UI
    setDescription("");
    setAmount("");
    setCategory("General");
    setIsCustomCategory(false);
    setCustomCategoryInput("");
    setReceiptUrl(null);
    setReceiptPreviewUrl(null);
    setReceiptFileName("");
    setReceiptStatusMessage(null);
    setReceiptScanError(null);
    setPercentageValues({});
    setExactValues({});
    startTransition(() => {
      refreshExpenses(activeGroupId);
    });
  };

  // Delete transaction (Group-wide permission, disabled when group is archived)
  const handleDeleteExpense = async (expenseId: string, desc: string) => {
    if (activeGroup?.is_archived) return;
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

      {/* Shared Receipt Group Picker Banner (when shared via Web Share Target to /?shared_receipt=...) */}
      {sharedReceiptBannerUrl && activeGroups.length > 1 && (
        <div className="max-w-7xl mx-auto px-6 pt-4">
          <div className="p-3.5 rounded-xl bg-blue-50 border border-blue-200 text-xs text-blue-900 flex items-center justify-between gap-3 flex-wrap">
            <div className="flex items-center gap-2.5 flex-wrap">
              <span className="inline-flex items-center gap-1.5 font-bold text-blue-800">
                <Receipt className="w-4 h-4 text-blue-600 shrink-0" />
                <span>Shared Receipt Ready — Choose Group:</span>
              </span>
              <div className="flex items-center gap-1.5 flex-wrap">
                {activeGroups.map((g) => {
                  const isCurrent = g.id === activeGroupId;
                  const slugOrId =
                    g.slug || generateGroupSlug(g.name) || g.id;
                  return (
                    <button
                      key={g.id}
                      type="button"
                      onClick={() => {
                        setActiveGroupId(g.id);
                        addRecentGroupId(g.id);
                        if (typeof window !== "undefined") {
                          window.history.pushState(null, "", `/${slugOrId}`);
                        }
                        attachAndScanSharedReceipt(sharedReceiptBannerUrl, g);
                        setSharedReceiptBannerUrl(null);
                      }}
                      className={`px-3 py-1 rounded-full text-xs font-semibold border transition cursor-pointer ${
                        isCurrent
                          ? "bg-blue-600 text-white border-blue-600 shadow-2xs"
                          : "bg-white text-blue-800 border-blue-200 hover:bg-blue-100"
                      }`}
                    >
                      {g.name}
                    </button>
                  );
                })}
              </div>
            </div>
            <button
              type="button"
              onClick={() => setSharedReceiptBannerUrl(null)}
              className="text-blue-400 hover:text-blue-700 text-xs px-2 py-0.5 rounded cursor-pointer"
            >
              ✕
            </button>
          </div>
        </div>
      )}

      {!isSuperAdmin && groups.length === 0 && !activeGroup ? (
        <div className="max-w-md mx-auto px-6 py-24">
          <div className="bg-white border border-slate-200 p-8 rounded-2xl shadow-xs text-center space-y-4">
            <div className="mx-auto w-11 h-11 rounded-xl bg-slate-100 text-slate-700 flex items-center justify-center">
              <Shield className="w-5 h-5" />
            </div>
            <div className="space-y-1.5">
              <h2 className="text-base font-bold text-slate-900">
                Private Portal
              </h2>
              <p className="text-xs text-slate-500 leading-relaxed">
                Open your shared group link directly to view or add expenses, or
                sign in as the administrator.
              </p>
            </div>
            {!user && (
              <button
                type="button"
                onClick={signInWithGoogle}
                className="inline-flex items-center justify-center gap-2 bg-slate-900 hover:bg-slate-800 text-white px-4 py-2.5 rounded-xl text-xs font-semibold transition cursor-pointer shadow-xs"
              >
                <LogIn className="w-3.5 h-3.5" />
                Admin Sign In
              </button>
            )}
          </div>
        </div>
      ) : (
      <div className="max-w-7xl mx-auto p-6 grid grid-cols-1 md:grid-cols-4 gap-6">
        {/* Groups Sidebar */}
        <aside className="bg-white border border-slate-200 p-4 rounded-2xl h-fit flex flex-col gap-4">
          <div className="space-y-3">
            <div>
              <h2 className="font-semibold text-slate-800 mb-2.5 text-sm flex items-center justify-between">
                <span>{isSuperAdmin ? "Active Groups" : "Your Groups"}</span>
                <span className="text-xs text-slate-400 font-normal">
                  {activeGroups.length}
                </span>
              </h2>
              <div className="space-y-1">
                {activeGroups.length === 0 ? (
                  <p className="text-xs text-slate-400 italic py-2">
                    {isSuperAdmin
                      ? archivedGroups.length > 0
                        ? "No active groups. See archived below or create one."
                        : "No groups yet. Create one below!"
                      : "Open a shared group link (e.g. /SoCal_2026) to access your group."}
                  </p>
                ) : (
                  activeGroups.map((g) => (
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
                          aria-label={`Delete group ${g.name}`}
                          className="text-slate-400 hover:text-red-600 hover:bg-red-50 p-1.5 rounded-md transition-colors shrink-0 cursor-pointer"
                        >
                          <svg
                            xmlns="http://www.w3.org/2000/svg"
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth={2}
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            className="w-4 h-4 shrink-0"
                            aria-hidden="true"
                          >
                            <path d="M3 6h18" />
                            <path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6" />
                            <path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2" />
                            <line x1="10" x2="10" y1="11" y2="17" />
                            <line x1="14" x2="14" y1="11" y2="17" />
                          </svg>
                        </button>
                      )}
                    </div>
                  ))
                )}
              </div>
            </div>

            {/* Collapsible Archived (N) Groups Section */}
            {archivedGroups.length > 0 && (
              <div className="pt-2 border-t border-slate-100">
                <button
                  type="button"
                  onClick={() => setShowArchivedGroups((prev) => !prev)}
                  className="w-full flex items-center justify-between text-xs font-semibold text-slate-500 hover:text-slate-800 py-1.5 cursor-pointer transition"
                >
                  <span className="flex items-center gap-1.5">
                    {showArchivedGroups || activeGroup?.is_archived ? (
                      <ChevronDown className="w-3.5 h-3.5 text-slate-400" />
                    ) : (
                      <ChevronRight className="w-3.5 h-3.5 text-slate-400" />
                    )}
                    <Archive className="w-3.5 h-3.5 text-slate-400" />
                    <span>Archived ({archivedGroups.length})</span>
                  </span>
                </button>

                {(showArchivedGroups || activeGroup?.is_archived) && (
                  <div className="space-y-1 mt-1.5">
                    {archivedGroups.map((g) => (
                      <div
                        key={g.id}
                        className={`group flex items-center justify-between px-3 py-1.5 text-xs rounded-xl transition ${
                          activeGroupId === g.id
                            ? "bg-amber-50 text-amber-900 font-semibold border border-amber-200 shadow-2xs"
                            : "text-slate-500 hover:bg-slate-100 border border-transparent"
                        }`}
                      >
                        <button
                          type="button"
                          onClick={() => handleSelectGroup(g)}
                          className="flex-1 text-left truncate mr-2 cursor-pointer flex items-center gap-1.5"
                        >
                          <Lock className="w-3 h-3 text-slate-400 shrink-0" />
                          <span className="truncate">{g.name}</span>
                        </button>
                        {isSuperAdmin && (
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              handleDeleteGroup(g.id, g.name);
                            }}
                            title="Delete group"
                            aria-label={`Delete archived group ${g.name}`}
                            className="text-slate-400 hover:text-red-600 hover:bg-red-50 p-1.5 rounded-md transition-colors shrink-0 cursor-pointer"
                          >
                            <svg
                              xmlns="http://www.w3.org/2000/svg"
                              viewBox="0 0 24 24"
                              fill="none"
                              stroke="currentColor"
                              strokeWidth={2}
                              strokeLinecap="round"
                              strokeLinejoin="round"
                              className="w-4 h-4 shrink-0"
                              aria-hidden="true"
                            >
                              <path d="M3 6h18" />
                              <path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6" />
                              <path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2" />
                              <line x1="10" x2="10" y1="11" y2="17" />
                              <line x1="14" x2="14" y1="11" y2="17" />
                            </svg>
                          </button>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
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

                {/* Optional Multi-Currency Selector for New Groups (defaults to USD only) */}
                <div className="space-y-1.5">
                  <button
                    type="button"
                    onClick={() =>
                      setShowNewGroupCurrencies((prev) => !prev)
                    }
                    className="text-[11px] font-semibold text-slate-500 hover:text-blue-600 flex items-center gap-1 cursor-pointer"
                  >
                    <Globe className="w-3 h-3" />
                    <span>
                      Currencies: {newGroupCurrencies.join(", ")} (Default:{" "}
                      {newGroupDefaultCurrency})
                    </span>
                  </button>
                  {showNewGroupCurrencies && (
                    <div className="p-2.5 bg-slate-50 border border-slate-200 rounded-xl space-y-2">
                      <div className="flex flex-wrap gap-1">
                        {SUPPORTED_CURRENCIES.map((cur) => {
                          const isSelected = newGroupCurrencies.includes(
                            cur.code
                          );
                          return (
                            <button
                              key={cur.code}
                              type="button"
                              onClick={() => {
                                setNewGroupCurrencies((prev) => {
                                  if (prev.includes(cur.code)) {
                                    if (prev.length === 1) return prev;
                                    const next = prev.filter(
                                      (c) => c !== cur.code
                                    );
                                    if (newGroupDefaultCurrency === cur.code) {
                                      setNewGroupDefaultCurrency(
                                        next[0] || "USD"
                                      );
                                    }
                                    return next;
                                  }
                                  return [...prev, cur.code];
                                });
                              }}
                              className={`px-2 py-0.5 rounded-full text-[11px] font-semibold border transition cursor-pointer ${
                                isSelected
                                  ? "bg-blue-600 text-white border-blue-600"
                                  : "bg-white text-slate-600 border-slate-200 hover:bg-slate-100"
                              }`}
                            >
                              {cur.symbol} {cur.code}
                            </button>
                          );
                        })}
                      </div>
                      {newGroupCurrencies.length > 1 && (
                        <div className="flex items-center justify-between gap-2 pt-1 border-t border-slate-200/80 text-[11px]">
                          <span className="font-semibold text-slate-600">
                            Default:
                          </span>
                          <select
                            value={newGroupDefaultCurrency}
                            onChange={(e) =>
                              setNewGroupDefaultCurrency(e.target.value)
                            }
                            className="border border-slate-300 rounded-md px-1.5 py-0.5 text-[11px] font-bold text-slate-800 bg-white"
                          >
                            {newGroupCurrencies.map((code) => (
                              <option key={code} value={code}>
                                {code} ({getCurrencySymbol(code)})
                              </option>
                            ))}
                          </select>
                        </div>
                      )}
                    </div>
                  )}
                </div>

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
        <section className="md:col-span-2 min-w-0 space-y-6">
          {activeGroup ? (
            <div className="bg-white border border-slate-200 p-5 rounded-2xl shadow-xs space-y-4 overflow-hidden">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-2.5 flex-wrap min-w-0">
                  <h2 className="text-xl font-bold text-slate-900 tracking-tight truncate">
                    {activeGroup.name}
                  </h2>
                  <span className="px-2.5 py-0.5 rounded-full text-xs font-semibold bg-slate-100 text-slate-700 shrink-0">
                    {members.length}{" "}
                    {members.length === 1 ? "member" : "members"}
                  </span>
                  {activeGroup.is_archived && (
                    <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-bold bg-amber-100 text-amber-800 border border-amber-200 shrink-0">
                      <Lock className="w-3 h-3" />
                      Archived — Read-Only
                    </span>
                  )}
                </div>

                {/* Action Buttons: Copy Group Link, Export CSV (All Users), Currencies, Archive Toggle & Manage Members (Super-Admin) */}
                <div className="flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    onClick={handleCopyGroupLink}
                    className={`inline-flex items-center justify-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-xl transition shadow-2xs cursor-pointer ${
                      copiedGroupLink
                        ? "bg-emerald-600 text-white"
                        : "bg-slate-100 hover:bg-slate-200 text-slate-700 border border-slate-200"
                    }`}
                  >
                    {copiedGroupLink ? (
                      <>
                        <Check className="w-3.5 h-3.5 shrink-0" />
                        <span>Copied Link!</span>
                      </>
                    ) : (
                      <>
                        <Share2 className="w-3.5 h-3.5 shrink-0" />
                        <span>Copy Group Link</span>
                      </>
                    )}
                  </button>

                  <button
                    type="button"
                    onClick={handleExportCsv}
                    className="inline-flex items-center justify-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-xl transition shadow-2xs bg-slate-100 hover:bg-slate-200 text-slate-700 border border-slate-200 cursor-pointer"
                  >
                    <Download className="w-3.5 h-3.5 shrink-0" />
                    <span>Export CSV</span>
                  </button>

                  {isSuperAdmin && !activeGroup.is_archived && (
                    <button
                      type="button"
                      onClick={() => {
                        setEditingGroupCurrencies(activeGroupCurrencies);
                        setEditingDefaultCurrency(activeDefaultCurrency);
                        setCustomIsoInput("");
                        setIsCurrencyModalOpen(true);
                      }}
                      title="Configure enabled currencies for this group"
                      className="inline-flex items-center justify-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-xl transition shadow-2xs bg-slate-100 hover:bg-slate-200 text-slate-700 border border-slate-200 cursor-pointer"
                    >
                      <Settings2 className="w-3.5 h-3.5 shrink-0" />
                      <span>
                        Currencies ({activeGroupCurrencies.join(", ")})
                      </span>
                    </button>
                  )}

                  {isSuperAdmin && (
                    <button
                      type="button"
                      onClick={() => handleToggleArchiveGroup(activeGroup)}
                      className={`inline-flex items-center justify-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-xl transition shadow-2xs cursor-pointer border ${
                        activeGroup.is_archived
                          ? "bg-amber-50 hover:bg-amber-100 text-amber-800 border-amber-200"
                          : "bg-slate-100 hover:bg-slate-200 text-slate-700 border-slate-200"
                      }`}
                    >
                      {activeGroup.is_archived ? (
                        <>
                          <ArchiveRestore className="w-3.5 h-3.5 shrink-0" />
                          <span>Unarchive Group</span>
                        </>
                      ) : (
                        <>
                          <Archive className="w-3.5 h-3.5 shrink-0" />
                          <span>Archive Group</span>
                        </>
                      )}
                    </button>
                  )}

                  {isSuperAdmin && !activeGroup.is_archived && (
                    <button
                      type="button"
                      onClick={() => setIsInviteModalOpen(true)}
                      className="inline-flex items-center justify-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-xl transition shadow-xs bg-blue-600 hover:bg-blue-700 text-white cursor-pointer"
                    >
                      <UserPlus className="w-3.5 h-3.5 shrink-0" />
                      <span>Manage Members</span>
                    </button>
                  )}
                </div>
              </div>

              {activeGroup.is_archived && (
                <div className="p-3 bg-amber-50/90 border border-amber-200 rounded-xl text-xs text-amber-900 flex items-center justify-between gap-2 flex-wrap">
                  <span className="flex items-center gap-2 font-medium">
                    <Lock className="w-4 h-4 text-amber-700 shrink-0" />
                    <span>
                      <strong>Archived — Read-Only:</strong> This group is
                      retired and locked. Adding, editing, or deleting
                      transactions and members is disabled.
                    </span>
                  </span>
                </div>
              )}

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

              {/* Per-Group Currency Ledger Summary Metrics (Clean single-currency UX when only 1 currency is enabled) */}
              <div
                className={`grid grid-cols-2 ${
                  displayCurrencies.length >= 2
                    ? "sm:grid-cols-3"
                    : "sm:grid-cols-2"
                } gap-3 pt-2 border-t border-slate-100 text-xs`}
              >
                {displayCurrencies.map((code) => (
                  <div
                    key={code}
                    className="p-2.5 bg-slate-50/80 rounded-xl border border-slate-100"
                  >
                    <span className="text-slate-400 font-medium block text-[11px] mb-0.5">
                      {code} Spent
                    </span>
                    <span className="text-base font-bold text-slate-900">
                      {formatCurrency(currencyTotalsCents[code] || 0, code)}
                    </span>
                  </div>
                ))}
                <div className="p-2.5 bg-slate-50/80 rounded-xl border border-slate-100">
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
              {/* Cumulative Member Summary Card (Supports Isolated Per-Currency or Unified Converted View) */}
              {members.length > 0 && (
                <div className="bg-white border border-slate-200 p-5 rounded-2xl shadow-xs space-y-4">
                  <div className="flex items-center justify-between gap-2 flex-wrap">
                    <div>
                      <h3 className="font-bold text-sm text-slate-900 flex items-center gap-2">
                        <Users className="w-4 h-4 text-blue-600" />
                        Member Summary
                        {hasMultipleCurrencies && isUnifiedMode && (
                          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-bold bg-emerald-50 text-emerald-700 border border-emerald-200">
                            <Globe className="w-3 h-3" />
                            Unified in {unifiedTargetCurrency} (
                            {getCurrencySymbol(unifiedTargetCurrency)})
                          </span>
                        )}
                      </h3>
                      <p className="text-xs text-slate-400 mt-0.5">
                        {hasMultipleCurrencies && isUnifiedMode
                          ? `All expenses and payments converted into ${unifiedTargetCurrency} using your active exchange rates`
                          : "Cumulative out-of-pocket expenses paid vs. accrued share consumed vs. net balance (including settlement payments)"}
                      </p>
                    </div>

                    {hasMultipleCurrencies && (
                      <button
                        type="button"
                        onClick={() => setIsUnifiedMode((prev) => !prev)}
                        className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-semibold border transition cursor-pointer ${
                          isUnifiedMode
                            ? "bg-emerald-600 text-white border-emerald-600 shadow-2xs"
                            : "bg-slate-50 text-slate-700 border-slate-200 hover:bg-slate-100"
                        }`}
                      >
                        <Globe className="w-3.5 h-3.5" />
                        <span>
                          {isUnifiedMode
                            ? `Showing Unified (${unifiedTargetCurrency})`
                            : "🌐 Unified Settlement (Convert All)"}
                        </span>
                      </button>
                    )}
                  </div>

                  {hasMultipleCurrencies && isUnifiedMode ? (
                    <div className="space-y-2">
                      <div className="text-xs font-bold text-emerald-800 flex items-center gap-1.5">
                        <span className="w-2 h-2 rounded-full bg-emerald-600"></span>
                        Unified {unifiedTargetCurrency} (
                        {getCurrencySymbol(unifiedTargetCurrency)}) Breakdown
                      </div>
                      <div className="overflow-x-auto border border-emerald-100 rounded-xl">
                        <table className="w-full text-left border-collapse text-xs">
                          <thead>
                            <tr className="bg-emerald-50/60 border-b border-emerald-100 text-slate-600 font-semibold">
                              <th className="py-2.5 px-3">Member</th>
                              <th className="py-2.5 px-3 text-right">
                                Paid (Converted)
                              </th>
                              <th className="py-2.5 px-3 text-right">
                                Share (Converted)
                              </th>
                              <th className="py-2.5 px-3 text-right">
                                Unified Net Balance
                              </th>
                            </tr>
                          </thead>
                          <tbody className="divide-y divide-slate-100">
                            {unifiedResult.memberBreakdown.map((row) => {
                              const paidStr = formatCurrency(
                                row.paidCents,
                                unifiedTargetCurrency
                              );
                              const shareStr = formatCurrency(
                                row.shareCents,
                                unifiedTargetCurrency
                              );
                              const absFormatted = formatCurrency(
                                Math.abs(row.netBalanceCents),
                                unifiedTargetCurrency
                              );
                              const netStr =
                                row.netBalanceCents > 0
                                  ? `+${absFormatted}`
                                  : row.netBalanceCents < 0
                                    ? `-${absFormatted}`
                                    : formatCurrency(0, unifiedTargetCurrency);
                              const netColorClass =
                                row.netBalanceCents > 0
                                  ? "text-emerald-600 font-bold"
                                  : row.netBalanceCents < 0
                                    ? "text-rose-600 font-bold"
                                    : "text-slate-400 font-medium";

                              return (
                                <tr
                                  key={row.memberId}
                                  className="hover:bg-slate-50/60 transition"
                                >
                                  <td className="py-2.5 px-3 font-semibold text-slate-900">
                                    {row.memberName}
                                    {row.memberId === activeMemberId && (
                                      <span className="ml-1.5 text-[10px] font-semibold text-blue-600">
                                        (You)
                                      </span>
                                    )}
                                  </td>
                                  <td className="py-2.5 px-3 text-right text-slate-700 font-medium">
                                    {paidStr}
                                  </td>
                                  <td className="py-2.5 px-3 text-right text-slate-700 font-medium">
                                    {shareStr}
                                  </td>
                                  <td
                                    className={`py-2.5 px-3 text-right ${netColorClass}`}
                                  >
                                    {netStr}
                                  </td>
                                </tr>
                              );
                            })}
                          </tbody>
                        </table>
                      </div>
                    </div>
                  ) : (
                    displayCurrencies.map((code, idx) => {
                      const rows = memberBreakdownByCurrency[code] || [];
                      const sym = getCurrencySymbol(code);
                      return (
                        <div
                          key={code}
                          className={`space-y-2 ${
                            idx > 0 ? "pt-3 border-t border-slate-100" : ""
                          }`}
                        >
                          {displayCurrencies.length > 1 && (
                            <div className="text-xs font-bold text-slate-700 flex items-center gap-1.5">
                              <span
                                className={`w-2 h-2 rounded-full ${
                                  idx % 2 === 0
                                    ? "bg-blue-600"
                                    : "bg-indigo-600"
                                }`}
                              ></span>
                              {code} ({sym}) Breakdown
                            </div>
                          )}
                          <div className="overflow-x-auto border border-slate-100 rounded-xl">
                            <table className="w-full text-left border-collapse text-xs">
                              <thead>
                                <tr className="bg-slate-50/90 border-b border-slate-100 text-slate-500 font-semibold">
                                  <th className="py-2.5 px-3">Member</th>
                                  <th className="py-2.5 px-3 text-right">
                                    Paid (Out-of-Pocket)
                                  </th>
                                  <th className="py-2.5 px-3 text-right">
                                    Share (Accrued Cost)
                                  </th>
                                  <th className="py-2.5 px-3 text-right">
                                    Net Balance
                                  </th>
                                </tr>
                              </thead>
                              <tbody className="divide-y divide-slate-100">
                                {rows.map((row) => {
                                  const paidStr = formatCurrency(
                                    row.paidCents,
                                    code
                                  );
                                  const shareStr = formatCurrency(
                                    row.shareCents,
                                    code
                                  );
                                  const absFormatted = formatCurrency(
                                    Math.abs(row.netBalanceCents),
                                    code
                                  );
                                  const netStr =
                                    row.netBalanceCents > 0
                                      ? `+${absFormatted}`
                                      : row.netBalanceCents < 0
                                        ? `-${absFormatted}`
                                        : formatCurrency(0, code);
                                  const netColorClass =
                                    row.netBalanceCents > 0
                                      ? "text-emerald-600 font-bold"
                                      : row.netBalanceCents < 0
                                        ? "text-rose-600 font-bold"
                                        : "text-slate-400 font-medium";

                                  return (
                                    <tr
                                      key={row.memberId}
                                      className="hover:bg-slate-50/60 transition"
                                    >
                                      <td className="py-2.5 px-3 font-semibold text-slate-900">
                                        {row.memberName}
                                        {row.memberId === activeMemberId && (
                                          <span className="ml-1.5 text-[10px] font-semibold text-blue-600">
                                            (You)
                                          </span>
                                        )}
                                      </td>
                                      <td className="py-2.5 px-3 text-right text-slate-700 font-medium">
                                        {paidStr}
                                      </td>
                                      <td className="py-2.5 px-3 text-right text-slate-700 font-medium">
                                        {shareStr}
                                      </td>
                                      <td
                                        className={`py-2.5 px-3 text-right ${netColorClass}`}
                                      >
                                        {netStr}
                                      </td>
                                    </tr>
                                  );
                                })}
                              </tbody>
                            </table>
                          </div>
                        </div>
                      );
                    })
                  )}
                </div>
              )}

              {/* Add Transaction Form (Hidden when group is archived) */}
              {!activeGroup.is_archived && (
              <form
                ref={addTransactionFormRef}
                onSubmit={handleAddExpense}
                className={`bg-white border p-6 rounded-2xl shadow-xs space-y-4 transition-all duration-300 ${
                  isFormHighlighted
                    ? "border-emerald-400 ring-2 ring-emerald-500/30 bg-emerald-50/10"
                    : "border-slate-200"
                }`}
              >
                <div className="flex items-center justify-between">
                  <h2 className="font-bold text-slate-900 text-base">
                    Add Transaction
                  </h2>
                  <div className="flex bg-slate-100 p-0.5 rounded-lg border border-slate-200">
                    <button
                      type="button"
                      onClick={() => {
                        setType("expense");
                        if (
                          members.length > 1 &&
                          selectedMembers.length <= 1
                        ) {
                          setSelectedMembers(members.map((m) => m.id));
                        }
                      }}
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
                          (selectedMembers.length !== 1 ||
                            selectedMembers[0] === effectivePayerId)
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

                {/* Prominent Scan / Attach Receipt Section (Strictly for Group Expenses) */}
                {type === "expense" && (
                  <div className="p-3.5 rounded-xl border border-blue-200/80 bg-blue-50/40 space-y-2.5">
                    <input
                      ref={addReceiptCameraInputRef}
                      type="file"
                      accept="image/*"
                      capture="environment"
                      onChange={handleAddReceiptFileChange}
                      className="hidden"
                    />
                    <input
                      ref={addReceiptInputRef}
                      type="file"
                      accept="image/*"
                      onChange={handleAddReceiptFileChange}
                      className="hidden"
                    />
                    <input
                      ref={addReceiptPdfInputRef}
                      type="file"
                      accept="application/pdf"
                      onChange={handleAddReceiptFileChange}
                      className="hidden"
                    />
                    <div className="flex items-center justify-between gap-2 flex-wrap">
                      <div className="flex items-center gap-2">
                        <div className="p-1.5 rounded-lg bg-blue-100 text-blue-700 shrink-0">
                          <Camera className="w-4 h-4" />
                        </div>
                        <div>
                          <span className="text-xs font-bold text-slate-900 block">
                            Scan / Attach Receipt
                          </span>
                          <span className="text-[11px] text-slate-500">
                            Take a photo, pick from your gallery, or attach a
                            PDF to auto-fill details
                          </span>
                        </div>
                      </div>
                      <div className="flex items-center gap-1.5 flex-wrap">
                        <button
                          type="button"
                          disabled={isScanningReceipt}
                          onClick={() =>
                            addReceiptCameraInputRef.current?.click()
                          }
                          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold bg-blue-600 hover:bg-blue-700 text-white shadow-2xs transition cursor-pointer disabled:opacity-60"
                        >
                          {isScanningReceipt ? (
                            <>
                              <Loader2 className="w-3.5 h-3.5 animate-spin" />
                              <span>Scanning...</span>
                            </>
                          ) : (
                            <>
                              <span>📷</span>
                              <span>Take Photo</span>
                            </>
                          )}
                        </button>
                        <button
                          type="button"
                          disabled={isScanningReceipt}
                          onClick={() => addReceiptInputRef.current?.click()}
                          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold bg-white hover:bg-blue-50 text-blue-700 border border-blue-200 shadow-2xs transition cursor-pointer disabled:opacity-60"
                        >
                          <span>🖼️</span>
                          <span>Photo Library</span>
                        </button>
                        <button
                          type="button"
                          disabled={isScanningReceipt}
                          onClick={() => addReceiptPdfInputRef.current?.click()}
                          title="Attach a PDF receipt"
                          className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-xs font-semibold bg-white hover:bg-blue-50 text-slate-700 border border-slate-200 shadow-2xs transition cursor-pointer disabled:opacity-60"
                        >
                          <span>📄</span>
                          <span>PDF</span>
                        </button>
                      </div>
                    </div>

                    {(receiptPreviewUrl ||
                      receiptUrl ||
                      isScanningReceipt ||
                      receiptScanError) && (
                      <div className="space-y-2 pt-2 border-t border-blue-100">
                        <div className="flex items-center justify-between gap-3">
                          <div className="flex items-center gap-3 min-w-0">
                            {receiptPreviewUrl &&
                            !isPdfReceiptUrl(receiptUrl || receiptPreviewUrl) &&
                            !receiptFileName.toLowerCase().endsWith(".pdf") ? (
                              <button
                                type="button"
                                onClick={() => {
                                  const targetUrl =
                                    receiptUrl || receiptPreviewUrl;
                                  if (targetUrl) {
                                    setViewingReceipt({
                                      url: targetUrl,
                                      title:
                                        description.trim() ||
                                        receiptFileName ||
                                        "Receipt Preview",
                                    });
                                  }
                                }}
                                title="Click to view full receipt"
                                className="relative w-12 h-12 rounded-lg overflow-hidden border border-slate-200 bg-white shrink-0 group cursor-pointer"
                              >
                                {/* eslint-disable-next-line @next/next/no-img-element */}
                                <img
                                  src={receiptPreviewUrl}
                                  alt="Receipt thumbnail"
                                  className="w-full h-full object-cover group-hover:opacity-90 transition"
                                />
                              </button>
                            ) : (
                              <div className="w-12 h-12 rounded-lg border border-slate-200 bg-white flex items-center justify-center text-blue-600 shrink-0">
                                <FileText className="w-5 h-5" />
                              </div>
                            )}
                            <div className="min-w-0">
                              <div className="text-xs font-semibold text-slate-800 truncate">
                                {receiptFileName || "Receipt attached"}
                              </div>
                              {isScanningReceipt ? (
                                <div className="text-[11px] text-blue-600 font-medium flex items-center gap-1 mt-0.5">
                                  <Loader2 className="w-3 h-3 animate-spin" />
                                  <span>Scanning receipt...</span>
                                </div>
                              ) : (
                                <div className="text-[11px] text-emerald-700 font-medium flex items-center gap-1.5 mt-0.5">
                                  <span>
                                    {receiptStatusMessage ||
                                      "Ready to save with transaction"}
                                  </span>
                                  {isUploadingReceipt && (
                                    <span className="text-[10px] text-slate-400 inline-flex items-center gap-1">
                                      <Loader2 className="w-2.5 h-2.5 animate-spin" />
                                      uploading...
                                    </span>
                                  )}
                                </div>
                              )}
                            </div>
                          </div>
                          <button
                            type="button"
                            onClick={handleRemoveAddReceipt}
                            title="Remove receipt"
                            className="p-1.5 rounded-lg text-slate-400 hover:text-red-600 hover:bg-red-50 transition cursor-pointer shrink-0"
                          >
                            <X className="w-4 h-4" />
                          </button>
                        </div>

                        {receiptScanError && (
                          <div className="p-2.5 rounded-lg bg-amber-50 border border-amber-200 text-[11px] text-amber-900 flex items-start gap-2">
                            <AlertCircle className="w-3.5 h-3.5 text-amber-600 shrink-0 mt-0.5" />
                            <span>{receiptScanError}</span>
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                )}

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <div>
                    <label className="text-xs font-semibold text-slate-600 block mb-1">
                      Paid By
                    </label>
                    <select
                      value={effectivePayerId}
                      onChange={(e) => {
                        const nextPayer = e.target.value;
                        setPayerId(nextPayer);
                        if (
                          type === "payment" &&
                          selectedMembers.includes(nextPayer)
                        ) {
                          const nextRecipient = members.find(
                            (m) => m.id !== nextPayer
                          );
                          setSelectedMembers(
                            nextRecipient ? [nextRecipient.id] : []
                          );
                        }
                      }}
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
                      {activeGroupCurrencies.length > 1
                        ? "Amount & Currency"
                        : `Amount (${currency})`}
                      {isExactMode ? " (Auto-Summed)" : ""}
                    </label>
                    <div className="flex gap-2">
                      <div className="relative flex-1">
                        <span className="absolute left-3 top-2 text-sm font-semibold text-slate-400">
                          {getCurrencySymbol(currency)}
                        </span>
                        <input
                          type="number"
                          step="0.01"
                          placeholder={isExactMode ? "Auto-summed" : "0.00"}
                          value={
                            isExactMode
                              ? exactSummary.totalSplitCents > 0
                                ? (exactSummary.totalSplitCents / 100).toFixed(2)
                                : ""
                              : amount
                          }
                          onChange={(e) => {
                            if (!isExactMode) {
                              setAmount(e.target.value);
                            }
                          }}
                          readOnly={isExactMode}
                          title={
                            isExactMode
                              ? "Automatically summed from individual $ Exact member amounts below"
                              : undefined
                          }
                          className={`w-full ${
                            getCurrencySymbol(currency).length > 1
                              ? "pl-9"
                              : "pl-7"
                          } pr-3 py-2 border border-slate-300 rounded-lg text-sm placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent transition ${
                            isExactMode
                              ? "bg-slate-50 text-slate-700 font-semibold cursor-default"
                              : "bg-white text-slate-900"
                          }`}
                          required={!isExactMode}
                        />
                      </div>
                      {activeGroupCurrencies.length > 1 && (
                        <select
                          value={normalizeCurrencyCode(currency)}
                          onChange={(e) => setCurrency(e.target.value)}
                          aria-label="Transaction currency"
                          className="border border-slate-300 rounded-lg px-2.5 py-2 text-xs font-bold text-slate-800 bg-slate-50 hover:bg-slate-100 focus:outline-none focus:ring-2 focus:ring-blue-500 transition cursor-pointer shrink-0"
                        >
                          {activeGroupCurrencies.map((code) => {
                            const info = getCurrencyInfo(code);
                            return (
                              <option key={info.code} value={info.code}>
                                {info.symbol} {info.code}
                              </option>
                            );
                          })}
                        </select>
                      )}
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
                      placeholder={
                        type === "payment"
                          ? "e.g. Settlement payment (optional)"
                          : "e.g. Dinner, Fuel, Groceries, Green Fees"
                      }
                      value={description}
                      onChange={(e) => setDescription(e.target.value)}
                      className="w-full border border-slate-300 rounded-lg p-2 text-sm text-slate-900 placeholder:text-slate-400 bg-white focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent transition"
                      required={type === "expense"}
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

                {/* Category Selector (Strictly for Group Expenses; payments automatically use 'Payment') */}
                {type === "expense" && (
                  <div className="space-y-2">
                    <label className="text-xs font-semibold text-slate-600 block">
                      Category
                    </label>
                    <div className="flex flex-wrap gap-1.5">
                      {groupCategories.map((cat) => {
                        const isSelected = !isCustomCategory && category === cat;
                        return (
                          <button
                            key={cat}
                            type="button"
                            onClick={() => {
                              setIsCustomCategory(false);
                              setCategory(cat);
                            }}
                            className={`px-2.5 py-1 rounded-full text-xs font-semibold border transition cursor-pointer ${
                              isSelected
                                ? "bg-blue-600 text-white border-blue-600 shadow-2xs"
                                : "bg-slate-50 text-slate-700 border-slate-200 hover:bg-slate-100"
                            }`}
                          >
                            {cat}
                          </button>
                        );
                      })}
                      <button
                        type="button"
                        onClick={() => {
                          setIsCustomCategory(true);
                          if (
                            !customCategoryInput &&
                            !EXPENSE_CATEGORIES.includes(
                              category as (typeof EXPENSE_CATEGORIES)[number]
                            )
                          ) {
                            setCustomCategoryInput(category);
                          }
                        }}
                        className={`px-2.5 py-1 rounded-full text-xs font-semibold border transition cursor-pointer ${
                          isCustomCategory
                            ? "bg-blue-600 text-white border-blue-600 shadow-2xs"
                            : "bg-white text-blue-600 border-dashed border-blue-300 hover:bg-blue-50"
                        }`}
                      >
                        + Custom...
                      </button>
                    </div>
                    {isCustomCategory && (
                      <div className="pt-0.5">
                        <input
                          type="text"
                          value={customCategoryInput}
                          onChange={(e) => {
                            setCustomCategoryInput(e.target.value);
                            setCategory(e.target.value);
                          }}
                          placeholder="Custom category (e.g. Golf, Ski Passes, Tolls)"
                          autoFocus
                          className="w-full border border-blue-300 rounded-lg px-3 py-1.5 text-xs text-slate-900 bg-white focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent transition"
                        />
                      </div>
                    )}
                  </div>
                )}

                {/* Split Mode (Equal | % Percentage | $ Exact) & Participants */}
                <div className="space-y-3">
                  <div className="flex items-center justify-between flex-wrap gap-2">
                    <label className="text-xs font-semibold text-slate-600">
                      {type === "expense"
                        ? splitMode === "equal"
                          ? `Split Among (${selectedMembers.length} selected)`
                          : splitMode === "percentage"
                            ? "Split by Percentage (%)"
                            : `Split by Exact Amount (${getCurrencySymbol(currency)})`
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
                          onClick={() => {
                            setSplitMode("exact");
                            if (exactSummary.totalSplitCents > 0) {
                              setAmount(
                                (exactSummary.totalSplitCents / 100).toFixed(2)
                              );
                            }
                          }}
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
                          const isSelfPayment =
                            type === "payment" && m.id === effectivePayerId;
                          return (
                            <button
                              type="button"
                              key={m.id}
                              disabled={isSelfPayment}
                              onClick={() => {
                                if (type === "payment") {
                                  if (m.id !== effectivePayerId) {
                                    setSelectedMembers([m.id]);
                                  }
                                } else {
                                  setSelectedMembers((prev) =>
                                    prev.includes(m.id)
                                      ? prev.filter((id) => id !== m.id)
                                      : [...prev, m.id]
                                  );
                                }
                              }}
                              className={`px-3 py-1.5 rounded-full text-xs font-medium border transition flex items-center gap-1.5 ${
                                isSelfPayment
                                  ? "bg-slate-100 text-slate-400 border-slate-200 cursor-not-allowed opacity-60"
                                  : isSelected
                                    ? "bg-blue-600 text-white border-blue-600 shadow-xs cursor-pointer"
                                    : "bg-white text-slate-700 border-slate-200 hover:bg-slate-50 cursor-pointer"
                              }`}
                            >
                              <span>{m.name}</span>
                              {isSelected && !isSelfPayment && (
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
                            {getCurrencySymbol(currency)}
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
                                    {formatCurrency(allocCents, currency)}
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
                                {getCurrencySymbol(currency)}
                              </span>
                              <input
                                type="number"
                                step="0.01"
                                min="0"
                                placeholder="0.00"
                                value={exactValues[m.id] ?? ""}
                                onChange={(e) => {
                                  const nextVal = e.target.value;
                                  const nextExact = {
                                    ...exactValues,
                                    [m.id]: nextVal,
                                  };
                                  setExactValues(nextExact);
                                  let nextSumCents = 0;
                                  for (const mem of members) {
                                    const parsed = parseFloat(
                                      nextExact[mem.id] || "0"
                                    );
                                    if (!isNaN(parsed) && parsed > 0) {
                                      nextSumCents += Math.round(parsed * 100);
                                    }
                                  }
                                  setAmount(
                                    nextSumCents > 0
                                      ? (nextSumCents / 100).toFixed(2)
                                      : ""
                                  );
                                }}
                                className={`w-full ${
                                  getCurrencySymbol(currency).length > 1
                                    ? "pl-7"
                                    : "pl-6"
                                } pr-2 py-1 border border-slate-300 rounded-lg text-xs text-right text-slate-900 bg-white focus:outline-none focus:ring-2 focus:ring-blue-500`}
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
                            Auto-Summed Total:{" "}
                            {formatCurrency(
                              exactSummary.totalSplitCents,
                              currency
                            )}
                          </span>
                        </span>
                        <span className="font-bold">
                          {exactSummary.valid
                            ? `${exactSummary.splits.length} ${exactSummary.splits.length === 1 ? "person" : "people"} allocated`
                            : "Enter member amounts above"}
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
              )}

              {/* Ledger Table with Currency Isolation Filter and Group-Wide Editing */}
              <div className="bg-white border border-slate-200 rounded-2xl shadow-xs overflow-hidden">
                <div className="px-6 py-4 border-b border-slate-200 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                  <div>
                    <h3 className="font-bold text-sm text-slate-900">
                      Transaction History
                    </h3>
                    <p className="text-xs text-slate-400">
                      Showing {filteredExpenses.length} of {expenses.length}{" "}
                      records •{" "}
                      {activeGroup.is_archived
                        ? "Archived (Read-Only)"
                        : "Anyone with the group link can edit or delete"}
                    </p>
                  </div>

                  {/* Currency Segmented Tabs (Only shown when group has 2+ currencies) */}
                  {activeGroupCurrencies.length > 1 && (
                    <div className="flex flex-wrap bg-slate-100 p-0.5 rounded-lg border border-slate-200 text-xs">
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
                      {activeGroupCurrencies.map((code) => {
                        const count = expenses.filter(
                          (e) => normalizeCurrencyCode(e.currency) === code
                        ).length;
                        const sym = getCurrencySymbol(code);
                        return (
                          <button
                            key={code}
                            type="button"
                            onClick={() => setHistoryCurrencyFilter(code)}
                            className={`px-2.5 py-1 rounded-md font-semibold transition cursor-pointer ${
                              historyCurrencyFilter === code
                                ? "bg-white text-blue-700 shadow-2xs"
                                : "text-slate-500 hover:text-slate-800"
                            }`}
                          >
                            {sym} {code} ({count})
                          </button>
                        );
                      })}
                    </div>
                  )}
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
                      const expFormatted = formatCurrency(
                        exp.amountCents,
                        exp.currency
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
                              <div className="flex items-center gap-2 flex-wrap">
                                <span className="font-semibold text-slate-900 truncate">
                                  {exp.description}
                                </span>
                                {!isPayment && (
                                  <span className="inline-flex items-center px-2 py-0.5 rounded-md text-[10px] font-semibold bg-slate-100 text-slate-600 border border-slate-200/80 shrink-0">
                                    {exp.category || "General"}
                                  </span>
                                )}
                                {exp.receiptUrl && (
                                  <button
                                    type="button"
                                    onClick={() =>
                                      setViewingReceipt({
                                        url: exp.receiptUrl!,
                                        title: exp.description || "Receipt",
                                        date: formatTransactionDate(exp.date),
                                        amountFormatted: expFormatted,
                                      })
                                    }
                                    title="View attached receipt"
                                    className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[10px] font-semibold bg-blue-50 text-blue-700 hover:bg-blue-100 border border-blue-200 transition cursor-pointer shrink-0"
                                  >
                                    <Receipt className="w-3 h-3" />
                                    <span>Receipt</span>
                                  </button>
                                )}
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
                                {expFormatted}
                              </span>
                              <span
                                className={`block text-[10px] uppercase font-bold tracking-wider mt-0.5 ${
                                  isPayment ? "text-blue-700" : "text-rose-600"
                                }`}
                              >
                                {exp.type}
                              </span>
                            </div>

                            {/* Group-Wide Transaction Edit & Delete Actions (Hidden when archived) */}
                            {!activeGroup.is_archived && (
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
                            )}
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

        {/* Multi-Currency & Unified Settlement Minimization Plan */}
        <aside className="bg-white border border-slate-200 p-6 rounded-2xl shadow-xs h-fit space-y-4">
          <div className="space-y-2">
            <div className="flex items-center justify-between gap-2">
              <h2 className="font-bold text-slate-900 text-base flex items-center gap-2">
                <Wallet className="w-4 h-4 text-blue-600" />
                Settlement Plan
              </h2>
            </div>
            <p className="text-xs text-slate-500">
              {hasMultipleCurrencies && isUnifiedMode
                ? `Unified cross-currency cash-flow minimization converted into ${unifiedTargetCurrency}.`
                : "Greedy cash-flow minimization pairing largest debtors with largest creditors."}
            </p>

            {/* 🌐 Unified Settlement (Convert All) Toggle & Exchange Rate Controls */}
            {hasMultipleCurrencies && (
              <div className="pt-1 space-y-2.5">
                <button
                  type="button"
                  onClick={() => setIsUnifiedMode((prev) => !prev)}
                  className={`w-full py-2 px-3 rounded-xl text-xs font-bold border transition flex items-center justify-center gap-1.5 cursor-pointer ${
                    isUnifiedMode
                      ? "bg-emerald-600 text-white border-emerald-600 shadow-2xs"
                      : "bg-emerald-50/70 hover:bg-emerald-100/80 text-emerald-900 border-emerald-200"
                  }`}
                >
                  <Globe className="w-3.5 h-3.5 shrink-0" />
                  <span>
                    {isUnifiedMode
                      ? "🌐 Unified Settlement Active"
                      : "🌐 Unified Settlement (Convert All)"}
                  </span>
                </button>

                {isUnifiedMode && (
                  <div className="p-3 bg-slate-50 border border-slate-200 rounded-xl space-y-3 text-xs">
                    <div className="flex items-center justify-between gap-2">
                      <label className="font-semibold text-slate-700">
                        Settle All In:
                      </label>
                      <select
                        value={normalizeCurrencyCode(unifiedTargetCurrency)}
                        onChange={(e) =>
                          handleSelectUnifiedTargetCurrency(e.target.value)
                        }
                        className="border border-slate-300 rounded-lg px-2 py-1 text-xs font-bold text-slate-900 bg-white focus:outline-none focus:ring-2 focus:ring-emerald-500 cursor-pointer"
                      >
                        {activeGroupCurrencies.map((code) => (
                          <option key={code} value={code}>
                            {code} ({getCurrencySymbol(code)})
                          </option>
                        ))}
                      </select>
                    </div>

                    <div className="space-y-2 pt-2 border-t border-slate-200/80">
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-[11px] font-semibold text-slate-600">
                          Exchange Rates
                        </span>
                        <button
                          type="button"
                          disabled={isFetchingRates}
                          onClick={handleFetchLiveRates}
                          className="inline-flex items-center gap-1 px-2 py-1 rounded-md text-[11px] font-semibold bg-white hover:bg-blue-50 text-blue-700 border border-blue-200 transition cursor-pointer disabled:opacity-50"
                        >
                          <RefreshCw
                            className={`w-3 h-3 ${
                              isFetchingRates ? "animate-spin" : ""
                            }`}
                          />
                          <span>
                            {isFetchingRates
                              ? "Fetching..."
                              : "Fetch Live Rates"}
                          </span>
                        </button>
                      </div>

                      <div className="space-y-1.5">
                        {activeGroupCurrencies
                          .filter(
                            (code) =>
                              code !==
                              normalizeCurrencyCode(unifiedTargetCurrency)
                          )
                          .map((otherCode) => (
                            <div
                              key={otherCode}
                              className="flex items-center justify-between gap-2 bg-white px-2.5 py-1.5 rounded-lg border border-slate-200"
                            >
                              <span className="text-[11px] font-medium text-slate-600 shrink-0">
                                1 {unifiedTargetCurrency} =
                              </span>
                              <div className="flex items-center gap-1.5">
                                <input
                                  type="number"
                                  step="any"
                                  min="0.000001"
                                  value={
                                    exchangeRatesInput[otherCode] ??
                                    String(
                                      numericExchangeRates[otherCode] ?? 1
                                    )
                                  }
                                  onChange={(e) =>
                                    setExchangeRatesInput((prev) => ({
                                      ...prev,
                                      [otherCode]: e.target.value,
                                    }))
                                  }
                                  className="w-20 border border-slate-300 rounded-md px-1.5 py-0.5 text-right text-xs font-bold text-slate-900 focus:outline-none focus:ring-2 focus:ring-emerald-500"
                                />
                                <span className="text-[11px] font-bold text-slate-700 w-8">
                                  {otherCode}
                                </span>
                              </div>
                            </div>
                          ))}
                      </div>

                      {!activeGroup?.is_archived && (
                        <button
                          type="button"
                          disabled={isSavingRates}
                          onClick={handleSaveExchangeRates}
                          className="w-full py-1.5 rounded-lg text-[11px] font-semibold bg-slate-900 hover:bg-slate-800 text-white transition cursor-pointer disabled:opacity-50"
                        >
                          {isSavingRates
                            ? "Saving Rates..."
                            : "Save Exchange Rates"}
                        </button>
                      )}
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>

          {hasMultipleCurrencies && isUnifiedMode ? (
            <div className="space-y-2 pt-3 border-t border-slate-100">
              <div className="flex items-center justify-between text-xs font-bold text-emerald-900">
                <span className="flex items-center gap-1.5">
                  <span className="w-2 h-2 rounded-full bg-emerald-600"></span>
                  Unified ({unifiedTargetCurrency}) Plan
                </span>
                <span className="text-[10px] font-semibold text-slate-400 uppercase tracking-wider">
                  {unifiedResult.settlements.length === 0
                    ? "Settled"
                    : `${unifiedResult.settlements.length} transfer(s)`}
                </span>
              </div>

              {unifiedResult.settlements.length === 0 ? (
                <div className="p-3 bg-slate-50 rounded-xl text-xs text-slate-400 italic text-center">
                  All combined cross-currency debts are settled up.
                </div>
              ) : (
                unifiedResult.settlements.map((s, idx) => {
                  const otherCodes = activeGroupCurrencies.filter(
                    (c) => c !== normalizeCurrencyCode(unifiedTargetCurrency)
                  );
                  const secondaryEquivalents = otherCodes
                    .map((otherCode) => {
                      const rate = numericExchangeRates[otherCode];
                      if (!rate || rate <= 0) return null;
                      const eqCents = Math.round(s.amountCents * rate);
                      return formatCurrency(eqCents, otherCode);
                    })
                    .filter(Boolean);

                  return (
                    <div
                      key={idx}
                      className="p-3 bg-emerald-50/60 border border-emerald-200 rounded-xl text-xs space-y-1.5"
                    >
                      <div className="flex items-start justify-between gap-2">
                        <div className="space-y-1 min-w-0">
                          <div className="text-slate-700">
                            <span className="font-bold text-slate-900">
                              {s.fromUser}
                            </span>{" "}
                            pays{" "}
                            <span className="font-bold text-slate-900">
                              {s.toUser}
                            </span>
                          </div>
                          <div className="text-sm font-bold text-emerald-800 flex items-baseline gap-1.5 flex-wrap">
                            <span>
                              {formatCurrency(
                                s.amountCents,
                                unifiedTargetCurrency
                              )}
                            </span>
                            {secondaryEquivalents.length > 0 && (
                              <span className="text-[11px] font-medium text-emerald-700/80">
                                (≈ {secondaryEquivalents.join(" • ")})
                              </span>
                            )}
                          </div>
                        </div>

                        {!activeGroup?.is_archived && (
                          <button
                            type="button"
                            onClick={() =>
                              handleQuickSettle(s, unifiedTargetCurrency)
                            }
                            title={`Pre-fill settlement payment from ${s.fromUser} to ${s.toUser}`}
                            className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg text-[11px] font-bold bg-emerald-600 hover:bg-emerald-700 text-white shadow-2xs transition cursor-pointer shrink-0"
                          >
                            <CheckCircle2 className="w-3 h-3" />
                            <span>Settle</span>
                          </button>
                        )}
                      </div>
                    </div>
                  );
                })
              )}
            </div>
          ) : (
            displayCurrencies.map((code, idx) => {
              const list = settlementsByCurrency[code] || [];
              const sym = getCurrencySymbol(code);
              const isSecondary = idx % 2 === 1;
              return (
                <div
                  key={code}
                  className="space-y-2 pt-3 border-t border-slate-100"
                >
                  <div className="flex items-center justify-between text-xs font-bold text-slate-800">
                    <span className="flex items-center gap-1.5">
                      <span
                        className={`w-2 h-2 rounded-full ${
                          isSecondary ? "bg-indigo-600" : "bg-blue-600"
                        }`}
                      ></span>
                      {code} ({sym}) Ledger
                    </span>
                    <span className="text-[10px] font-semibold text-slate-400 uppercase tracking-wider">
                      {list.length === 0
                        ? "Settled"
                        : `${list.length} transfer(s)`}
                    </span>
                  </div>

                  {list.length === 0 ? (
                    <div className="p-3 bg-slate-50 rounded-xl text-xs text-slate-400 italic text-center">
                      All {code} debts are settled up.
                    </div>
                  ) : (
                    list.map((s, sIdx) => (
                      <div
                        key={sIdx}
                        className={`p-3 rounded-xl text-xs space-y-1 border ${
                          isSecondary
                            ? "bg-indigo-50/50 border-indigo-100"
                            : "bg-blue-50/50 border-blue-100"
                        }`}
                      >
                        <div className="flex items-start justify-between gap-2">
                          <div className="space-y-1 min-w-0">
                            <div className="text-slate-700">
                              <span className="font-bold text-slate-900">
                                {s.fromUser}
                              </span>{" "}
                              pays{" "}
                              <span className="font-bold text-slate-900">
                                {s.toUser}
                              </span>
                            </div>
                            <div
                              className={`text-sm font-bold ${
                                isSecondary
                                  ? "text-indigo-700"
                                  : "text-blue-700"
                              }`}
                            >
                              {formatCurrency(s.amountCents, code)}
                            </div>
                          </div>

                          {!activeGroup?.is_archived && (
                            <button
                              type="button"
                              onClick={() => handleQuickSettle(s, code)}
                              title={`Pre-fill settlement payment from ${s.fromUser} to ${s.toUser}`}
                              className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-lg text-[11px] font-bold text-white shadow-2xs transition cursor-pointer shrink-0 ${
                                isSecondary
                                  ? "bg-indigo-600 hover:bg-indigo-700"
                                  : "bg-blue-600 hover:bg-blue-700"
                              }`}
                            >
                              <CheckCircle2 className="w-3 h-3" />
                              <span>Settle</span>
                            </button>
                          )}
                        </div>
                      </div>
                    ))
                  )}
                </div>
              );
            })
          )}

          {/* Spend by Category Breakdown (Per Currency, Strictly Expenses) */}
          {activeGroup && (
            <div className="space-y-4 pt-4 border-t border-slate-200">
              <div>
                <h2 className="font-bold text-slate-900 text-base flex items-center gap-2">
                  <Tag className="w-4 h-4 text-blue-600" />
                  Spend by Category
                </h2>
                <p className="text-xs text-slate-500 mt-0.5">
                  Group expenses aggregated by category (excludes settlement
                  payments).
                </p>
              </div>

              {displayCurrencies.map((code, idx) => {
                const catList = categorySpendByCurrency[code] || [];
                const sym = getCurrencySymbol(code);
                const isSecondary = idx % 2 === 1;
                if (idx > 0 && catList.length === 0) return null;

                return (
                  <div
                    key={code}
                    className={`space-y-2.5 ${
                      idx > 0 ? "pt-3 border-t border-slate-100" : ""
                    }`}
                  >
                    {displayCurrencies.length > 1 && (
                      <div className="text-xs font-bold text-slate-800 flex items-center gap-1.5">
                        <span
                          className={`w-2 h-2 rounded-full ${
                            isSecondary ? "bg-indigo-600" : "bg-blue-600"
                          }`}
                        ></span>
                        {code} ({sym}) Categories
                      </div>
                    )}

                    {catList.length === 0 ? (
                      <div className="p-3 bg-slate-50 rounded-xl text-xs text-slate-400 italic text-center">
                        No {code} expenses recorded yet.
                      </div>
                    ) : (
                      <div className="space-y-2.5">
                        {catList.map((c) => (
                          <div key={c.category} className="space-y-1 text-xs">
                            <div className="flex items-center justify-between gap-2">
                              <span className="font-semibold text-slate-800 truncate">
                                {c.category}
                              </span>
                              <span className="text-slate-600 font-medium shrink-0">
                                <strong className="text-slate-900">
                                  {formatCurrency(c.amountCents, code)}
                                </strong>{" "}
                                <span className="text-[11px] text-slate-400">
                                  ({c.percentage.toFixed(1)}%)
                                </span>
                              </span>
                            </div>
                            <div className="w-full h-1.5 bg-slate-100 rounded-full overflow-hidden">
                              <div
                                className={`h-full rounded-full transition-all ${
                                  isSecondary ? "bg-indigo-600" : "bg-blue-600"
                                }`}
                                style={{
                                  width: `${Math.min(100, Math.max(2, c.percentage))}%`,
                                }}
                              />
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </aside>
      </div>
      )}

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

      {/* Manage Group Currencies Modal (Super-Admin Only) */}
      {isSuperAdmin && isCurrencyModalOpen && activeGroup && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/60 backdrop-blur-xs">
          <div className="bg-white border border-slate-200 rounded-2xl shadow-2xl max-w-md w-full p-6 space-y-4">
            <div className="flex items-start justify-between">
              <div className="flex items-center gap-3">
                <div className="p-2.5 bg-blue-50 text-blue-600 rounded-xl">
                  <Globe className="w-5 h-5" />
                </div>
                <div>
                  <h2 className="text-lg font-bold text-slate-900">
                    Manage Group Currencies
                  </h2>
                  <p className="text-xs text-slate-500">
                    Enable travel currencies for &ldquo;{activeGroup.name}&rdquo;
                  </p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => setIsCurrencyModalOpen(false)}
                className="text-slate-400 hover:text-slate-600 p-1.5 rounded-lg hover:bg-slate-100 transition cursor-pointer"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <form onSubmit={handleSaveGroupCurrencies} className="space-y-4">
              <div className="space-y-2">
                <label className="text-xs font-semibold text-slate-600 block">
                  Enabled Currencies (tap to toggle)
                </label>
                <div className="flex flex-wrap gap-1.5">
                  {Array.from(
                    new Set([
                      ...SUPPORTED_CURRENCIES.map((c) => c.code),
                      ...editingGroupCurrencies,
                    ])
                  ).map((code) => {
                    const info = getCurrencyInfo(code);
                    const isSelected = editingGroupCurrencies.includes(
                      info.code
                    );
                    return (
                      <button
                        key={info.code}
                        type="button"
                        onClick={() => {
                          setEditingGroupCurrencies((prev) => {
                            if (prev.includes(info.code)) {
                              if (prev.length === 1) return prev;
                              const next = prev.filter((c) => c !== info.code);
                              if (editingDefaultCurrency === info.code) {
                                setEditingDefaultCurrency(next[0] || "USD");
                              }
                              return next;
                            }
                            return [...prev, info.code];
                          });
                        }}
                        className={`px-3 py-1.5 rounded-xl text-xs font-semibold border transition cursor-pointer flex items-center gap-1.5 ${
                          isSelected
                            ? "bg-blue-600 text-white border-blue-600 shadow-2xs"
                            : "bg-slate-50 text-slate-700 border-slate-200 hover:bg-slate-100"
                        }`}
                      >
                        <span>{info.symbol}</span>
                        <span>{info.code}</span>
                      </button>
                    );
                  })}
                </div>
              </div>

              {/* Custom 3-Letter ISO Currency Code Input */}
              <div className="space-y-1.5">
                <label className="text-xs font-semibold text-slate-600 block">
                  Add Custom 3-Letter ISO Currency (optional)
                </label>
                <div className="flex gap-2">
                  <input
                    type="text"
                    maxLength={3}
                    placeholder="e.g. SGD, HKD, ZAR"
                    value={customIsoInput}
                    onChange={(e) =>
                      setCustomIsoInput(e.target.value.toUpperCase())
                    }
                    className="flex-1 border border-slate-300 rounded-lg px-3 py-1.5 text-xs font-mono uppercase text-slate-900 bg-white focus:outline-none focus:ring-2 focus:ring-blue-500"
                  />
                  <button
                    type="button"
                    onClick={() => {
                      const clean = customIsoInput.trim().toUpperCase();
                      if (/^[A-Z]{3}$/.test(clean)) {
                        setEditingGroupCurrencies((prev) =>
                          prev.includes(clean) ? prev : [...prev, clean]
                        );
                        setCustomIsoInput("");
                      }
                    }}
                    className="px-3 py-1.5 rounded-lg text-xs font-semibold bg-slate-100 hover:bg-slate-200 text-slate-700 border border-slate-200 cursor-pointer"
                  >
                    + Add ISO
                  </button>
                </div>
              </div>

              <div className="space-y-1.5">
                <label className="text-xs font-semibold text-slate-600 block">
                  Default Currency for New Transactions
                </label>
                <select
                  value={editingDefaultCurrency}
                  onChange={(e) => setEditingDefaultCurrency(e.target.value)}
                  className="w-full border border-slate-300 rounded-lg p-2 text-xs font-bold text-slate-900 bg-white focus:outline-none focus:ring-2 focus:ring-blue-500"
                >
                  {editingGroupCurrencies.map((code) => {
                    const info = getCurrencyInfo(code);
                    return (
                      <option key={info.code} value={info.code}>
                        {info.label}
                      </option>
                    );
                  })}
                </select>
              </div>

              <div className="pt-2 border-t border-slate-100 flex items-center justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setIsCurrencyModalOpen(false)}
                  className="px-4 py-2 text-xs font-semibold text-slate-600 hover:bg-slate-100 rounded-xl transition cursor-pointer"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={isSavingCurrencies}
                  className="px-4 py-2 text-xs font-semibold bg-blue-600 hover:bg-blue-700 text-white rounded-xl transition cursor-pointer shadow-xs disabled:opacity-50"
                >
                  {isSavingCurrencies ? "Saving..." : "Save Currencies"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

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
          groupId={activeGroupId}
          members={members}
          existingCategories={groupCategories}
          groupCurrencies={activeGroupCurrencies}
          onCurrencyAdded={(code) => {
            ensureCurrenciesInGroup([code]);
          }}
          onViewReceipt={(url, title) =>
            setViewingReceipt({
              url,
              title: title || editingExpense.description || "Receipt",
              date: formatTransactionDate(editingExpense.date),
              amountFormatted: formatCurrency(
                editingExpense.amountCents,
                editingExpense.currency
              ),
            })
          }
          onSaved={() => {
            if (activeGroupId) {
              refreshExpenses(activeGroupId);
            }
          }}
        />
      )}

      {/* Receipt Viewer Lightbox Modal */}
      <dialog
        ref={receiptLightboxRef}
        closedby="any"
        aria-labelledby="receipt-lightbox-title"
        onClick={handleReceiptLightboxBackdropClick}
        onCancel={(e) => {
          e.preventDefault();
          setViewingReceipt(null);
        }}
        className="m-auto p-0 rounded-2xl shadow-2xl border border-slate-200 bg-white max-w-2xl w-full backdrop:bg-slate-900/70 backdrop:backdrop-blur-xs open:animate-in open:fade-in-0 open:zoom-in-95"
      >
        {viewingReceipt && (
          <div className="flex flex-col max-h-[90vh]">
            <div className="flex items-center justify-between gap-3 px-5 py-4 border-b border-slate-200">
              <div className="min-w-0">
                <h2
                  id="receipt-lightbox-title"
                  className="text-sm font-bold text-slate-900 truncate"
                >
                  {viewingReceipt.title}
                </h2>
                {(viewingReceipt.date || viewingReceipt.amountFormatted) && (
                  <p className="text-xs text-slate-500 mt-0.5">
                    {[viewingReceipt.date, viewingReceipt.amountFormatted]
                      .filter(Boolean)
                      .join(" • ")}
                  </p>
                )}
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <a
                  href={viewingReceipt.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold bg-slate-100 hover:bg-slate-200 text-slate-800 transition"
                >
                  <ExternalLink className="w-3.5 h-3.5" />
                  <span>Open in New Tab</span>
                </a>
                <button
                  type="button"
                  onClick={() => setViewingReceipt(null)}
                  aria-label="Close receipt viewer"
                  className="p-1.5 text-slate-400 hover:text-slate-700 hover:bg-slate-100 rounded-lg transition cursor-pointer"
                >
                  <X className="w-5 h-5" />
                </button>
              </div>
            </div>

            <div className="p-5 bg-slate-50 overflow-y-auto flex-1 flex flex-col items-center justify-center min-h-[280px]">
              {isPdfReceiptUrl(viewingReceipt.url) ? (
                <div className="w-full space-y-4 text-center py-6">
                  <div className="w-16 h-16 rounded-2xl bg-blue-50 border border-blue-200 text-blue-600 flex items-center justify-center mx-auto">
                    <FileText className="w-8 h-8" />
                  </div>
                  <div className="space-y-1">
                    <p className="text-sm font-bold text-slate-900">
                      PDF Receipt Document
                    </p>
                    <p className="text-xs text-slate-500">
                      View the embedded document below or open it in a new
                      browser tab.
                    </p>
                  </div>
                  <iframe
                    src={viewingReceipt.url}
                    title={viewingReceipt.title}
                    className="w-full h-[55vh] rounded-xl border border-slate-200 bg-white"
                  />
                  <div>
                    <a
                      href={viewingReceipt.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-2 px-4 py-2 rounded-xl text-xs font-semibold bg-blue-600 hover:bg-blue-700 text-white shadow-xs transition"
                    >
                      <ExternalLink className="w-3.5 h-3.5" />
                      <span>Open PDF in New Tab</span>
                    </a>
                  </div>
                </div>
              ) : (
                /* eslint-disable-next-line @next/next/no-img-element */
                <img
                  src={viewingReceipt.url}
                  alt={viewingReceipt.title}
                  className="max-w-full max-h-[72vh] w-auto h-auto object-contain rounded-xl border border-slate-200 bg-white shadow-xs"
                />
              )}
            </div>
          </div>
        )}
      </dialog>
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
