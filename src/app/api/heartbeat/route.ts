import { NextRequest, NextResponse, connection } from "next/server";
import { createClient } from "@supabase/supabase-js";

// Note: `nextConfig.cacheComponents` is enabled in `next.config.ts`, which disallows
// legacy `export const dynamic = 'force-dynamic'` / `export const revalidate = 0` exports.
// Calling `await connection()` and reading `request.headers` guarantees dynamic request-time execution.

export async function GET(request: NextRequest) {
  await connection();

  const timestamp = new Date().toISOString();
  const userAgent = request.headers.get("user-agent") || "manual";
  const triggeredBy = userAgent.slice(0, 120);

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  if (!supabaseUrl || !supabaseKey) {
    return NextResponse.json(
      {
        ok: false,
        status: "error",
        message: "Missing Supabase environment variables",
        timestamp,
      },
      {
        status: 500,
        headers: { "Cache-Control": "no-store, max-age=0" },
      }
    );
  }

  const supabase = createClient(supabaseUrl, supabaseKey, {
    auth: { persistSession: false },
    global: {
      fetch: (url, options = {}) =>
        fetch(url, { ...options, cache: "no-store" }),
    },
  });

  const [groupsRes, membersRes, expensesRes, storageRes] = await Promise.all([
    supabase
      .from("groups")
      .select("id", { count: "exact" })
      .order("created_at", { ascending: false })
      .limit(1),
    supabase
      .from("group_members")
      .select("id", { count: "exact" })
      .order("created_at", { ascending: false })
      .limit(1),
    supabase
      .from("expenses")
      .select("id", { count: "exact" })
      .order("created_at", { ascending: false })
      .limit(1),
    supabase.storage.from("receipts").list("", { limit: 1 }),
  ]);

  const queryError =
    groupsRes.error || membersRes.error || expensesRes.error || storageRes.error;

  if (queryError) {
    return NextResponse.json(
      {
        ok: false,
        status: "error",
        message: queryError.message,
        timestamp,
      },
      {
        status: 500,
        headers: { "Cache-Control": "no-store, max-age=0" },
      }
    );
  }

  const groupsCount = groupsRes.count ?? groupsRes.data?.length ?? 0;

  const { error: insertError } = await supabase.from("heartbeat_logs").insert({
    triggered_by: triggeredBy,
    groups_count: groupsCount,
  });

  if (insertError) {
    return NextResponse.json(
      {
        ok: false,
        status: "error",
        message: insertError.message,
        timestamp,
      },
      {
        status: 500,
        headers: { "Cache-Control": "no-store, max-age=0" },
      }
    );
  }

  const thirtyDaysAgoIso = new Date(
    Date.now() - 30 * 24 * 60 * 60 * 1000
  ).toISOString();

  const { error: cleanupError } = await supabase
    .from("heartbeat_logs")
    .delete()
    .lt("created_at", thirtyDaysAgoIso);

  if (cleanupError) {
    console.warn("[Heartbeat] Failed to prune old heartbeat_logs:", cleanupError.message);
  }

  console.log("[Heartbeat]", {
    triggered_by: triggeredBy,
    groupsCount,
    timestamp,
  });

  return NextResponse.json(
    {
      ok: true,
      status: "ok",
      triggeredBy,
      groupsCount,
      timestamp,
    },
    {
      headers: {
        "Cache-Control": "no-store, max-age=0",
      },
    }
  );
}




