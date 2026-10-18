"use client";

import { Suspense } from "react";
import { useParams } from "next/navigation";
import { SettleUpDashboard } from "@/app/page";

function GroupRouteContent() {
  const params = useParams<{ group_id: string }>();
  const groupId = typeof params?.group_id === "string" ? params.group_id : "";

  return <SettleUpDashboard initialGroupId={groupId} />;
}

export default function GroupPage() {
  return (
    <Suspense
      fallback={
        <div className="min-h-screen flex items-center justify-center p-6 bg-slate-50">
          <div className="text-xs text-slate-500 font-medium">
            Loading group ledger...
          </div>
        </div>
      }
    >
      <GroupRouteContent />
    </Suspense>
  );
}

