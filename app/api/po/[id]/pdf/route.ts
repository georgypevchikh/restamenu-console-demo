import { NextResponse, type NextRequest } from "next/server";
import { getRestaurantContext } from "@/lib/current-restaurant";

/**
 * Browser-facing PDF download. Proxies to the generate-po-pdf Edge Function
 * with the caller's own session token — the browser never needs to hold a
 * function URL or send custom headers, and RLS still decides whether this
 * user may render this document.
 */
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const context = await getRestaurantContext();
  if (!context) {
    return NextResponse.redirect(new URL("/login", _req.url));
  }
  const {
    data: { session },
    error: sessionError,
  } = await context.supabase.auth.getSession();
  if (sessionError) {
    return NextResponse.json(
      { error: "session_unavailable" },
      {
        status: 500,
        headers: { "Cache-Control": "private, no-store, max-age=0" },
      },
    );
  }
  if (!session) {
    return NextResponse.redirect(new URL("/login", _req.url));
  }

  const res = await fetch(
    `${process.env.NEXT_PUBLIC_SUPABASE_URL}/functions/v1/generate-po-pdf`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${session.access_token}`,
        apikey: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
        "X-Restamenu-Restaurant-Id": context.active.id,
      },
      body: JSON.stringify({ poId: id }),
      cache: "no-store",
    },
  );

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    return NextResponse.json(
      {
        error: "pdf_generation_failed",
        status: res.status,
        detail: detail.slice(0, 300),
      },
      {
        status: res.status,
        headers: {
          "Cache-Control": "private, no-store, max-age=0",
          "X-Content-Type-Options": "nosniff",
        },
      },
    );
  }

  return new NextResponse(res.body, {
    status: 200,
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition":
        res.headers.get("Content-Disposition") ?? "attachment",
      "Cache-Control":
        res.headers.get("Cache-Control") ?? "private, no-store, max-age=0",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
