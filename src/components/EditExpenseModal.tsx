"use client";

import { useState, useEffect, useRef } from "react";
import { createClient } from "@/lib/supabase";
import { splitAmountEqually } from "@/lib/reconciliation";
import { GroupMember } from "@/components/MemberInviteModal";
import { X, Sparkles, AlertCircle, Edit3 } from "lucide-react";

export interface ExpenseItem {
  id: string;
  paidByMemberId?: string;
  payerId?: string;
  description: string;
  amount: number;
  amountCents: number;
  currency: string;
  type: "expense" | "payment";
  date: string;
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
  members: GroupMember[];
  onSaved: () => void;
}

export default function EditExpenseModal({
  isOpen,
  onClose,
  expense,
  members,
  onSaved,
}: EditExpenseModalProps) {
  const supabase = createClient();
  const dialogRef = useRef<HTMLDialogElement>(null);

  const [description, setDescription] = useState(expense?.description ?? "");
  const [amount, setAmount] = useState(
    expense ? (expense.amountCents / 100).toFixed(2) : ""
  );
  const [currency, setCurrency] = useState<"$" | "€">(
    expense?.currency === "€" || expense?.currency === "EUR" ? "€" : "$"
  );
  const [type, setType] = useState<"expense" | "payment">(
    expense?.type === "payment" ? "payment" : "expense"
  );
  const [payerId, setPayerId] = useState(
    expense?.paidByMemberId || expense?.payerId || ""
  );
  const [selectedMembers, setSelectedMembers] = useState<string[]>(
    expense ? expense.splits.map((s) => s.memberId) : []
  );
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

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

  const parsedAmount = parseFloat(amount);
  const perPersonAmount =
    !isNaN(parsedAmount) && parsedAmount > 0 && selectedMembers.length > 0
      ? (parsedAmount / selectedMembers.length).toFixed(2)
      : null;

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!expense) return;

    const parsed = parseFloat(amount);
    if (isNaN(parsed) || parsed <= 0) {
      setError("Please enter a valid amount greater than zero.");
      return;
    }
    if (!payerId) {
      setError("Please select who paid.");
      return;
    }
    if (selectedMembers.length === 0) {
      setError("Please select at least one split participant.");
      return;
    }

    setIsSubmitting(true);
    setError(null);

    const totalCents = Math.round(parsed * 100);

    try {
      // 1. Update the expense record
      const updatePayload: Record<string, unknown> = {
        description:
          description.trim() || (type === "payment" ? "Payment" : "Expense"),
        amount_cents: totalCents,
        currency,
        type,
        paid_by_member_id: payerId,
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
        updatePayload.currency = currency === "€" ? "EUR" : "USD";
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
      let splitsPayload: Array<Record<string, unknown>> = [];

      if (type === "payment") {
        splitsPayload = [
          {
            expense_id: expense.id,
            member_id: selectedMembers[0],
            split_amount_cents: totalCents,
          },
        ];
      } else {
        const equalSplits = splitAmountEqually(totalCents, selectedMembers);
        splitsPayload = equalSplits.map((s) => ({
          expense_id: expense.id,
          member_id: s.memberId,
          split_amount_cents: s.splitAmountCents,
        }));
      }

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
                Update amount, payer, participants, or transaction type.
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

        {/* Description */}
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

        {/* Participants / Recipient selection */}
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
