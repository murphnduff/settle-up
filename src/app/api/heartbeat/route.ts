import { NextResponse, connection } from "next/server";
import { createClient } from "@supabase/supabase-js";

export async function GET() {
  await connection();

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  if (!supabaseUrl || !supabaseKey) {
    return NextResponse.json(
      {
        status: "error",
        message: "Missing Supabase environment variables",
        timestamp: new Date().toISOString(),
      },
      { status: 500 }
    );
  }

  const supabase = createClient(supabaseUrl, supabaseKey);
  const { error } = await supabase.from("groups").select("id").limit(1);

  if (error) {
    return NextResponse.json(
      {
        status: "error",
        message: error.message,
        timestamp: new Date().toISOString(),
      },
      { status: 500 }
    );
  }

  return NextResponse.json({
    status: "ok",
    timestamp: new Date().toISOString(),
  });
}

