import { NextResponse, connection } from "next/server";
import { createClient } from "@supabase/supabase-js";

// Note: `nextConfig.cacheComponents` is enabled in `next.config.ts`, which disallows
// legacy `export const dynamic` / `export const revalidate` segment configs at build time.
// Calling `await connection()` below forces dynamic request-time execution on every invocation.

export async function GET() {
  await connection();

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  if (!supabaseUrl || !supabaseKey) {
    return NextResponse.json(
      {
        ok: false,
        status: "error",
        message: "Missing Supabase environment variables",
        timestamp: new Date().toISOString(),
      },
      {
        status: 500,
        headers: { "Cache-Control": "no-store" },
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

  const firstError =
    groupsRes.error || membersRes.error || expensesRes.error || storageRes.error;

  if (firstError) {
    return NextResponse.json(
      {
        ok: false,
        status: "error",
        message: firstError.message,
        timestamp: new Date().toISOString(),
      },
      {
        status: 500,
        headers: { "Cache-Control": "no-store" },
      }
    );
  }

  const groupsCount = groupsRes.count ?? groupsRes.data?.length ?? 0;

  return NextResponse.json(
    {
      ok: true,
      status: "ok",
      timestamp: new Date().toISOString(),
      groupsCount,
      membersCount: membersRes.count ?? membersRes.data?.length ?? 0,
      expensesCount: expensesRes.count ?? expensesRes.data?.length ?? 0,
      receiptsChecked: storageRes.data?.length ?? 0,
    },
    {
      headers: {
        "Cache-Control": "no-store",
      },
    }
  );
}



