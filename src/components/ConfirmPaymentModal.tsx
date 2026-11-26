"use client";

import { useState, useEffect, useRef } from "react";
import { createClient } from "@/lib/supabase";
import { GroupMember } from "@/components/MemberInviteModal";
import { getTodayLocalDate } from "@/components/EditExpenseModal";
import {
  normalizeCurrencyCode,
  getCurrencySymbol,
  fetchTransactionFxRates,
  type FxRatesMap,
} from "@/lib/currencies";
import { CheckCircle2, X, AlertCircle, ArrowRight } from "lucide-react";

export interface PaymentDraft {
  fromMemberId: string;
  toMemberId: string;
  fromLabel: string;
  toLabel: string;
  isHousehold: boolean;
  amountCents: number;
  currency: string;
}

interface ConfirmPaymentModalProps {
  isOpen: boolean;
  onClose: () => void;
  groupId: string;
  createdBy?: string | null;
  members: GroupMember[];
  groupCurrencies: string[];
  defaultCurrency: string;
  paymentDraft: PaymentDraft | null;
  onPaymentRecorded: (message: string) => Promise<void> | void;
}

export default function ConfirmPaymentModal({
  isOpen,
  onClose,
  groupId,
  createdBy,
  members,
  groupCurrencies,
  defaultCurrency,
  paymentDraft,
  onPaymentRecorded,
}: ConfirmPaymentModalProps) {
  const supabase = createClient();
  const dialogRef = useRef<HTMLDialogElement>(null);

  const [fromMemberId, setFromMemberId] = useState(
    paymentDraft?.fromMemberId || ""
  );
  const [toMemberId, setToMemberId] = useState(paymentDraft?.toMemberId || "");
  const [amountInput, setAmountInput] = useState(
    paymentDraft ? (paymentDraft.amountCents / 100).toFixed(2) : ""
  );
  const [paymentDate, setPaymentDate] = useState(() => getTodayLocalDate());
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (isOpen) {
      if (!dialog.open) {
        dialog.showModal();
      }
    } else if (dialog.open) {
      dialog.close();
    }
  }, [isOpen]);

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
      onClose();
    }
  };

  if (!paymentDraft) return null;

  const isoCurrency = normalizeCurrencyCode(paymentDraft.currency);
  const symbol = getCurrencySymbol(isoCurrency);
  const selectedPayer = members.find((m) => m.id === fromMemberId);
  const selectedRecipient = members.find((m) => m.id === toMemberId);

  const handleConfirm = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!groupId || !fromMemberId || !toMemberId) {
      setError("Please select both who paid and who received the payment.");
      return;
    }
    if (fromMemberId === toMemberId) {
      setError("Payer and recipient must be different members.");
      return;
    }

    const parsed = parseFloat(amountInput);
    const amountCents = !isNaN(parsed) && parsed > 0 ? Math.round(parsed * 100) : 0;
    if (amountCents <= 0) {
      setError("Please enter a valid payment amount greater than zero.");
      return;
    }

    setIsSubmitting(true);
    setError(null);

    try {
      const cleanDate = (paymentDate || getTodayLocalDate()).split("T")[0];
      let fxRates: FxRatesMap | null = null;
      if (
        groupCurrencies.length > 1 ||
        isoCurrency !== normalizeCurrencyCode(defaultCurrency)
      ) {
        try {
          fxRates = await fetchTransactionFxRates(
            isoCurrency,
            cleanDate,
            groupCurrencies
          );
        } catch {
          fxRates = null;
        }
      }

      const expensePayload: Record<string, unknown> = {
        group_id: groupId,
        paid_by_member_id: fromMemberId,
        description: "Settlement Payment",
        category: "Payment",
        receipt_url: null,
        amount_cents: amountCents,
        currency: isoCurrency,
        fx_rates: fxRates,
        type: "payment",
        date: cleanDate,
      };

      let { data: newExp, error: expError } = await supabase
        .from("expenses")
        .insert(expensePayload)
        .select("id")
        .single();

      for (let attempt = 0; attempt < 4 && expError; attempt++) {
        const msg = expError.message?.toLowerCase() || "";
        let updated = false;
        if (msg.includes("fx_rates") && "fx_rates" in expensePayload) {
          delete expensePayload.fx_rates;
          updated = true;
        }
        if (msg.includes('"amount"') && !("amount" in expensePayload)) {
          expensePayload.amount = Number((amountCents / 100).toFixed(2));
          updated = true;
        }
        if (
          msg.includes('"created_by"') &&
          !("created_by" in expensePayload) &&
          createdBy
        ) {
          expensePayload.created_by = createdBy;
          updated = true;
        }
        if (msg.includes('"payer_id"') && !("payer_id" in expensePayload)) {
          expensePayload.payer_id = createdBy || fromMemberId;
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
        throw new Error(expError?.message || "Could not record payment.");
      }

      let splitsPayload: Array<Record<string, unknown>> = [
        {
          expense_id: newExp.id,
          member_id: toMemberId,
          split_amount_cents: amountCents,
        },
      ];

      let { error: splitsError } = await supabase
        .from("expense_splits")
        .insert(splitsPayload);

      for (let attempt = 0; attempt < 2 && splitsError; attempt++) {
        const msg = splitsError.message?.toLowerCase() || "";
        let updated = false;
        if (msg.includes('"amount"') && !("amount" in splitsPayload[0])) {
          splitsPayload = splitsPayload.map((s) => ({
            ...s,
            amount: Number((amountCents / 100).toFixed(2)),
          }));
          updated = true;
        }
        if (msg.includes('"user_id"') && !("user_id" in splitsPayload[0])) {
          splitsPayload = splitsPayload.map((s) => ({
            ...s,
            user_id: createdBy || toMemberId,
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
        await supabase.from("expenses").delete().eq("id", newExp.id);
        throw new Error(splitsError.message);
      }

      await onPaymentRecorded("Payment recorded");
      onClose();
    } catch (err: unknown) {
      setError(
        err instanceof Error ? err.message : "Failed to record payment."
      );
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <dialog
      ref={dialogRef}
      closedby="any"
      aria-labelledby="confirm-payment-title"
      onClick={handleBackdropClick}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      className="m-auto p-0 rounded-2xl shadow-2xl border border-slate-200 bg-white max-w-md w-full backdrop:bg-slate-900/60 backdrop:backdrop-blur-xs open:animate-in open:fade-in-0 open:zoom-in-95"
    >
      <form onSubmit={handleConfirm} className="p-5 sm:p-6 space-y-4">
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-center gap-2.5">
            <div className="p-2 bg-emerald-50 text-emerald-600 rounded-xl">
              <CheckCircle2 className="w-5 h-5" />
            </div>
            <div>
              <h2
                id="confirm-payment-title"
                className="text-base font-bold text-slate-900"
              >
                Record Payment
              </h2>
              <p className="text-xs text-slate-500">
                Confirm the transfer details below.
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close modal"
            className="text-slate-400 hover:text-slate-600 p-1 rounded-lg hover:bg-slate-100 transition cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {error && (
          <div className="p-3 bg-red-50 border border-red-200 rounded-xl text-xs text-red-800 flex items-start gap-2">
            <AlertCircle className="w-4 h-4 text-red-600 shrink-0 mt-0.5" />
            <span>{error}</span>
          </div>
        )}

        <div className="p-3.5 bg-emerald-50/70 border border-emerald-200 rounded-xl space-y-2">
          <div className="text-sm font-bold text-slate-900 flex items-center gap-1.5 flex-wrap">
            <span>{paymentDraft.fromLabel}</span>
            <ArrowRight className="w-3.5 h-3.5 text-emerald-600 shrink-0" />
            <span>{paymentDraft.toLabel}</span>
          </div>
          {paymentDraft.isHousehold && (
            <p className="text-[11px] text-emerald-800">
              Recorded via{" "}
              <strong>{selectedPayer?.name || "Member"}</strong> →{" "}
              <strong>{selectedRecipient?.name || "Member"}</strong>
            </p>
          )}
        </div>

        {paymentDraft.isHousehold && members.length > 1 && (
          <div className="grid grid-cols-2 gap-2.5">
            <div>
              <label className="text-[11px] font-semibold text-slate-600 block mb-1">
                From Member
              </label>
              <select
                value={fromMemberId}
                onChange={(e) => setFromMemberId(e.target.value)}
                className="w-full border border-slate-300 rounded-lg px-2.5 py-1.5 text-xs font-medium text-slate-900 bg-white focus:outline-none focus:ring-2 focus:ring-emerald-500"
              >
                {members.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="text-[11px] font-semibold text-slate-600 block mb-1">
                To Member
              </label>
              <select
                value={toMemberId}
                onChange={(e) => setToMemberId(e.target.value)}
                className="w-full border border-slate-300 rounded-lg px-2.5 py-1.5 text-xs font-medium text-slate-900 bg-white focus:outline-none focus:ring-2 focus:ring-emerald-500"
              >
                {members.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name}
                  </option>
                ))}
              </select>
            </div>
          </div>
        )}

        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="text-xs font-semibold text-slate-600 block mb-1">
              Amount ({isoCurrency})
            </label>
            <div className="relative">
              <span className="absolute left-2.5 top-2 text-xs font-semibold text-slate-400">
                {symbol}
              </span>
              <input
                type="number"
                step="0.01"
                min="0.01"
                value={amountInput}
                onChange={(e) => setAmountInput(e.target.value)}
                className={`w-full ${
                  symbol.length > 1 ? "pl-8" : "pl-6"
                } pr-2.5 py-1.5 border border-slate-300 rounded-lg text-sm font-bold text-slate-900 bg-white focus:outline-none focus:ring-2 focus:ring-emerald-500`}
                required
              />
            </div>
          </div>
          <div>
            <label className="text-xs font-semibold text-slate-600 block mb-1">
              Date
            </label>
            <input
              type="date"
              value={paymentDate}
              onChange={(e) => setPaymentDate(e.target.value)}
              className="w-full border border-slate-300 rounded-lg px-2.5 py-1.5 text-sm text-slate-900 bg-white focus:outline-none focus:ring-2 focus:ring-emerald-500"
              required
            />
          </div>
        </div>

        <div className="pt-2 border-t border-slate-100 flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2 text-xs font-semibold text-slate-600 hover:bg-slate-100 rounded-xl transition cursor-pointer"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={isSubmitting}
            className="px-4 py-2 text-xs font-bold bg-emerald-600 hover:bg-emerald-700 text-white rounded-xl transition cursor-pointer shadow-xs disabled:opacity-50 inline-flex items-center gap-1.5"
          >
            <CheckCircle2 className="w-3.5 h-3.5" />
            <span>{isSubmitting ? "Recording..." : "Confirm Payment"}</span>
          </button>
        </div>
      </form>
    </dialog>
  );
}
