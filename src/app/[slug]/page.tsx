"use client";

import { Suspense } from "react";
import { useParams } from "next/navigation";
import { SettleUpDashboard } from "@/app/page";

function SlugGroupContent() {
  const params = useParams<{ slug: string }>();
  const slug = typeof params?.slug === "string" ? params.slug : "";

  return <SettleUpDashboard initialSlug={slug} />;
}

export default function SlugGroupPage() {
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
      <SlugGroupContent />
    </Suspense>
  );
}

