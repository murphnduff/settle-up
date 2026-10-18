"use client";

import { useEffect, useState, Suspense } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { createClient } from "@/lib/supabase";
import { Users, AlertCircle, CheckCircle2, ArrowRight } from "lucide-react";

function JoinContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const token = searchParams.get("token");
  const joinGroupId = searchParams.get("join");

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [unauthenticated, setUnauthenticated] = useState(false);

  useEffect(() => {
    const supabase = createClient();

    async function handleJoin() {
      // 1. Check current auth status
      const {
        data: { user },
      } = await supabase.auth.getUser();

      if (!user) {
        // Save invite token in session storage for after OAuth login
        if (token) {
          sessionStorage.setItem("settle_up_invite_token", token);
        } else if (joinGroupId) {
          sessionStorage.setItem("settle_up_join_group", joinGroupId);
        }
        setUnauthenticated(true);
        setLoading(false);
        return;
      }

      // 2. Process token-based invite claim
      if (token) {
        try {
          const { data, error: rpcError } = await supabase.rpc(
            "claim_invite_token",
            { p_token: token }
          );

          if (rpcError) {
            setError(rpcError.message || "Failed to claim invite link.");
            setLoading(false);
            return;
          }

          sessionStorage.removeItem("settle_up_invite_token");
          setSuccess("You have successfully claimed your group member spot!");
          setTimeout(() => {
            router.push(`/?groupId=${data.group_id}`);
          }, 1200);
        } catch (err: unknown) {
          const message =
            err instanceof Error ? err.message : "Unexpected error claiming invite.";
          setError(message);
          setLoading(false);
        }
        return;
      }

      // 3. Process fallback group-id join
      if (joinGroupId) {
        try {
          const { data: existing } = await supabase
            .from("group_members")
            .select("id")
            .eq("group_id", joinGroupId)
            .eq("user_id", user.id)
            .maybeSingle();

          if (!existing) {
            const { error: insertError } = await supabase
              .from("group_members")
              .insert({
                group_id: joinGroupId,
                user_id: user.id,
                display_name:
                  user.user_metadata?.full_name ||
                  user.email?.split("@")[0] ||
                  "Member",
                role: "member",
              });

            if (insertError) {
              setError(insertError.message);
              setLoading(false);
              return;
            }
          }

          sessionStorage.removeItem("settle_up_join_group");
          setSuccess("Welcome! You have joined the group.");
          setTimeout(() => {
            router.push(`/?groupId=${joinGroupId}`);
          }, 1200);
        } catch (err: unknown) {
          const message =
            err instanceof Error ? err.message : "Unexpected error joining group.";
          setError(message);
          setLoading(false);
        }
        return;
      }

      setError("No invite token or group ID provided.");
      setLoading(false);
    }

    handleJoin();
  }, [token, joinGroupId, router]);

  const handleSignIn = async () => {
    const supabase = createClient();
    await supabase.auth.signInWithOAuth({
      provider: "google",
      options: { redirectTo: window.location.href },
    });
  };

  return (
    <main className="min-h-screen flex items-center justify-center p-6 bg-slate-50">
      <div className="p-8 bg-white border border-slate-200 rounded-2xl shadow-sm text-center max-w-sm w-full space-y-5">
        <div className="mx-auto w-12 h-12 rounded-xl bg-blue-50 text-blue-600 flex items-center justify-center font-bold text-xl">
          <Users className="w-6 h-6 text-blue-600" />
        </div>

        <div>
          <h1 className="text-xl font-bold tracking-tight text-slate-900 mb-1">
            Group Invitation
          </h1>
          <p className="text-xs text-slate-500">
            Accept your invitation to track expenses and settle debts.
          </p>
        </div>

        {loading && (
          <div className="py-6 flex flex-col items-center justify-center gap-2">
            <div className="w-6 h-6 border-2 border-blue-600 border-t-transparent rounded-full animate-spin" />
            <p className="text-xs text-slate-500 font-medium">
              Verifying and claiming invite...
            </p>
          </div>
        )}

        {unauthenticated && (
          <div className="space-y-4 pt-2">
            <div className="p-3 bg-blue-50 border border-blue-200 rounded-xl text-xs text-blue-800 text-left flex items-start gap-2">
              <Users className="w-4 h-4 text-blue-600 shrink-0 mt-0.5" />
              <span>
                Please sign in with Google to accept this invite and link your account.
              </span>
            </div>
            <button
              onClick={handleSignIn}
              className="w-full bg-blue-600 hover:bg-blue-700 text-white font-medium py-2.5 px-4 rounded-xl transition shadow-xs cursor-pointer text-sm"
            >
              Sign in with Google
            </button>
          </div>
        )}

        {error && (
          <div className="space-y-4">
            <div className="p-3 bg-red-50 border border-red-200 rounded-xl text-xs text-red-800 text-left flex items-start gap-2">
              <AlertCircle className="w-4 h-4 text-red-600 shrink-0 mt-0.5" />
              <span>{error}</span>
            </div>
            <button
              onClick={() => router.push("/")}
              className="w-full bg-slate-900 hover:bg-slate-800 text-white font-medium py-2.5 px-4 rounded-xl transition text-xs flex items-center justify-center gap-1.5"
            >
              Go to Dashboard
              <ArrowRight className="w-3.5 h-3.5" />
            </button>
          </div>
        )}

        {success && (
          <div className="p-3 bg-emerald-50 border border-emerald-200 rounded-xl text-xs text-emerald-800 text-left flex items-start gap-2">
            <CheckCircle2 className="w-4 h-4 text-emerald-600 shrink-0 mt-0.5" />
            <span>{success}</span>
          </div>
        )}
      </div>
    </main>
  );
}

export default function JoinPage() {
  return (
    <Suspense
      fallback={
        <div className="min-h-screen flex items-center justify-center p-6 bg-slate-50">
          <div className="text-xs text-slate-500 font-medium">Loading invite...</div>
        </div>
      }
    >
      <JoinContent />
    </Suspense>
  );
}

