// app/api/scan/route.ts
import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type JsonObject = Record<string, unknown>;

type ScanResult = {
  inserted: number;
  updated: number;
  skipped: number;
  durationMs: number;
};

function jsonOk(data: JsonObject = {}, init?: ResponseInit) {
  return NextResponse.json({ ok: true, ...data }, init);
}

function jsonOkValue(value: unknown, init?: ResponseInit) {
  // object olmayan tekil değerleri güvenli şekilde döndürmek için
  return NextResponse.json({ ok: true, value }, init);
}

function jsonErr(message: string, details?: unknown, status = 500) {
  return NextResponse.json({ ok: false, error: message, details }, { status });
}

// ------------------------------------------------------------
// GET: Health check (Route ayakta mı + DB erişimi var mı?)
// ------------------------------------------------------------
export async function GET() {
  try {
    await prisma.$queryRaw`SELECT 1`;
    return jsonOk({
      where: "api/scan",
      message: "Scan route alive ✅",
      time: new Date().toISOString(),
    });
  } catch (e: any) {
    return jsonErr(
      "DB connection failed (Prisma). Vercel ENV (DATABASE_URL) kontrol et.",
      e?.message ?? String(e),
      500
    );
  }
}

// ------------------------------------------------------------
// POST: Scan tetikle
// Body örneği: { "limit": 50, "force": true }
// ------------------------------------------------------------
export async function POST(req: Request) {
  const start = Date.now();

  try {
    // Body parse (boş body olabilir)
    let body: any = {};
    try {
      body = await req.json();
    } catch {
      body = {};
    }

    const limit =
      typeof body.limit === "number" && body.limit > 0 ? body.limit : 50;
    const force = typeof body.force === "boolean" ? body.force : false;

    const result = await runScan({ limit, force });

    const durationMs = Date.now() - start;

    return jsonOk({
      message: "Scan completed ✅",
      result: { ...result, durationMs },
    });
  } catch (e: any) {
    const durationMs = Date.now() - start;
    return jsonErr(
      "Scan failed.",
      { message: e?.message ?? String(e), durationMs },
      500
    );
  }
}

// ------------------------------------------------------------
// Scan logic (BURASI SENİN TARAYICIN)
// ------------------------------------------------------------
async function runScan(params: {
  limit: number;
  force: boolean;
}): Promise<ScanResult> {
  const { limit, force } = params;

  // Buraya kendi tarama akışını koyacaksın.
  // Şimdilik "dummy" dönüyoruz.
  return {
    inserted: 0,
    updated: 0,
    skipped: force ? 0 : limit,
    durationMs: 0, // dışarıda overwrite ediliyor
  };
}
