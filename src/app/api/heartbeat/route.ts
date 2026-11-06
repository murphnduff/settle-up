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
        error: "Missing Supabase environment variables",
        timestamp,
      },
      {
        status: 500,
        headers: { "Cache-Control": "no-store, max-age=0" },
      }
    );
  }

  try {
    const supabase = createClient(supabaseUrl, supabaseKey, {
      auth: { persistSession: false },
      global: {
        fetch: (url, options = {}) =>
          fetch(url, { ...options, cache: "no-store" }),
      },
    });

    const warnings: string[] = [];
    let reachedSupabase = false;
    let groupsCount = 0;

    // 1. Query groups, group_members, expenses, and storage independently
    const [groupsRes, membersRes, expensesRes, storageRes] = await Promise.all([
      supabase
        .from("groups")
        .select("id", { count: "exact" })
        .order("created_at", { ascending: false })
        .limit(1),
      supabase
        .from("group_members")
        .select("id", { count: "exact" })
        .limit(1),
      supabase
        .from("expenses")
        .select("id", { count: "exact" })
        .order("created_at", { ascending: false })
        .limit(1),
      supabase.storage.from("receipts").list("", { limit: 1 }),
    ]);

    if (groupsRes.error) {
      warnings.push(`groups: ${groupsRes.error.message}`);
    } else {
      reachedSupabase = true;
      groupsCount = groupsRes.count ?? groupsRes.data?.length ?? 0;
    }

    if (membersRes.error) {
      warnings.push(`group_members: ${membersRes.error.message}`);
    } else {
      reachedSupabase = true;
    }

    if (expensesRes.error) {
      warnings.push(`expenses: ${expensesRes.error.message}`);
    } else {
      reachedSupabase = true;
    }

    if (storageRes.error) {
      warnings.push(`storage.receipts: ${storageRes.error.message}`);
    } else {
      reachedSupabase = true;
    }

    // 2. Insert persistent heartbeat log row
    const { error: insertError } = await supabase.from("heartbeat_logs").insert({
      triggered_by: triggeredBy,
      groups_count: groupsCount,
    });

    if (insertError) {
      warnings.push(`heartbeat_logs.insert: ${insertError.message}`);
    } else {
      reachedSupabase = true;
    }

    // 3. Prune heartbeat_logs older than 30 days using a valid JS ISO string
    const thirtyDaysAgoIso = new Date(
      Date.now() - 30 * 24 * 60 * 60 * 1000
    ).toISOString();

    const { error: cleanupError } = await supabase
      .from("heartbeat_logs")
      .delete()
      .lt("created_at", thirtyDaysAgoIso);

    if (cleanupError) {
      warnings.push(`heartbeat_logs.cleanup: ${cleanupError.message}`);
    } else {
      reachedSupabase = true;
    }

    if (!reachedSupabase) {
      const fatalMsg =
        warnings.join("; ") || "Supabase is completely unreachable";
      return NextResponse.json(
        {
          ok: false,
          error: fatalMsg,
          warnings,
          timestamp,
        },
        {
          status: 500,
          headers: { "Cache-Control": "no-store, max-age=0" },
        }
      );
    }

    console.log("[Heartbeat]", {
      triggered_by: triggeredBy,
      groupsCount,
      warnings: warnings.length > 0 ? warnings : undefined,
      timestamp,
    });

    return NextResponse.json(
      {
        ok: true,
        status: "ok",
        triggeredBy,
        groupsCount,
        timestamp,
        ...(warnings.length > 0 ? { warnings } : {}),
      },
      {
        headers: {
          "Cache-Control": "no-store, max-age=0",
        },
      }
    );
  } catch (err: unknown) {
    const errorMessage =
      err instanceof Error ? err.message : "Unexpected heartbeat error";
    return NextResponse.json(
      {
        ok: false,
        error: errorMessage,
        timestamp,
      },
      {
        status: 500,
        headers: { "Cache-Control": "no-store, max-age=0" },
      }
    );
  }
}





