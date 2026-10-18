"use client";

import { useEffect, Suspense } from "react";
import { useRouter, useSearchParams } from "next/navigation";

function JoinRedirectContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const groupId = searchParams.get("groupId") || searchParams.get("join");
  const memberId = searchParams.get("m");

  useEffect(() => {
    if (groupId) {
      const target = memberId
        ? `/${groupId}?m=${encodeURIComponent(memberId)}`
        : `/${groupId}`;
      router.replace(target);
    } else {
      router.replace("/");
    }
  }, [groupId, memberId, router]);

  return (
    <main className="min-h-screen flex items-center justify-center p-6 bg-slate-50">
      <div className="text-xs text-slate-500 font-medium">
        Redirecting to group...
      </div>
    </main>
  );
}

export default function JoinPage() {
  return (
    <Suspense
      fallback={
        <div className="min-h-screen flex items-center justify-center p-6 bg-slate-50">
          <div className="text-xs text-slate-500 font-medium">
            Loading group link...
          </div>
        </div>
      }
    >
      <JoinRedirectContent />
    </Suspense>
  );
}
