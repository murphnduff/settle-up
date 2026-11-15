"use client";

import { Suspense } from "react";
import { useParams } from "next/navigation";
import { SettleUpDashboard } from "@/app/page";
import { safeDecodeUrlComponent } from "@/lib/reconciliation";

function SlugGroupContent() {
  const params = useParams<{ slug?: string; member?: string | string[] }>();
  const slug = typeof params?.slug === "string" ? params.slug : "";
  const rawMember = Array.isArray(params?.member)
    ? params.member[0] || ""
    : typeof params?.member === "string"
      ? params.member
      : "";
  const initialMember = rawMember
    ? safeDecodeUrlComponent(rawMember).trim()
    : "";

  return (
    <SettleUpDashboard
      initialSlug={slug}
      initialMember={initialMember || undefined}
    />
  );
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
