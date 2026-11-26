"use client";

import { Suspense } from "react";
import { useParams } from "next/navigation";
import { SettleUpDashboard } from "@/app/page";
import { safeDecodeUrlComponent } from "@/lib/reconciliation";

function SlugGroupContent() {
  const params = useParams<{ slug?: string; member?: string | string[] }>();
  const slug = typeof params?.slug === "string" ? params.slug : "";
  const segs = Array.isArray(params?.member)
    ? params.member.filter(Boolean)
    : typeof params?.member === "string" && params.member
      ? [params.member]
      : [];

  let isSettlePage = false;
  let rawMember = "";
  if (segs.length === 1 && segs[0].toLowerCase() === "settle") {
    isSettlePage = true;
  } else if (segs.length >= 2 && segs[1].toLowerCase() === "settle") {
    isSettlePage = true;
    rawMember = segs[0];
  } else if (segs.length >= 1) {
    rawMember = segs[0];
  }

  const initialMember = rawMember
    ? safeDecodeUrlComponent(rawMember).trim()
    : "";

  return (
    <SettleUpDashboard
      initialSlug={slug}
      initialMember={initialMember || undefined}
      initialView={isSettlePage ? "settle" : "dashboard"}
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
