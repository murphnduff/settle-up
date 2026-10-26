import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

function resolveExtension(fileName: string, mimeType: string): string {
  const lowerMime = mimeType.toLowerCase();
  if (lowerMime.includes("pdf") || /\.pdf$/i.test(fileName)) return "pdf";
  if (lowerMime.includes("png") || /\.png$/i.test(fileName)) return "png";
  if (lowerMime.includes("webp") || /\.webp$/i.test(fileName)) return "webp";
  if (lowerMime.includes("heic") || /\.heic$/i.test(fileName)) return "heic";
  if (lowerMime.includes("heif") || /\.heif$/i.test(fileName)) return "heif";
  const match = fileName.match(/\.([a-z0-9]{2,5})$/i);
  if (match) {
    return match[1].toLowerCase();
  }
  return "jpg";
}

export async function POST(request: NextRequest) {
  const origin = request.nextUrl.origin;

  try {
    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
    const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY?.trim();

    if (!supabaseUrl || !supabaseAnonKey) {
      return NextResponse.redirect(
        new URL("/?share_error=missing_supabase_config", origin),
        303
      );
    }

    const formData = await request.formData();
    let sharedFile: File | null = null;

    const primaryEntry = formData.get("file");
    if (primaryEntry instanceof File && primaryEntry.size > 0) {
      sharedFile = primaryEntry;
    } else {
      for (const [, value] of formData.entries()) {
        if (value instanceof File && value.size > 0) {
          sharedFile = value;
          break;
        }
      }
    }

    if (!sharedFile) {
      return NextResponse.redirect(
        new URL("/?share_error=no_file_received", origin),
        303
      );
    }

    const mimeType = sharedFile.type || "image/jpeg";
    const ext = resolveExtension(sharedFile.name || "", mimeType);
    const storagePath = `shared/${crypto.randomUUID()}.${ext}`;

    const supabase = createClient(supabaseUrl, supabaseAnonKey);
    const arrayBuffer = await sharedFile.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    const { error: uploadError } = await supabase.storage
      .from("receipts")
      .upload(storagePath, buffer, {
        contentType: mimeType,
        upsert: false,
      });

    if (uploadError) {
      return NextResponse.redirect(
        new URL(
          `/?share_error=${encodeURIComponent(uploadError.message)}`,
          origin
        ),
        303
      );
    }

    const { data: publicUrlData } = supabase.storage
      .from("receipts")
      .getPublicUrl(storagePath);

    const publicUrl = publicUrlData?.publicUrl;
    if (!publicUrl) {
      return NextResponse.redirect(
        new URL("/?share_error=missing_public_url", origin),
        303
      );
    }

    // Check if an explicit group slug was passed via query param or form field
    const explicitGroup =
      request.nextUrl.searchParams.get("group")?.trim() ||
      (typeof formData.get("group") === "string"
        ? (formData.get("group") as string).trim()
        : "");

    const targetPath = explicitGroup
      ? `/${encodeURIComponent(explicitGroup)}?shared_receipt=${encodeURIComponent(publicUrl)}`
      : `/?shared_receipt=${encodeURIComponent(publicUrl)}`;

    return NextResponse.redirect(new URL(targetPath, origin), 303);
  } catch (err: unknown) {
    const msg =
      err instanceof Error ? err.message : "Failed to process shared receipt.";
    return NextResponse.redirect(
      new URL(`/?share_error=${encodeURIComponent(msg)}`, origin),
      303
    );
  }
}

export async function GET(request: NextRequest) {
  return NextResponse.redirect(new URL("/", request.nextUrl.origin), 303);
}

