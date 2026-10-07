"use client";

import { useState, useEffect, useRef } from "react";
import { createClient } from "@/lib/supabase";
import {
  UserPlus,
  X,
  Copy,
  Check,
  Users,
  Mail,
  Link2,
  Shield,
  AlertCircle,
  CheckCircle2,
} from "lucide-react";

export interface GroupMember {
  id: string;
  name: string;
  email?: string;
  role: "admin" | "member";
}

export interface Group {
  id: string;
  name: string;
  created_by: string;
  created_at?: string;
}

interface MemberInviteModalProps {
  isOpen: boolean;
  onClose: () => void;
  group: Group | null;
  currentMembers: GroupMember[];
  currentUserId: string;
  onMemberAdded: () => void;
}

export default function MemberInviteModal({
  isOpen,
  onClose,
  group,
  currentMembers,
  currentUserId,
  onMemberAdded,
}: MemberInviteModalProps) {
  const supabase = createClient();
  const dialogRef = useRef<HTMLDialogElement>(null);

  const [email, setEmail] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [statusMessage, setStatusMessage] = useState<{
    type: "success" | "error" | "info" | "warning";
    text: string;
  } | null>(null);
  const [copied, setCopied] = useState(false);

  // Sync native <dialog> element with isOpen prop
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
    setStatusMessage(null);
    setEmail("");
    onClose();
  };

  // Fallback for light-dismiss on browsers that do not support closedby="any"
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

  const inviteUrl =
    typeof window !== "undefined" && group
      ? `${window.location.origin}/?join=${group.id}`
      : "";

  const handleCopyLink = async () => {
    if (!inviteUrl) return;
    try {
      if (navigator?.clipboard?.writeText) {
        await navigator.clipboard.writeText(inviteUrl);
      } else {
        const textarea = document.createElement("textarea");
        textarea.value = inviteUrl;
        document.body.appendChild(textarea);
        textarea.select();
        document.execCommand("copy");
        document.body.removeChild(textarea);
      }
      setCopied(true);
      setTimeout(() => setCopied(false), 2200);
    } catch (err) {
      console.error("Failed to copy invite link:", err);
    }
  };

  const handleAddByEmail = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!group) return;

    const trimmed = email.trim().toLowerCase();
    if (!trimmed) return;

    setIsSubmitting(true);
    setStatusMessage(null);

    // 1. Check if already a member locally
    const existing = currentMembers.find(
      (m) =>
        m.email?.toLowerCase() === trimmed || m.name.toLowerCase() === trimmed
    );
    if (existing) {
      setStatusMessage({
        type: "warning",
        text: `"${existing.name}" is already a member of this group.`,
      });
      setIsSubmitting(false);
      return;
    }

    try {
      // 2. Query profiles by email
      const { data: profile, error: searchError } = await supabase
        .from("profiles")
        .select("id, full_name, email")
        .eq("email", trimmed)
        .maybeSingle();

      if (searchError) {
        console.warn("Profiles search error:", searchError);
      }

      if (!profile) {
        setStatusMessage({
          type: "info",
          text: `No registered account found for "${trimmed}". Share the invite link below so they can join directly when they sign in!`,
        });
        setIsSubmitting(false);
        return;
      }

      // Check if user ID is already in members
      if (currentMembers.some((m) => m.id === profile.id)) {
        setStatusMessage({
          type: "warning",
          text: `${profile.full_name || profile.email} is already in this group.`,
        });
        setIsSubmitting(false);
        return;
      }

      // 3. Add to group_members
      const { error: insertError } = await supabase
        .from("group_members")
        .insert({
          group_id: group.id,
          user_id: profile.id,
          role: "member",
        });

      if (insertError) {
        if (insertError.code === "42501") {
          setStatusMessage({
            type: "warning",
            text: `Found user "${profile.full_name || profile.email}", but row-level security policy currently prevents adding them directly. Please share the invite link below!`,
          });
        } else {
          setStatusMessage({
            type: "error",
            text: `Failed to add member: ${insertError.message}`,
          });
        }
        setIsSubmitting(false);
        return;
      }

      // 4. Success!
      setStatusMessage({
        type: "success",
        text: `Successfully added ${profile.full_name || profile.email} to ${group.name}!`,
      });
      setEmail("");
      onMemberAdded();
    } catch (err: unknown) {
      const message =
        err instanceof Error ? err.message : "An unexpected error occurred.";
      setStatusMessage({
        type: "error",
        text: message,
      });
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <dialog
      ref={dialogRef}
      closedby="any"
      aria-labelledby="invite-modal-title"
      onClick={handleBackdropClick}
      onCancel={(e) => {
        e.preventDefault();
        handleClose();
      }}
      className="m-auto p-0 rounded-2xl shadow-2xl border border-slate-200 bg-white max-w-lg w-full backdrop:bg-slate-900/60 backdrop:backdrop-blur-xs open:animate-in open:fade-in-0 open:zoom-in-95"
    >
      <div className="p-6 space-y-6">
        {/* Header */}
        <div className="flex items-start justify-between">
          <div className="flex items-center gap-3">
            <div className="p-2.5 bg-blue-50 text-blue-600 rounded-xl">
              <UserPlus className="w-5 h-5" />
            </div>
            <div>
              <h2
                id="invite-modal-title"
                className="text-lg font-bold text-slate-900"
              >
                Invite to {group?.name || "Group"}
              </h2>
              <p className="text-xs text-slate-500">
                Add members to split expenses and settle debts together.
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={handleClose}
            aria-label="Close modal"
            className="text-slate-400 hover:text-slate-600 p-1.5 rounded-lg hover:bg-slate-100 transition"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Status Message Banner */}
        {statusMessage && (
          <div
            className={`p-3 rounded-xl text-xs flex items-start gap-2.5 ${
              statusMessage.type === "success"
                ? "bg-emerald-50 text-emerald-800 border border-emerald-200"
                : statusMessage.type === "warning"
                ? "bg-amber-50 text-amber-800 border border-amber-200"
                : statusMessage.type === "info"
                ? "bg-blue-50 text-blue-800 border border-blue-200"
                : "bg-red-50 text-red-800 border border-red-200"
            }`}
          >
            {statusMessage.type === "success" ? (
              <CheckCircle2 className="w-4 h-4 text-emerald-600 shrink-0 mt-0.5" />
            ) : (
              <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
            )}
            <span>{statusMessage.text}</span>
          </div>
        )}

        {/* Section 1: Invite by Email */}
        <form onSubmit={handleAddByEmail} className="space-y-3">
          <label
            htmlFor="invite-email"
            className="text-xs font-semibold text-slate-700 flex items-center gap-1.5"
          >
            <Mail className="w-3.5 h-3.5 text-slate-500" />
            Add by Email
          </label>
          <div className="flex gap-2">
            <input
              id="invite-email"
              type="email"
              placeholder="friend@example.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              disabled={isSubmitting}
              className="flex-1 border border-slate-300 rounded-lg px-3 py-2 text-sm text-slate-900 placeholder:text-slate-400 bg-white focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent transition disabled:opacity-60"
            />
            <button
              type="submit"
              disabled={isSubmitting || !email.trim()}
              className="bg-blue-600 hover:bg-blue-700 text-white font-medium text-xs px-4 py-2 rounded-lg transition disabled:opacity-50 disabled:cursor-not-allowed shrink-0 flex items-center gap-1.5"
            >
              {isSubmitting ? "Adding..." : "Add Member"}
            </button>
          </div>
          <p className="text-[11px] text-slate-400">
            Searches registered accounts by email to add them immediately.
          </p>
        </form>

        {/* Divider */}
        <div className="relative">
          <div className="absolute inset-0 flex items-center">
            <div className="w-full border-t border-slate-200" />
          </div>
          <div className="relative flex justify-center text-xs uppercase">
            <span className="bg-white px-2 text-slate-400 font-semibold tracking-wider text-[10px]">
              Or share invite link
            </span>
          </div>
        </div>

        {/* Section 2: Shareable Invite Link */}
        <div className="space-y-2">
          <label className="text-xs font-semibold text-slate-700 flex items-center gap-1.5">
            <Link2 className="w-3.5 h-3.5 text-slate-500" />
            Shareable Join Link
          </label>
          <div className="flex gap-2">
            <input
              type="text"
              readOnly
              value={inviteUrl}
              onFocus={(e) => e.target.select()}
              className="flex-1 border border-slate-300 rounded-lg px-3 py-2 text-xs text-slate-600 bg-slate-50 select-all font-mono"
            />
            <button
              type="button"
              onClick={handleCopyLink}
              className={`px-3.5 py-2 rounded-lg text-xs font-semibold flex items-center gap-1.5 transition shrink-0 ${
                copied
                  ? "bg-emerald-600 text-white"
                  : "bg-slate-900 text-white hover:bg-slate-800"
              }`}
            >
              {copied ? (
                <>
                  <Check className="w-3.5 h-3.5" />
                  Copied!
                </>
              ) : (
                <>
                  <Copy className="w-3.5 h-3.5" />
                  Copy Link
                </>
              )}
            </button>
          </div>
          <p className="text-[11px] text-slate-400">
            Anyone with this link can sign in to accept the invite and join this group automatically.
          </p>
        </div>

        {/* Section 3: Current Members List */}
        <div className="pt-2 border-t border-slate-100">
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-xs font-semibold text-slate-700 flex items-center gap-1.5">
              <Users className="w-3.5 h-3.5 text-slate-500" />
              Current Members ({currentMembers.length})
            </h3>
          </div>
          <div className="space-y-2 max-h-48 overflow-y-auto pr-1">
            {currentMembers.map((member) => {
              const isCurrentUser = member.id === currentUserId;
              const initials = (member.name || "U")
                .split(" ")
                .map((n) => n[0])
                .join("")
                .slice(0, 2)
                .toUpperCase();

              return (
                <div
                  key={member.id}
                  className="flex items-center justify-between p-2 rounded-lg bg-slate-50 border border-slate-100 text-xs"
                >
                  <div className="flex items-center gap-2.5 min-w-0">
                    <div className="w-7 h-7 rounded-full bg-blue-100 text-blue-700 font-bold flex items-center justify-center text-[11px] shrink-0">
                      {initials}
                    </div>
                    <div className="min-w-0">
                      <div className="font-medium text-slate-900 truncate">
                        {member.name}
                        {isCurrentUser && (
                          <span className="ml-1 text-slate-400 font-normal">
                            (You)
                          </span>
                        )}
                      </div>
                      {member.email && member.email !== member.name && (
                        <div className="text-[11px] text-slate-400 truncate">
                          {member.email}
                        </div>
                      )}
                    </div>
                  </div>
                  <div className="flex items-center gap-1.5 shrink-0 ml-2">
                    {member.role === "admin" ? (
                      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold bg-indigo-50 text-indigo-700 border border-indigo-200">
                        <Shield className="w-3 h-3" />
                        Admin
                      </span>
                    ) : (
                      <span className="px-2 py-0.5 rounded-full text-[10px] font-medium bg-slate-200 text-slate-700">
                        Member
                      </span>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {/* Footer */}
        <div className="pt-2 flex justify-end">
          <button
            type="button"
            onClick={handleClose}
            className="px-4 py-2 bg-slate-100 hover:bg-slate-200 text-slate-700 font-medium text-xs rounded-lg transition"
          >
            Done
          </button>
        </div>
      </div>
    </dialog>
  );
}
