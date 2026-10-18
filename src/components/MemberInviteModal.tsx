"use client";

import { useState, useEffect, useRef } from "react";
import { createClient } from "@/lib/supabase";
import { canDeleteMember, ExpenseRecord } from "@/lib/reconciliation";
import {
  UserPlus,
  X,
  Copy,
  Check,
  Users,
  Shield,
  AlertCircle,
  CheckCircle2,
  Trash2,
  Edit2,
  Share2,
} from "lucide-react";

export interface GroupMember {
  id: string; // group_members.id
  groupId?: string;
  userId?: string | null;
  name: string; // display_name
  displayName?: string;
  email?: string | null;
  invitedEmail?: string | null;
  inviteToken?: string;
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
  expenses: ExpenseRecord[];
  onMemberAdded: () => void;
}

export default function MemberInviteModal({
  isOpen,
  onClose,
  group,
  currentMembers,
  currentUserId,
  expenses,
  onMemberAdded,
}: MemberInviteModalProps) {
  const supabase = createClient();
  const dialogRef = useRef<HTMLDialogElement>(null);

  // Form states for pre-creating a member
  const [displayName, setDisplayName] = useState("");
  const [email, setEmail] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [statusMessage, setStatusMessage] = useState<{
    type: "success" | "error" | "info" | "warning";
    text: string;
  } | null>(null);

  // Copy tracking states
  const [copiedGeneral, setCopiedGeneral] = useState(false);
  const [copiedTokenId, setCopiedTokenId] = useState<string | null>(null);

  // Renaming state
  const [editingMemberId, setEditingMemberId] = useState<string | null>(null);
  const [editingName, setEditingName] = useState("");

  const isCurrentAdmin =
    group?.created_by === currentUserId ||
    currentMembers.some(
      (m) => (m.userId === currentUserId || m.id === currentUserId) && m.role === "admin"
    );

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
    setDisplayName("");
    setEmail("");
    setEditingMemberId(null);
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

  const generalInviteUrl =
    typeof window !== "undefined" && group
      ? `${window.location.origin}/join?join=${group.id}`
      : "";

  const copyToClipboard = async (text: string) => {
    try {
      if (navigator?.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
      } else {
        const textarea = document.createElement("textarea");
        textarea.value = text;
        document.body.appendChild(textarea);
        textarea.select();
        document.execCommand("copy");
        document.body.removeChild(textarea);
      }
      return true;
    } catch (err) {
      console.error("Failed to copy:", err);
      return false;
    }
  };

  const handleCopyGeneralLink = async () => {
    if (!generalInviteUrl) return;
    const ok = await copyToClipboard(generalInviteUrl);
    if (ok) {
      setCopiedGeneral(true);
      setTimeout(() => setCopiedGeneral(false), 2200);
    }
  };

  const handleCopyMemberTokenLink = async (member: GroupMember) => {
    if (!member.inviteToken) return;
    const url = `${window.location.origin}/join?token=${member.inviteToken}`;
    const ok = await copyToClipboard(url);
    if (ok) {
      setCopiedTokenId(member.id);
      setTimeout(() => setCopiedTokenId(null), 2200);
    }
  };

  // Pre-create member (unclaimed profile)
  const handlePrecreateMember = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!group) return;

    const trimmedName = displayName.trim();
    const trimmedEmail = email.trim().toLowerCase();

    if (!trimmedName) {
      setStatusMessage({
        type: "warning",
        text: "Please enter a display name for the member.",
      });
      return;
    }

    // Check if name already exists in group
    const duplicate = currentMembers.find(
      (m) =>
        m.name.toLowerCase() === trimmedName.toLowerCase() ||
        (trimmedEmail && m.email?.toLowerCase() === trimmedEmail)
    );
    if (duplicate) {
      setStatusMessage({
        type: "warning",
        text: `"${duplicate.name}" is already a member of this group.`,
      });
      return;
    }

    setIsSubmitting(true);
    setStatusMessage(null);

    try {
      // 1. Check if user with this email already exists in profiles
      let matchedUserId: string | null = null;
      if (trimmedEmail) {
        const { data: profile } = await supabase
          .from("profiles")
          .select("id")
          .eq("email", trimmedEmail)
          .maybeSingle();

        if (profile?.id) {
          matchedUserId = profile.id;
        }
      }

      // 2. Insert member row (pre-created or linked)
      const { error: insertError } = await supabase
        .from("group_members")
        .insert({
          group_id: group.id,
          display_name: trimmedName,
          invited_email: trimmedEmail || null,
          role: "member",
          user_id: matchedUserId,
        })
        .select()
        .single();

      if (insertError) {
        setStatusMessage({
          type: "error",
          text: `Failed to add member: ${insertError.message}`,
        });
        return;
      }

      setStatusMessage({
        type: "success",
        text: `Added ${trimmedName} to ${group.name}! Share their unique invite link below so they can claim their profile.`,
      });
      setDisplayName("");
      setEmail("");
      onMemberAdded();
    } catch (err: unknown) {
      const message =
        err instanceof Error ? err.message : "An unexpected error occurred.";
      setStatusMessage({ type: "error", text: message });
    } finally {
      setIsSubmitting(false);
    }
  };

  // Rename member
  const handleRenameMember = async (memberId: string) => {
    if (!editingName.trim()) {
      setEditingMemberId(null);
      return;
    }

    const { error } = await supabase
      .from("group_members")
      .update({ display_name: editingName.trim() })
      .eq("id", memberId);

    if (error) {
      setStatusMessage({
        type: "error",
        text: `Failed to rename: ${error.message}`,
      });
    } else {
      setEditingMemberId(null);
      setEditingName("");
      onMemberAdded();
    }
  };

  // Delete member with Section 2 Deletion Guard
  const handleDeleteMember = async (member: GroupMember) => {
    // 1. Guard check in memory first
    if (!canDeleteMember(member.id, expenses)) {
      setStatusMessage({
        type: "error",
        text: `Cannot remove "${member.name}" because they are referenced as a payer or participant in existing transactions.`,
      });
      return;
    }

    const confirmed = window.confirm(
      `Are you sure you want to remove "${member.name}" from this group?`
    );
    if (!confirmed) return;

    const { error } = await supabase
      .from("group_members")
      .delete()
      .eq("id", member.id);

    if (error) {
      setStatusMessage({
        type: "error",
        text: `Failed to remove member: ${error.message}`,
      });
    } else {
      setStatusMessage({
        type: "success",
        text: `Removed "${member.name}" from the group.`,
      });
      onMemberAdded();
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
                Manage Members • {group?.name || "Group"}
              </h2>
              <p className="text-xs text-slate-500">
                Pre-create members, assign expenses immediately, and share invite links.
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

        {/* Section 1: Pre-Create Member Form */}
        <form onSubmit={handlePrecreateMember} className="space-y-3">
          <label className="text-xs font-semibold text-slate-700 flex items-center gap-1.5">
            <UserPlus className="w-3.5 h-3.5 text-slate-500" />
            Pre-Create Member Profile
          </label>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            <input
              type="text"
              placeholder="Display Name (e.g. Kev, Fitz)"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              disabled={isSubmitting}
              className="border border-slate-300 rounded-lg px-3 py-2 text-sm text-slate-900 placeholder:text-slate-400 bg-white focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent transition"
              required
            />
            <input
              type="email"
              placeholder="Email (Optional)"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              disabled={isSubmitting}
              className="border border-slate-300 rounded-lg px-3 py-2 text-sm text-slate-900 placeholder:text-slate-400 bg-white focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent transition"
            />
          </div>
          <div className="flex items-center justify-between gap-2 pt-1">
            <p className="text-[11px] text-slate-400">
              Members can be included in expenses immediately before signing up!
            </p>
            <button
              type="submit"
              disabled={isSubmitting || !displayName.trim()}
              className="bg-blue-600 hover:bg-blue-700 text-white font-medium text-xs px-4 py-2 rounded-lg transition disabled:opacity-50 disabled:cursor-not-allowed shrink-0 flex items-center gap-1.5 cursor-pointer shadow-xs"
            >
              {isSubmitting ? "Adding..." : "Add Member"}
            </button>
          </div>
        </form>

        {/* Section 2: Current Group Members & Unique Claim Links */}
        <div className="space-y-2 pt-2 border-t border-slate-100">
          <div className="flex items-center justify-between">
            <h3 className="text-xs font-semibold text-slate-700 flex items-center gap-1.5">
              <Users className="w-3.5 h-3.5 text-slate-500" />
              Members & Unique Invite Links ({currentMembers.length})
            </h3>
          </div>

          <div className="space-y-2 max-h-56 overflow-y-auto pr-1">
            {currentMembers.map((member) => {
              const isCurrentUser =
                member.userId === currentUserId || member.id === currentUserId;
              const isUnclaimed = !member.userId;
              const isEditing = editingMemberId === member.id;
              const canEditThisMember = isCurrentAdmin || isCurrentUser;
              const hasTx = !canDeleteMember(member.id, expenses);

              const initials = (member.name || "M")
                .split(" ")
                .map((n) => n[0])
                .join("")
                .slice(0, 2)
                .toUpperCase();

              return (
                <div
                  key={member.id}
                  className="flex items-center justify-between p-2.5 rounded-xl bg-slate-50 border border-slate-200/80 text-xs gap-2"
                >
                  <div className="flex items-center gap-2.5 min-w-0 flex-1">
                    <div className="w-8 h-8 rounded-full bg-blue-100 text-blue-700 font-bold flex items-center justify-center text-xs shrink-0">
                      {initials}
                    </div>

                    <div className="min-w-0 flex-1">
                      {isEditing ? (
                        <div className="flex items-center gap-1.5">
                          <input
                            type="text"
                            value={editingName}
                            onChange={(e) => setEditingName(e.target.value)}
                            className="border border-slate-300 rounded px-2 py-0.5 text-xs text-slate-900 bg-white"
                            autoFocus
                            onKeyDown={(e) => {
                              if (e.key === "Enter") {
                                handleRenameMember(member.id);
                              } else if (e.key === "Escape") {
                                setEditingMemberId(null);
                              }
                            }}
                          />
                          <button
                            type="button"
                            onClick={() => handleRenameMember(member.id)}
                            className="text-emerald-600 hover:text-emerald-700 font-bold px-1"
                          >
                            Save
                          </button>
                          <button
                            type="button"
                            onClick={() => setEditingMemberId(null)}
                            className="text-slate-400 hover:text-slate-600 px-1"
                          >
                            Cancel
                          </button>
                        </div>
                      ) : (
                        <div className="flex items-center gap-1.5">
                          <span className="font-semibold text-slate-900 truncate">
                            {member.name}
                          </span>
                          {isCurrentUser && (
                            <span className="text-[10px] text-slate-400 font-normal">
                              (You)
                            </span>
                          )}
                          {canEditThisMember && (
                            <button
                              type="button"
                              onClick={() => {
                                setEditingMemberId(member.id);
                                setEditingName(member.name);
                              }}
                              title="Rename member"
                              className="text-slate-400 hover:text-slate-600 p-0.5 cursor-pointer"
                            >
                              <Edit2 className="w-3 h-3" />
                            </button>
                          )}
                        </div>
                      )}

                      <div className="flex items-center gap-2 mt-0.5 flex-wrap">
                        {isUnclaimed ? (
                          <span className="inline-flex items-center px-1.5 py-0.2 text-[9px] font-semibold rounded bg-amber-50 text-amber-700 border border-amber-200">
                            Unclaimed Profile
                          </span>
                        ) : (
                          <span className="inline-flex items-center px-1.5 py-0.2 text-[9px] font-semibold rounded bg-emerald-50 text-emerald-700 border border-emerald-200">
                            Active Account
                          </span>
                        )}
                        {member.role === "admin" && (
                          <span className="inline-flex items-center gap-0.5 text-[9px] font-bold text-indigo-600">
                            <Shield className="w-2.5 h-2.5" />
                            Admin
                          </span>
                        )}
                        {member.invitedEmail && (
                          <span className="text-[10px] text-slate-400 truncate max-w-[120px]">
                            {member.invitedEmail}
                          </span>
                        )}
                      </div>
                    </div>
                  </div>

                  {/* Right side actions */}
                  <div className="flex items-center gap-1.5 shrink-0">
                    {/* Unique invite token copy button */}
                    {isUnclaimed && member.inviteToken && (
                      <button
                        type="button"
                        onClick={() => handleCopyMemberTokenLink(member)}
                        title="Copy unique claim link for this member"
                        className={`px-2 py-1 rounded-md text-[11px] font-medium flex items-center gap-1 transition cursor-pointer ${
                          copiedTokenId === member.id
                            ? "bg-emerald-600 text-white"
                            : "bg-blue-50 text-blue-700 hover:bg-blue-100 border border-blue-200"
                        }`}
                      >
                        {copiedTokenId === member.id ? (
                          <>
                            <Check className="w-3 h-3" />
                            Copied Link
                          </>
                        ) : (
                          <>
                            <Share2 className="w-3 h-3" />
                            Copy Link
                          </>
                        )}
                      </button>
                    )}

                    {/* Delete member guard button */}
                    {isCurrentAdmin && !isCurrentUser && (
                      <button
                        type="button"
                        onClick={() => handleDeleteMember(member)}
                        title={
                          hasTx
                            ? "Cannot delete: Member has transactions"
                            : "Remove member"
                        }
                        disabled={hasTx}
                        className={`p-1.5 rounded-lg transition ${
                          hasTx
                            ? "text-slate-300 cursor-not-allowed opacity-50"
                            : "text-slate-400 hover:text-red-600 hover:bg-red-50 cursor-pointer"
                        }`}
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {/* Section 3: General Group Join Link */}
        <div className="space-y-2 pt-2 border-t border-slate-100">
          <label className="text-xs font-semibold text-slate-700 flex items-center justify-between">
            <span className="flex items-center gap-1.5">
              <Share2 className="w-3.5 h-3.5 text-slate-500" />
              General Group Join Link
            </span>
          </label>
          <div className="flex gap-2">
            <input
              type="text"
              readOnly
              value={generalInviteUrl}
              onFocus={(e) => e.target.select()}
              className="flex-1 border border-slate-300 rounded-lg px-3 py-2 text-xs text-slate-600 bg-slate-50 select-all font-mono"
            />
            <button
              type="button"
              onClick={handleCopyGeneralLink}
              className={`px-3.5 py-2 rounded-lg text-xs font-semibold flex items-center gap-1.5 transition shrink-0 cursor-pointer ${
                copiedGeneral
                  ? "bg-emerald-600 text-white"
                  : "bg-slate-900 text-white hover:bg-slate-800"
              }`}
            >
              {copiedGeneral ? (
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
        </div>

        {/* Footer */}
        <div className="pt-2 flex justify-end">
          <button
            type="button"
            onClick={handleClose}
            className="px-4 py-2 bg-slate-100 hover:bg-slate-200 text-slate-700 font-medium text-xs rounded-lg transition cursor-pointer"
          >
            Done
          </button>
        </div>
      </div>
    </dialog>
  );
}
