// app/api/scan/route.ts
import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type ScanResult = {
  inserted: number;
  updated: number;
  skipped: number;
  durationMs: number;
};

function jsonOk(data: unknown, init?: ResponseInit) {
  return NextResponse.json({ ok: true, ...data }, init);
}

function jsonErr(message: string, extra?: unknown, status = 500) {
  return NextResponse.json(
    { ok: false, error: message, details: extra ?? null },
    { status }
  );
}

// ------------------------------------------------------------
// GET: Health check (Tarama endpoint ayakta mı?)
// ------------------------------------------------------------
export async function GET() {
  try {
    // DB bağlantısını hızlı doğrulamak için hafif bir sorgu (opsiyonel)
    // Eğer tabloların yoksa bile "SELECT 1" tadında çalışır:
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
// Body örneği:
// { "limit": 50, "force": true }
// ------------------------------------------------------------
export async function POST(req: Request) {
  const start = Date.now();

  try {
    // 1) Body parse (boş body olabilir)
    let body: any = {};
    try {
      body = await req.json();
    } catch {
      body = {};
    }

    const limit =
      typeof body.limit === "number" && body.limit > 0 ? body.limit : 50;
    const force = typeof body.force === "boolean" ? body.force : false;

    // 2) ENV kontrol (senin projende hangi key gerekiyorsa ekle)
    // Örn: NEWS_API_KEY, FINNHUB_API_KEY, CRON_SECRET vs.
    // Burayı kendi projenin gereğine göre uyarlayabilirsin.
    // if (!process.env.NEWS_API_KEY) {
    //   return jsonErr("Missing NEWS_API_KEY in environment variables.", null, 400);
    // }

    // 3) Tarama çalıştır
    const result = await runScan({ limit, force });

    // 4) Süre ekle
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
async function runScan(params: { limit: number; force: boolean }): Promise<ScanResult> {
  const { limit, force } = params;

  // ✅ Burada kendi tarama akışını koyacaksın:
  // - Kaynaklardan haber çek
  // - DB’de var mı kontrol et
  // - Upsert/insert yap
  //
  // Aşağıdaki örnek "scan çalışıyor mu"yu test etmek için
  // DB'ye küçük bir kayıt atmayı dener.
  //
  // ⚠️ Aşağıdaki kodu kullanabilmek için şemanızda uygun bir tablo olmalı.
  // Eğer tablo adın farklıysa bunu kendi tablonla değiştir.
  //
  // Örnek tablo: ScanLog (id, createdAt, limit, force)
  //
  // Eğer sende ScanLog yoksa, bu kısmı kendi "news" tablonla değiştir
  // veya tamamen kaldır.

  // Eğer sende ScanLog tablosu yoksa, alttaki bloğu KAPAT (yorum yap)
  // ve kendi insert/upsert kodunu koy.
  try {
    // @ts-expect-error - ScanLog tablosu sende yoksa TS hata verir; o zaman bu bloğu kaldır.
    await prisma.scanLog.create({
      data: {
        limit,
        force,
      },
    });
  } catch {
    // ScanLog yoksa sessizce geç (route patlamasın)
  }

  // Şimdilik "dummy" sonuç dönüyoruz.
  return {
    inserted: 0,
    updated: 0,
    skipped: force ? 0 : limit,
    durationMs: 0, // dışarıda eklenecek
  };
}
