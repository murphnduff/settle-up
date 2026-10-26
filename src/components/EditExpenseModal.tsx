"use client";

import { useState, useEffect, useRef, useMemo } from "react";
import { createClient } from "@/lib/supabase";
import {
  splitAmountEqually,
  splitAmountByPercentage,
  validateExactSplits,
  buildGroupCategories,
} from "@/lib/reconciliation";
import { GroupMember } from "@/components/MemberInviteModal";
import {
  normalizeCurrencyCode,
  getCurrencySymbol,
  getCurrencyInfo,
  buildGroupCurrencies,
} from "@/lib/currencies";
import {
  compressReceiptFile,
  uploadReceiptToStorage,
  parseReceiptWithAi,
  isPdfReceiptUrl,
} from "@/lib/receipts";
import {
  X,
  Sparkles,
  AlertCircle,
  Edit3,
  CheckCircle2,
  Plus,
  Camera,
  FileText,
  ExternalLink,
  Loader2,
  Trash2,
} from "lucide-react";

export type SplitMode = "equal" | "percentage" | "exact";

export function getTodayLocalDate(): string {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function formatTransactionDate(dateStr?: string): string {
  if (!dateStr) return "";
  const clean = dateStr.split("T")[0];
  const parts = clean.split("-");
  if (parts.length === 3) {
    const year = Number(parts[0]);
    const month = Number(parts[1]) - 1;
    const day = Number(parts[2]);
    const localDate = new Date(year, month, day);
    if (!isNaN(localDate.getTime())) {
      return localDate.toLocaleDateString("en-US", {
        month: "short",
        day: "numeric",
        year: "numeric",
      });
    }
  }
  return clean;
}

export interface ExpenseItem {
  id: string;
  groupId?: string;
  paidByMemberId?: string;
  payerId?: string;
  description: string;
  amount: number;
  amountCents: number;
  currency: string;
  type: "expense" | "payment";
  category?: string;
  receiptUrl?: string | null;
  date: string;
  createdAt?: string;
  createdBy?: string;
  splits: Array<{
    memberId: string;
    userId?: string;
    amount: number;
    splitAmountCents: number;
  }>;
}

interface EditExpenseModalProps {
  isOpen: boolean;
  onClose: () => void;
  expense: ExpenseItem | null;
  groupId?: string;
  members: GroupMember[];
  groupCurrencies?: string[];
  existingCategories?: string[];
  onCurrencyAdded?: (currencyCode: string) => void;
  onViewReceipt?: (url: string, title?: string) => void;
  onSaved: () => void;
}

function detectInitialSplitMode(expense: ExpenseItem | null): SplitMode {
  if (!expense || expense.type === "payment" || expense.splits.length === 0) {
    return "equal";
  }
  const memberIds = expense.splits.map((s) => s.memberId);
  const equalReference = splitAmountEqually(expense.amountCents, memberIds);
  if (equalReference.length !== expense.splits.length) return "exact";

  const refCounts = new Map<number, number>();
  for (const r of equalReference) {
    refCounts.set(r.splitAmountCents, (refCounts.get(r.splitAmountCents) || 0) + 1);
  }
  for (const s of expense.splits) {
    const count = refCounts.get(s.splitAmountCents) || 0;
    if (count <= 0) return "exact";
    refCounts.set(s.splitAmountCents, count - 1);
  }
  return "equal";
}

export default function EditExpenseModal({
  isOpen,
  onClose,
  expense,
  groupId,
  members,
  groupCurrencies = ["USD"],
  existingCategories = [],
  onCurrencyAdded,
  onViewReceipt,
  onSaved,
}: EditExpenseModalProps) {
  const supabase = createClient();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const receiptCameraInputRef = useRef<HTMLInputElement>(null);
  const receiptFileInputRef = useRef<HTMLInputElement>(null);
  const receiptPdfInputRef = useRef<HTMLInputElement>(null);

  const [description, setDescription] = useState(expense?.description ?? "");
  const [amount, setAmount] = useState(
    expense ? (expense.amountCents / 100).toFixed(2) : ""
  );
  const [currency, setCurrency] = useState<string>(() =>
    normalizeCurrencyCode(expense?.currency)
  );
  const currencySymbol = getCurrencySymbol(currency);
  const availableCurrencies = useMemo(
    () =>
      buildGroupCurrencies(
        groupCurrencies,
        currency,
        expense ? [{ currency: expense.currency }] : []
      ),
    [groupCurrencies, currency, expense]
  );
  const [type, setType] = useState<"expense" | "payment">(
    expense?.type === "payment" ? "payment" : "expense"
  );
  const [category, setCategory] = useState<string>(() => {
    if (!expense || expense.type === "payment") return "General";
    const trimmed = (expense.category || "").trim();
    return trimmed && trimmed.toLowerCase() !== "payment" ? trimmed : "General";
  });
  const [payerId, setPayerId] = useState(
    expense?.paidByMemberId || expense?.payerId || ""
  );
  const [date, setDate] = useState(
    expense?.date ? expense.date.split("T")[0] : getTodayLocalDate()
  );
  const [splitMode, setSplitMode] = useState<SplitMode>(() =>
    detectInitialSplitMode(expense)
  );
  const [selectedMembers, setSelectedMembers] = useState<string[]>(
    expense && expense.splits.length > 0
      ? expense.splits.map((s) => s.memberId)
      : members.map((m) => m.id)
  );
  const [percentageValues, setPercentageValues] = useState<
    Record<string, string>
  >(() => {
    const init: Record<string, string> = {};
    if (expense && expense.amountCents > 0) {
      for (const s of expense.splits) {
        init[s.memberId] = (
          (s.splitAmountCents / expense.amountCents) *
          100
        ).toFixed(2);
      }
    }
    return init;
  });
  const [exactValues, setExactValues] = useState<Record<string, string>>(() => {
    const init: Record<string, string> = {};
    if (expense) {
      for (const s of expense.splits) {
        init[s.memberId] = (s.splitAmountCents / 100).toFixed(2);
      }
    }
    return init;
  });

  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isCustomCategory, setIsCustomCategory] = useState(false);
  const [customCategoryInput, setCustomCategoryInput] = useState("");
  const [receiptUrl, setReceiptUrl] = useState<string | null>(
    expense?.receiptUrl ?? null
  );
  const [receiptPreviewUrl, setReceiptPreviewUrl] = useState<string | null>(
    expense?.receiptUrl ?? null
  );
  const [receiptFileName, setReceiptFileName] = useState<string>("");
  const [isScanningReceipt, setIsScanningReceipt] = useState(false);
  const [isUploadingReceipt, setIsUploadingReceipt] = useState(false);
  const [receiptStatusMessage, setReceiptStatusMessage] = useState<
    string | null
  >(null);
  const [receiptScanError, setReceiptScanError] = useState<string | null>(null);
  const [scannedCategories, setScannedCategories] = useState<string[]>([]);

  // Combine default preset categories with group-wide categories and current category
  const categoryOptions = useMemo(
    () =>
      buildGroupCategories([], [
        ...existingCategories,
        category,
        ...scannedCategories,
      ]),
    [existingCategories, category, scannedCategories]
  );

  const handleReceiptFileChange = async (
    e: React.ChangeEvent<HTMLInputElement>
  ) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;

    setError(null);
    setReceiptScanError(null);
    setReceiptFileName(file.name);
    setIsScanningReceipt(true);
    setIsUploadingReceipt(true);
    setReceiptStatusMessage("Scanning receipt...");

    try {
      const compressed = await compressReceiptFile(file);
      setReceiptPreviewUrl(compressed.previewUrl);

      const targetGroupId =
        groupId || expense?.groupId || members[0]?.groupId || "general";

      // 1. Trigger AI OCR immediately using the compact 1024px @ 0.70 payload and populate fields the instant it resolves
      const parseTask = parseReceiptWithAi(
        compressed.aiBase64,
        compressed.mimeType
      )
        .then((parsed) => {
          if (parsed.description) {
            setDescription(parsed.description);
          }
          if (parsed.currency) {
            const detectedCode = normalizeCurrencyCode(parsed.currency);
            setCurrency(detectedCode);
            onCurrencyAdded?.(detectedCode);
          }
          if (parsed.date) {
            setDate(parsed.date);
          }
          if (parsed.category) {
            const cleanScannedCat = parsed.category.trim();
            const existingMatch = categoryOptions.find(
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
            splitMode !== "exact"
          ) {
            setAmount(parsed.amount.toFixed(2));
          }
          setReceiptStatusMessage("Receipt scanned & fields updated!");
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

      // 2. Upload crisp 1600px @ 0.82 receipt to Supabase Storage in parallel
      const uploadTask = uploadReceiptToStorage(
        supabase,
        targetGroupId,
        compressed.blob,
        compressed.extension,
        compressed.mimeType
      )
        .then((uploadedUrl) => {
          setReceiptUrl(uploadedUrl);
        })
        .catch((err: unknown) => {
          const reason =
            err instanceof Error ? err.message : "Receipt upload failed.";
          setError(reason);
        })
        .finally(() => {
          setIsUploadingReceipt(false);
        });

      await Promise.all([parseTask, uploadTask]);
    } catch (err: unknown) {
      const reason =
        err instanceof Error ? err.message : "Failed to process receipt file.";
      setReceiptScanError(`Could not auto-scan receipt: ${reason}`);
      setReceiptStatusMessage(null);
      setIsScanningReceipt(false);
      setIsUploadingReceipt(false);
    }
  };

  const handleRemoveReceipt = () => {
    setReceiptUrl(null);
    setReceiptPreviewUrl(null);
    setReceiptFileName("");
    setReceiptStatusMessage(null);
    setReceiptScanError(null);
  };

  // Sync native dialog
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;

    if (isOpen) {
      if (!dialog.open) {
        dialog.showModal();
      }
    } else {
      if (dialog.open) {
        dialog.close();
      }
    }
  }, [isOpen]);

  const handleClose = () => {
    setError(null);
    onClose();
  };

  const handleBackdropClick = (e: React.MouseEvent<HTMLDialogElement>) => {
    const dialog = dialogRef.current;
    if (!dialog || e.target !== dialog) return;

    const rect = dialog.getBoundingClientRect();
    const isInside =
      rect.top <= e.clientY &&
      e.clientY <= rect.top + rect.height &&
      rect.left <= e.clientX &&
      e.clientX <= rect.left + rect.width;

    if (!isInside) {
      handleClose();
    }
  };

  // Live exact split calculation & auto-summed total
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

  // Live percentage summary
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

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!expense) return;

    if (totalCents <= 0) {
      setError("Please enter a valid amount greater than zero.");
      return;
    }
    if (!payerId) {
      setError("Please select who paid.");
      return;
    }

    let calculatedSplits: Array<{ memberId: string; splitAmountCents: number }> = [];

    if (type === "payment") {
      if (selectedMembers.length === 0) {
        setError("Please select a recipient for the payment.");
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
        setError("Please select at least one split participant.");
        return;
      }
      calculatedSplits = splitAmountEqually(totalCents, selectedMembers);
    } else if (splitMode === "percentage") {
      if (!percentageSummary.isValid || percentageSummary.splits.length === 0) {
        setError(
          `Percentages must add up to 100% (currently ${percentageSummary.totalPct.toFixed(2)}%).`
        );
        return;
      }
      calculatedSplits = percentageSummary.splits;
    } else {
      if (!exactSummary.valid) {
        setError(
          exactSummary.error ||
            "Exact split amounts must equal the transaction total."
        );
        return;
      }
      calculatedSplits = exactSummary.splits;
    }

    setIsSubmitting(true);
    setError(null);

    try {
      // 1. Update the expense record
      const effectiveExpenseCategory = isCustomCategory
        ? customCategoryInput.trim() || category.trim() || "General"
        : (category || "").trim() || "General";
      const resolvedCategory =
        type === "payment" ? "Payment" : effectiveExpenseCategory;

      const normalizedCurrency = normalizeCurrencyCode(currency);

      const updatePayload: Record<string, unknown> = {
        description:
          description.trim() || (type === "payment" ? "Payment" : "Expense"),
        amount_cents: totalCents,
        currency: normalizedCurrency,
        type,
        category: resolvedCategory,
        receipt_url: type === "payment" ? null : receiptUrl,
        paid_by_member_id: payerId,
        date: date || getTodayLocalDate(),
      };

      let { error: updateError } = await supabase
        .from("expenses")
        .update(updatePayload)
        .eq("id", expense.id);

      if (
        updateError &&
        (updateError.message?.toLowerCase().includes("expenses_currency_check") ||
          updateError.message?.toLowerCase().includes("currency"))
      ) {
        updatePayload.currency =
          normalizedCurrency === "EUR" ? "€" : normalizedCurrency === "USD" ? "$" : normalizedCurrency;
        const retryUpdate = await supabase
          .from("expenses")
          .update(updatePayload)
          .eq("id", expense.id);
        updateError = retryUpdate.error;
      }

      if (updateError) {
        setError("Error updating expense: " + updateError.message);
        setIsSubmitting(false);
        return;
      }

      // 2. Delete previous splits
      const { error: deleteSplitsError } = await supabase
        .from("expense_splits")
        .delete()
        .eq("expense_id", expense.id);

      if (deleteSplitsError) {
        setError("Error removing old splits: " + deleteSplitsError.message);
        setIsSubmitting(false);
        return;
      }

      // 3. Insert newly calculated splits
      let splitsPayload: Array<Record<string, unknown>> = calculatedSplits.map(
        (s) => ({
          expense_id: expense.id,
          member_id: s.memberId,
          split_amount_cents: s.splitAmountCents,
        })
      );

      let { error: insertSplitsError } = await supabase
        .from("expense_splits")
        .insert(splitsPayload);

      for (
        let attempt = 0;
        attempt < 2 && insertSplitsError && splitsPayload.length > 0;
        attempt++
      ) {
        const msg = insertSplitsError.message?.toLowerCase() || "";
        let updated = false;
        if (msg.includes('"amount"') && !("amount" in splitsPayload[0])) {
          splitsPayload = splitsPayload.map((s) => ({
            ...s,
            amount: Number(((s.split_amount_cents as number) / 100).toFixed(2)),
          }));
          updated = true;
        }
        if (msg.includes('"user_id"') && !("user_id" in splitsPayload[0])) {
          splitsPayload = splitsPayload.map((s) => ({
            ...s,
            user_id: s.member_id,
          }));
          updated = true;
        }
        if (!updated) break;
        const retrySplits = await supabase
          .from("expense_splits")
          .insert(splitsPayload);
        insertSplitsError = retrySplits.error;
      }

      if (insertSplitsError) {
        // Restore previous splits if inserting updated splits failed so the expense never remains with 0 splits
        if (expense.splits.length > 0) {
          await supabase.from("expense_splits").insert(
            expense.splits.map((s) => ({
              expense_id: expense.id,
              member_id: s.memberId,
              split_amount_cents: s.splitAmountCents,
            }))
          );
        }
        setError("Error saving new splits: " + insertSplitsError.message);
        setIsSubmitting(false);
        return;
      }

      onSaved();
      handleClose();
    } catch (err: unknown) {
      const message =
        err instanceof Error ? err.message : "An unexpected error occurred.";
      setError(message);
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <dialog
      ref={dialogRef}
      closedby="any"
      aria-labelledby="edit-expense-title"
      onClick={handleBackdropClick}
      onCancel={(e) => {
        e.preventDefault();
        handleClose();
      }}
      className="m-auto p-0 rounded-2xl shadow-2xl border border-slate-200 bg-white max-w-lg w-full backdrop:bg-slate-900/60 backdrop:backdrop-blur-xs open:animate-in open:fade-in-0 open:zoom-in-95"
    >
      <form onSubmit={handleSave} className="p-6 space-y-5">
        {/* Header */}
        <div className="flex items-start justify-between">
          <div className="flex items-center gap-3">
            <div className="p-2.5 bg-blue-50 text-blue-600 rounded-xl">
              <Edit3 className="w-5 h-5" />
            </div>
            <div>
              <h2
                id="edit-expense-title"
                className="text-lg font-bold text-slate-900"
              >
                Edit Transaction
              </h2>
              <p className="text-xs text-slate-500">
                Update amount, payer, participants, or custom split shares.
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={handleClose}
            aria-label="Close modal"
            className="text-slate-400 hover:text-slate-600 p-1.5 rounded-lg hover:bg-slate-100 transition cursor-pointer"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Error banner */}
        {error && (
          <div className="p-3 bg-red-50 border border-red-200 rounded-xl text-xs text-red-800 flex items-start gap-2">
            <AlertCircle className="w-4 h-4 text-red-600 shrink-0 mt-0.5" />
            <span>{error}</span>
          </div>
        )}

        {/* Type toggle */}
        <div className="flex items-center justify-between">
          <label className="text-xs font-semibold text-slate-600">
            Transaction Type
          </label>
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

        {/* Scan / Attach Receipt Section (Strictly for Group Expenses) */}
        {type === "expense" && (
          <div className="p-3.5 rounded-xl border border-blue-200/80 bg-blue-50/40 space-y-2.5">
            <input
              ref={receiptCameraInputRef}
              type="file"
              accept="image/*"
              capture="environment"
              onChange={handleReceiptFileChange}
              className="hidden"
            />
            <input
              ref={receiptFileInputRef}
              type="file"
              accept="image/*"
              onChange={handleReceiptFileChange}
              className="hidden"
            />
            <input
              ref={receiptPdfInputRef}
              type="file"
              accept="application/pdf"
              onChange={handleReceiptFileChange}
              className="hidden"
            />
            <div className="flex items-center justify-between gap-2 flex-wrap">
              <div className="flex items-center gap-2">
                <Camera className="w-4 h-4 text-blue-600 shrink-0" />
                <div>
                  <span className="text-xs font-bold text-slate-800 block">
                    Receipt Attachment & AI Auto-Fill
                  </span>
                  <span className="text-[11px] text-slate-500">
                    Take a photo, pick from your gallery, or attach a PDF to auto-extract details
                  </span>
                </div>
              </div>
              <div className="flex items-center gap-1.5 flex-wrap">
                <button
                  type="button"
                  disabled={isScanningReceipt || isUploadingReceipt}
                  onClick={() => receiptCameraInputRef.current?.click()}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold bg-blue-600 hover:bg-blue-700 text-white shadow-2xs transition cursor-pointer disabled:opacity-60"
                >
                  {isScanningReceipt || isUploadingReceipt ? (
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
                  disabled={isScanningReceipt || isUploadingReceipt}
                  onClick={() => receiptFileInputRef.current?.click()}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold bg-white hover:bg-blue-50 text-blue-700 border border-blue-200 shadow-2xs transition cursor-pointer disabled:opacity-60"
                >
                  <span>🖼️</span>
                  <span>Photo Library</span>
                </button>
                <button
                  type="button"
                  disabled={isScanningReceipt || isUploadingReceipt}
                  onClick={() => receiptPdfInputRef.current?.click()}
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
                          const targetUrl = receiptUrl || receiptPreviewUrl;
                          if (targetUrl && onViewReceipt) {
                            onViewReceipt(targetUrl, description || "Receipt");
                          } else if (targetUrl) {
                            window.open(
                              targetUrl,
                              "_blank",
                              "noopener,noreferrer"
                            );
                          }
                        }}
                        title="View full receipt"
                        className="relative w-12 h-12 rounded-lg overflow-hidden border border-slate-200 bg-white shrink-0 group cursor-pointer"
                      >
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img
                          src={receiptPreviewUrl}
                          alt="Receipt preview"
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
                        {receiptFileName || "Attached Receipt"}
                      </div>
                      {isScanningReceipt || isUploadingReceipt ? (
                        <div className="text-[11px] text-blue-600 font-medium flex items-center gap-1 mt-0.5">
                          <Loader2 className="w-3 h-3 animate-spin" />
                          <span>Scanning receipt...</span>
                        </div>
                      ) : receiptStatusMessage ? (
                        <div className="text-[11px] text-emerald-700 font-medium mt-0.5">
                          {receiptStatusMessage}
                        </div>
                      ) : (
                        <div className="text-[11px] text-slate-500 mt-0.5">
                          Saved with this expense
                        </div>
                      )}
                    </div>
                  </div>

                  <div className="flex items-center gap-1.5 shrink-0">
                    {(receiptUrl || receiptPreviewUrl) && (
                      <button
                        type="button"
                        onClick={() => {
                          const targetUrl = receiptUrl || receiptPreviewUrl;
                          if (targetUrl && onViewReceipt) {
                            onViewReceipt(targetUrl, description || "Receipt");
                          } else if (targetUrl) {
                            window.open(
                              targetUrl,
                              "_blank",
                              "noopener,noreferrer"
                            );
                          }
                        }}
                        className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg text-xs font-semibold text-blue-700 bg-white hover:bg-blue-50 border border-blue-200 transition cursor-pointer"
                      >
                        <ExternalLink className="w-3 h-3" />
                        <span>View</span>
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={handleRemoveReceipt}
                      title="Remove receipt"
                      className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg text-xs font-semibold text-red-600 bg-white hover:bg-red-50 border border-red-200 transition cursor-pointer"
                    >
                      <Trash2 className="w-3 h-3" />
                      <span>Remove</span>
                    </button>
                  </div>
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

        {/* Paid By & Amount */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
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
              {availableCurrencies.length > 1
                ? `Amount & Currency (${currency})`
                : `Amount (${currency})`}
              {isExactMode ? " (Auto-Summed)" : ""}
            </label>
            <div className="flex gap-2">
              <div className="relative flex-1">
                <span className="absolute left-3 top-2 text-xs font-semibold text-slate-400">
                  {currencySymbol}
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
                      ? "Automatically summed from individual Exact member amounts below"
                      : undefined
                  }
                  className={`w-full ${
                    currencySymbol.length > 2 ? "pl-10" : "pl-8"
                  } pr-3 py-2 border border-slate-300 rounded-lg text-sm placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent transition ${
                    isExactMode
                      ? "bg-slate-50 text-slate-700 font-semibold cursor-default"
                      : "bg-white text-slate-900"
                  }`}
                  required={!isExactMode}
                />
              </div>
              {availableCurrencies.length > 1 && (
                <select
                  value={currency}
                  onChange={(e) => setCurrency(e.target.value)}
                  className="border border-slate-300 rounded-lg px-2.5 py-2 text-xs font-bold text-slate-800 bg-slate-50 focus:outline-none focus:ring-2 focus:ring-blue-500 cursor-pointer"
                >
                  {availableCurrencies.map((code) => {
                    const info = getCurrencyInfo(code);
                    return (
                      <option key={code} value={code}>
                        {info.pillLabel}
                      </option>
                    );
                  })}
                </select>
              )}
            </div>
          </div>
        </div>

        {/* Description & Date */}
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
                  : "e.g. Dinner, Fuel, Groceries, Hotel"
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
              value={date}
              onChange={(e) => setDate(e.target.value)}
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
              {categoryOptions.map((cat) => {
                const isSelected = !isCustomCategory && category === cat;
                return (
                  <button
                    key={cat}
                    type="button"
                    onClick={() => {
                      setCategory(cat);
                      setIsCustomCategory(false);
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
                  setCustomCategoryInput("");
                }}
                className={`px-2.5 py-1 rounded-full text-xs font-semibold border transition cursor-pointer inline-flex items-center gap-1 ${
                  isCustomCategory
                    ? "bg-blue-600 text-white border-blue-600 shadow-2xs"
                    : "bg-white text-blue-600 border-blue-200 hover:bg-blue-50"
                }`}
              >
                <Plus className="w-3 h-3" />
                <span>Custom...</span>
              </button>
            </div>

            {isCustomCategory && (
              <div className="flex items-center gap-2 pt-0.5 animate-in fade-in-50">
                <input
                  type="text"
                  placeholder="Custom category (e.g. Golf, Ski Passes, Tolls)"
                  value={customCategoryInput}
                  onChange={(e) => setCustomCategoryInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      const trimmed = customCategoryInput.trim();
                      if (trimmed) {
                        setCategory(trimmed);
                        setIsCustomCategory(false);
                        setCustomCategoryInput("");
                      }
                    }
                  }}
                  autoFocus
                  className="flex-1 border border-blue-300 rounded-lg px-2.5 py-1.5 text-xs text-slate-900 placeholder:text-slate-400 bg-white focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
                {customCategoryInput.trim() && (
                  <button
                    type="button"
                    onClick={() => {
                      const trimmed = customCategoryInput.trim();
                      if (trimmed) {
                        setCategory(trimmed);
                        setIsCustomCategory(false);
                        setCustomCategoryInput("");
                      }
                    }}
                    className="px-2.5 py-1.5 rounded-lg text-xs font-semibold bg-blue-600 text-white hover:bg-blue-700 transition cursor-pointer shrink-0"
                  >
                    Apply
                  </button>
                )}
              </div>
            )}
          </div>
        )}

        {/* Split Mode & Participants selection */}
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
                    onClick={() => setSelectedMembers(members.map((m) => m.id))}
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
                      {isSelected && <span className="text-[10px]">✓</span>}
                    </button>
                  );
                })}
              </div>

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
                    {currencySymbol}
                    {perPersonAmount} each
                  </span>
                </div>
              )}
            </>
          ) : splitMode === "percentage" ? (
            <div className="space-y-2">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 max-h-48 overflow-y-auto p-1">
                {members.map((m) => {
                  const allocCents = percentageSummary.splitMap.get(m.id) || 0;
                  return (
                    <div
                      key={m.id}
                      className="flex items-center justify-between gap-2 p-2 rounded-xl border border-slate-200 bg-slate-50/60"
                    >
                      <div className="min-w-0 flex-1">
                        <span className="text-xs font-semibold text-slate-800 block truncate">
                          {m.name}
                        </span>
                        {totalCents > 0 && allocCents > 0 && (
                          <span className="text-[11px] text-slate-500">
                            {currencySymbol}
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
                    Total: {percentageSummary.totalPct.toFixed(2)}% / 100%
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
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 max-h-48 overflow-y-auto p-1">
                {members.map((m) => (
                  <div
                    key={m.id}
                    className="flex items-center justify-between gap-2 p-2 rounded-xl border border-slate-200 bg-slate-50/60"
                  >
                    <span className="text-xs font-semibold text-slate-800 truncate flex-1">
                      {m.name}
                    </span>
                    <div className="relative w-28 shrink-0">
                      <span className="absolute left-2.5 top-1.5 text-xs text-slate-400 font-semibold">
                        {currencySymbol}
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
                            const parsed = parseFloat(nextExact[mem.id] || "0");
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
                          currencySymbol.length > 2 ? "pl-8" : "pl-6"
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
                    Auto-Summed Total: {currencySymbol}
                    {(exactSummary.totalSplitCents / 100).toFixed(2)}
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

        {/* Footer actions */}
        <div className="pt-3 border-t border-slate-100 flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={handleClose}
            className="px-4 py-2 text-xs font-semibold text-slate-600 hover:bg-slate-100 rounded-xl transition cursor-pointer"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={isSubmitting}
            className="px-4 py-2 text-xs font-semibold bg-slate-900 hover:bg-slate-800 text-white rounded-xl transition cursor-pointer shadow-xs disabled:opacity-50"
          >
            {isSubmitting ? "Saving..." : "Save Changes"}
          </button>
        </div>
      </form>
    </dialog>
  );
}
