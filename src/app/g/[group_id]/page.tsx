"use client";

import { Suspense, useEffect } from "react";
import { useParams, useRouter, useSearchParams } from "next/navigation";

function LegacyGroupRedirect() {
  const router = useRouter();
  const params = useParams<{ group_id: string }>();
  const searchParams = useSearchParams();
  const groupId = typeof params?.group_id === "string" ? params.group_id : "";
  const memberParam = searchParams.get("m");

  useEffect(() => {
    if (groupId) {
      const target = memberParam
        ? `/${groupId}?m=${encodeURIComponent(memberParam)}`
        : `/${groupId}`;
      router.replace(target);
    } else {
      router.replace("/");
    }
  }, [groupId, memberParam, router]);

  return (
    <div className="min-h-screen flex items-center justify-center p-6 bg-slate-50">
      <div className="text-xs text-slate-500 font-medium">
        Redirecting to group...
      </div>
    </div>
  );
}

export default function LegacyGroupPage() {
  return (
    <Suspense
      fallback={
        <div className="min-h-screen flex items-center justify-center p-6 bg-slate-50">
          <div className="text-xs text-slate-500 font-medium">
            Redirecting to group...
          </div>
        </div>
      }
    >
      <LegacyGroupRedirect />
    </Suspense>
  );
}
