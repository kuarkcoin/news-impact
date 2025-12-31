// app/api/sync/route.ts
import { NextResponse } from "next/server";
import { PrismaClient } from "@prisma/client";

// Global prisma client (Next.js hot-reload hatasını önlemek için)
const globalForPrisma = global as unknown as { prisma: PrismaClient };
const prisma = globalForPrisma.prisma || new PrismaClient();
if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = prisma;

export const runtime = "nodejs";
export const maxDuration = 60; // Vercel Pro'da 300s, Hobby'de max 60s (dikkat)

// Yardımcılar (Önceki koddan)
const clamp = (n: number, a: number, b: number) => Math.max(a, Math.min(b, n));
function toUnixSec(d: Date) { return Math.floor(d.getTime() / 1000); }
function dayStartUtc(date: Date) { return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate())); }

// Basit Skorlama Fonksiyonu
function calculateScore(ret5d: number | null, ret1d: number | null, retPre5: number | null) {
  const r = ret5d ?? ret1d;
  if (typeof r !== "number") return 50;
  
  const pricedIn = (typeof retPre5 === "number" && typeof r === "number") 
    ? Math.abs(retPre5) > Math.abs(r) * 0.9 
    : false;

  const base = clamp(Math.round(Math.abs(r) * 1000), 0, 50);
  let pen = 0;
  if (pricedIn && typeof retPre5 === "number") {
    pen = clamp(Math.round(Math.max(0, Math.abs(retPre5) - Math.abs(r)) * 1200), 0, 25);
  }

  return {
    score: clamp(50 + base - pen, 50, 100),
    pricedIn
  };
}

export async function GET(req: Request) {
  // Güvenlik: Sadece bir CRON_SECRET ile tetiklenebilsin
  const { searchParams } = new URL(req.url);
  if (searchParams.get("key") !== process.env.CRON_SECRET) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const finnhubKey = process.env.FINNHUB_API_KEY;
    
    // 1. Aktif Tickerları DB'den çek (Eğer boşsa seed yapabilirsin)
    let tickers = await prisma.ticker.findMany({ where: { isActive: true } });
    
    // Eğer DB boşsa test için manuel ekle
    if (tickers.length === 0) {
      await prisma.ticker.createMany({
        data: [{ symbol: "AAPL" }, { symbol: "TSLA" }, { symbol: "NVDA" }],
        skipDuplicates: true
      });
      tickers = await prisma.ticker.findMany({ where: { isActive: true } });
    }

    const results = [];

    // Döngü: Her hisse için
    for (const t of tickers) {
      // Not: Finnhub limitine takılmamak için araya yapay gecikme koyuyoruz
      await new Promise(res => setTimeout(res, 1000)); 

      // --- BURADA FETCH İŞLEMLERİ (NEWS + CANDLE) YAPILACAK ---
      // (Önceki kodundaki fetch mantığı buraya gelecek)
      // Özetle: 
      // 1. News çek
      // 2. Candle çek
      // 3. Hesapla ve DB'ye "upsert" yap (varsa güncelle, yoksa ekle)
      
      // Örnek DB Yazma İşlemi (Logic tamamlandığında):
      /*
      await prisma.newsEvent.upsert({
        where: { externalId: newsHash },
        update: { score: { update: { ...yeniSkorlar } } },
        create: {
          tickerSymbol: t.symbol,
          headline: item.headline,
          publishedAt: item.publishedAt,
          externalId: newsHash,
          score: {
            create: {
              score: calculated.score,
              pricedIn: calculated.pricedIn,
              ret1d: item.ret1d,
              ret5d: item.ret5d,
              retPre5: item.retPre5
            }
          }
        }
      });
      */
      
      results.push(`Synced ${t.symbol}`);
    }

    return NextResponse.json({ ok: true, synced: results });
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
  
