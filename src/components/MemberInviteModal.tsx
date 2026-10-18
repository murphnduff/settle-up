"use client";

import { useState, useEffect, useRef } from "react";
import { createClient } from "@/lib/supabase";
import { canDeleteMember, ExpenseRecord } from "@/lib/reconciliation";
import {
  UserPlus,
  X,
  Check,
  Users,
  Shield,
  AlertCircle,
  CheckCircle2,
  Trash2,
  Edit2,
  Share2,
  Link2,
} from "lucide-react";

export interface GroupMember {
  id: string; // group_members.id
  groupId?: string;
  name: string; // display_name
  displayName?: string;
}

export interface Group {
  id: string;
  name: string;
  created_by?: string | null;
  created_at?: string;
}

interface MemberInviteModalProps {
  isOpen: boolean;
  onClose: () => void;
  group: Group | null;
  currentMembers: GroupMember[];
  isSuperAdmin: boolean;
  activeMemberId?: string;
  expenses: ExpenseRecord[];
  onMemberAdded: () => void;
}

export default function MemberInviteModal({
  isOpen,
  onClose,
  group,
  currentMembers,
  isSuperAdmin,
  activeMemberId,
  expenses,
  onMemberAdded,
}: MemberInviteModalProps) {
  const supabase = createClient();
  const dialogRef = useRef<HTMLDialogElement>(null);

  // Form state for adding a member (display_name only)
  const [displayName, setDisplayName] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [statusMessage, setStatusMessage] = useState<{
    type: "success" | "error" | "info" | "warning";
    text: string;
  } | null>(null);

  // Copy tracking states
  const [copiedGroupLink, setCopiedGroupLink] = useState(false);
  const [copiedMemberId, setCopiedMemberId] = useState<string | null>(null);

  // Renaming state
  const [editingMemberId, setEditingMemberId] = useState<string | null>(null);
  const [editingName, setEditingName] = useState("");

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

  const getGroupShareUrl = () => {
    if (!group) return "";
    const origin =
      typeof window !== "undefined"
        ? window.location.origin
        : "https://split.murphnduff.org";
    return `${origin}/g/${group.id}`;
  };

  const handleCopyGroupLink = async () => {
    if (!group) return;
    const url = getGroupShareUrl();
    const ok = await copyToClipboard(url);
    if (ok) {
      setCopiedGroupLink(true);
      setTimeout(() => setCopiedGroupLink(false), 2500);
    }
  };

  const handleCopyMemberLink = async (member: GroupMember) => {
    if (!group) return;
    const url = `${getGroupShareUrl()}?m=${member.id}`;
    const ok = await copyToClipboard(url);
    if (ok) {
      setCopiedMemberId(member.id);
      setTimeout(() => setCopiedMemberId(null), 2500);
    }
  };

  // Add member (Super-Admin only, display_name only)
  const handleAddMember = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!group) return;

    if (!isSuperAdmin) {
      setStatusMessage({
        type: "error",
        text: "Only the Super-Admin (murph@murphnduff.org) can add or remove members.",
      });
      return;
    }

    const trimmedName = displayName.trim();

    if (!trimmedName) {
      setStatusMessage({
        type: "warning",
        text: "Please enter a display name for the member.",
      });
      return;
    }

    // Case-insensitive duplicate check within this group
    const duplicate = currentMembers.find(
      (m) => m.name.trim().toLowerCase() === trimmedName.toLowerCase()
    );
    if (duplicate) {
      setStatusMessage({
        type: "warning",
        text: `"${duplicate.name}" is already in this group.`,
      });
      return;
    }

    setIsSubmitting(true);
    setStatusMessage(null);

    try {
      const { error: insertError } = await supabase
        .from("group_members")
        .insert({
          group_id: group.id,
          display_name: trimmedName,
        });

      if (insertError) {
        setStatusMessage({
          type: "error",
          text: `Failed to add member: ${insertError.message}`,
        });
        return;
      }

      setStatusMessage({
        type: "success",
        text: `Added "${trimmedName}"! Share the group link or their direct link below.`,
      });
      setDisplayName("");
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
    const trimmed = editingName.trim();
    if (!trimmed) {
      setEditingMemberId(null);
      return;
    }

    const duplicate = currentMembers.find(
      (m) =>
        m.id !== memberId &&
        m.name.trim().toLowerCase() === trimmed.toLowerCase()
    );
    if (duplicate) {
      setStatusMessage({
        type: "warning",
        text: `"${duplicate.name}" is already in this group.`,
      });
      return;
    }

    const { error } = await supabase
      .from("group_members")
      .update({ display_name: trimmed })
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

  // Delete member with Section 2 Deletion Guard (Super-Admin only)
  const handleDeleteMember = async (member: GroupMember) => {
    if (!isSuperAdmin) return;

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
      <div className="p-6 space-y-5">
        {/* Header */}
        <div className="flex items-start justify-between">
          <div className="flex items-center gap-3">
            <div className="p-2.5 bg-blue-50 text-blue-600 rounded-xl">
              {isSuperAdmin ? (
                <UserPlus className="w-5 h-5" />
              ) : (
                <Users className="w-5 h-5" />
              )}
            </div>
            <div>
              <h2
                id="invite-modal-title"
                className="text-lg font-bold text-slate-900"
              >
                {isSuperAdmin ? "Manage Members" : "Group Members & Links"} •{" "}
                {group?.name || "Group"}
              </h2>
              <p className="text-xs text-slate-500">
                {isSuperAdmin
                  ? "Add member profiles and share no-login group or member links."
                  : "Copy the group link or your direct member link to share."}
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

        {/* Shareable Group URL Card */}
        {group && (
          <div className="p-3.5 bg-blue-50/70 border border-blue-200 rounded-xl space-y-2">
            <div className="flex items-center justify-between gap-2">
              <div className="min-w-0">
                <span className="text-xs font-bold text-blue-900 flex items-center gap-1.5">
                  <Link2 className="w-3.5 h-3.5 text-blue-600 shrink-0" />
                  Main Group Link (No Login Required)
                </span>
                <p className="text-[11px] text-blue-700 truncate mt-0.5 font-mono">
                  {getGroupShareUrl()}
                </p>
              </div>
              <button
                type="button"
                onClick={handleCopyGroupLink}
                className={`px-3 py-1.5 rounded-lg text-xs font-semibold flex items-center gap-1.5 shrink-0 transition cursor-pointer shadow-2xs ${
                  copiedGroupLink
                    ? "bg-emerald-600 text-white"
                    : "bg-blue-600 hover:bg-blue-700 text-white"
                }`}
              >
                {copiedGroupLink ? (
                  <>
                    <Check className="w-3.5 h-3.5" />
                    Copied!
                  </>
                ) : (
                  <>
                    <Share2 className="w-3.5 h-3.5" />
                    Copy Group Link
                  </>
                )}
              </button>
            </div>
          </div>
        )}

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

        {/* Section 1: Add Member Form (Strictly Super-Admin Only, display_name only) */}
        {isSuperAdmin ? (
          <form onSubmit={handleAddMember} className="space-y-2.5">
            <label className="text-xs font-semibold text-slate-700 flex items-center gap-1.5">
              <UserPlus className="w-3.5 h-3.5 text-slate-500" />
              Add Member to Group
            </label>
            <div className="flex gap-2">
              <input
                type="text"
                placeholder="Member display name (e.g. Kev, Fitz, Sarah)"
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                disabled={isSubmitting}
                className="flex-1 border border-slate-300 rounded-lg px-3 py-2 text-sm text-slate-900 placeholder:text-slate-400 bg-white focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent transition"
                required
              />
              <button
                type="submit"
                disabled={isSubmitting || !displayName.trim()}
                className="bg-slate-900 hover:bg-slate-800 text-white font-semibold text-xs px-4 py-2 rounded-lg transition disabled:opacity-50 disabled:cursor-not-allowed shrink-0 flex items-center gap-1.5 cursor-pointer shadow-xs"
              >
                <UserPlus className="w-3.5 h-3.5" />
                {isSubmitting ? "Adding..." : "Add Member"}
              </button>
            </div>
          </form>
        ) : (
          <div className="p-3 bg-slate-50 border border-slate-200 rounded-xl text-xs text-slate-500 flex items-center gap-2">
            <Shield className="w-4 h-4 text-slate-400 shrink-0" />
            <span>
              Anyone with the group link can add or edit transactions. Only the Super-Admin can add or remove group members.
            </span>
          </div>
        )}

        {/* Section 2: Current Group Members & Pre-Selected Direct Links */}
        <div className="space-y-2 pt-2 border-t border-slate-100">
          <div className="flex items-center justify-between">
            <h3 className="text-xs font-semibold text-slate-700 flex items-center gap-1.5">
              <Users className="w-3.5 h-3.5 text-slate-500" />
              Members ({currentMembers.length})
            </h3>
            <span className="text-[11px] text-slate-400">
              Direct links auto-select that member
            </span>
          </div>

          <div className="space-y-2 max-h-64 overflow-y-auto pr-1">
            {currentMembers.length === 0 ? (
              <p className="text-xs text-slate-400 italic py-4 text-center">
                No members in this group yet.
              </p>
            ) : (
              currentMembers.map((member) => {
                const isSelectedIdentity = member.id === activeMemberId;
                const isEditing = editingMemberId === member.id;
                const canEditThisMember = isSuperAdmin || isSelectedIdentity;
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
                              className="text-emerald-600 hover:text-emerald-700 font-bold px-1 cursor-pointer"
                            >
                              Save
                            </button>
                            <button
                              type="button"
                              onClick={() => setEditingMemberId(null)}
                              className="text-slate-400 hover:text-slate-600 px-1 cursor-pointer"
                            >
                              Cancel
                            </button>
                          </div>
                        ) : (
                          <div className="flex items-center gap-1.5">
                            <span className="font-semibold text-slate-900 truncate">
                              {member.name}
                            </span>
                            {isSelectedIdentity && (
                              <span className="text-[10px] text-blue-600 font-semibold">
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
                      </div>
                    </div>

                    {/* Right side actions: Copy Direct Member Link + Super-Admin Delete */}
                    <div className="flex items-center gap-1.5 shrink-0">
                      <button
                        type="button"
                        onClick={() => handleCopyMemberLink(member)}
                        title={`Copy direct link pre-selected as ${member.name}`}
                        className={`px-2.5 py-1 rounded-md text-[11px] font-medium flex items-center gap-1 transition cursor-pointer ${
                          copiedMemberId === member.id
                            ? "bg-emerald-600 text-white"
                            : "bg-white text-slate-700 border border-slate-200 hover:bg-slate-100"
                        }`}
                      >
                        {copiedMemberId === member.id ? (
                          <>
                            <Check className="w-3 h-3" />
                            Copied
                          </>
                        ) : (
                          <>
                            <Share2 className="w-3 h-3" />
                            Copy {member.name}&apos;s Link
                          </>
                        )}
                      </button>

                      {isSuperAdmin && (
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
              })
            )}
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
