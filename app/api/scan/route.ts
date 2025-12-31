import { NextResponse } from "next/server";

export const runtime = "nodejs";

// Basit helper (ileride lazım olabilir)
const clamp = (n: number, a: number, b: number) => Math.max(a, Math.min(b, n));

export async function POST(req: Request) {
  try {
    // ---- auth (cron/manuel çağrı için)
    const secret = req.headers.get("x-scan-secret");
    if (!process.env.SCAN_SECRET || secret !== process.env.SCAN_SECRET) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    // İstersen parametreleri al (şimdilik kullanmıyoruz)
    let body: any = null;
    try {
      body = await req.json();
    } catch {
      body = null;
    }

    // Prisma/DB yokken üretim için güvenli stub cevap
    return NextResponse.json(
      {
        ok: true,
        message: "Scan is temporarily disabled (no DB/Prisma connected).",
        hint: "Enable Prisma or switch to Supabase to persist tickers/news/scores.",
        received: body,
        created: 0,
        processedTickers: 0,
        asOf: new Date().toISOString(),
      },
      { status: 200 }
    );
  } catch (e: any) {
    return NextResponse.json(
      { error: e?.message || "Unknown error" },
      { status: 500 }
    );
  }
}

// İstersen GET ile health-check
export async function GET() {
  return NextResponse.json(
    {
      ok: true,
      message: "Scan endpoint is up (Prisma disabled). Use POST with x-scan-secret.",
      asOf: new Date().toISOString(),
    },
    { status: 200 }
  );
}