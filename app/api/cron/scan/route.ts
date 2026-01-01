// app/api/cron/scan/route.ts
import { NextResponse } from "next/server";

/**
 * Cron auth guard
 * - Vercel Cron: ?secret=CRON_SECRET
 * - Future: Authorization: Bearer CRON_SECRET
 */
function assertCronAuth(req: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;

  // 1️⃣ Query secret (Vercel Cron ile %100 uyumlu)
  const { searchParams } = new URL(req.url);
  if (searchParams.get("secret") === secret) return true;

  // 2️⃣ Header-based (QStash / GitHub Actions uyumlu)
  const authHeader = req.headers.get("authorization");
  if (authHeader === `Bearer ${secret}`) return true;

  return false;
}

export async function GET(req: Request) {
  try {
    // 🔐 AUTH
    if (!assertCronAuth(req)) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    // ✅ ŞİMDİ BURADA TARAMA / CACHE ISITMA / DB YAZMA NE VARSA ÇALIŞIR
    // Örnek response (test için):
    return NextResponse.json({
      ok: true,
      ranAt: new Date().toISOString(),
    });
  } catch (e: any) {
    return NextResponse.json(
      { error: e?.message || "Unknown error" },
      { status: 500 }
    );
  }
}
