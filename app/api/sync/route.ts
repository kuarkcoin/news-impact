import { NextResponse } from "next/server";
import { PrismaClient } from "@prisma/client";

// --- 1. Prisma Client Setup (Singleton) ---
const globalForPrisma = global as unknown as { prisma: PrismaClient };
const prisma = globalForPrisma.prisma || new PrismaClient();
if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = prisma;

// --- 2. Ayarlar ---
export const runtime = "nodejs";
export const maxDuration = 300; // Vercel Pro için 5dk, Hobby için genellikle 10-60sn.
// DİKKAT: Çok fazla hisse varsa Hobby planında timeout yiyebilir. 
// O durumda "batch" işlemi yapmak gerekir.

const FINNHUB_API_KEY = process.env.FINNHUB_API_KEY;
const CRON_SECRET = process.env.CRON_SECRET; // .env dosyana CRON_SECRET=gizlisifre ekle

// Rate Limit için Gecikme (ms)
// 60 calls/min limitimiz var. Her hisse için 2 call (news + candle) yapıyoruz.
// 2 call * 1.5sn gecikme = 3 saniye. Dakikada ~20 hisse tarar. Güvenli.
const DELAY_MS = 1500; 

// --- 3. Yardımcı Fonksiyonlar ---

const clamp = (n: number, a: number, b: number) => Math.max(a, Math.min(b, n));

function calculateScore(ret5d: number | null, ret1d: number | null, retPre5: number | null) {
  // Veri yoksa nötr skor
  if (ret1d === null && ret5d === null) return { score: 50, pricedIn: false };

  // Öncelik 5D, yoksa 1D
  const r = ret5d ?? ret1d ?? 0;
  
  // Priced-in analizi (Haber öncesi hareket, haber sonrası hareketten büyük mü?)
  let pricedIn = false;
  if (typeof retPre5 === "number" && Math.abs(r) > 0.005) { // %0.5'ten büyük hareket varsa bak
    pricedIn = Math.abs(retPre5) > Math.abs(r) * 0.9;
  }

  // Puan hesaplama
  const base = clamp(Math.round(Math.abs(r) * 1000), 0, 50); // Max 50 puan ekle
  let pen = 0;
  
  if (pricedIn && typeof retPre5 === "number") {
    // Hareket önceden olduysa ceza puanı düş
    pen = clamp(Math.round((Math.abs(retPre5) - Math.abs(r)) * 1200), 0, 25);
  }

  return {
    score: clamp(50 + base - pen, 50, 100),
    pricedIn
  };
}

// --- 4. Ana Route ---

export async function GET(req: Request) {
  // Güvenlik Kontrolü
  const { searchParams } = new URL(req.url);
  const authKey = searchParams.get("key"); // ?key=gizlisifre
  const forceSymbol = searchParams.get("symbol"); // ?key=...&symbol=AAPL (tekil test için)

  // Authorization (Bearer token veya query param)
  if (authKey !== CRON_SECRET) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  if (!FINNHUB_API_KEY) {
    return NextResponse.json({ error: "Missing FINNHUB_API_KEY" }, { status: 500 });
  }

  try {
    // 1. İşlenecek Hisseleri Seç
    let tickers: { symbol: string }[] = [];
    
    if (forceSymbol) {
      tickers = [{ symbol: forceSymbol.toUpperCase() }];
    } else {
      // DB'den aktif hisseleri çek
      tickers = await prisma.ticker.findMany({ 
        where: { isActive: true },
        select: { symbol: true }
      });

      // Eğer DB boşsa (ilk kurulum), seed yap
      if (tickers.length === 0) {
        console.log("DB boş, seed yapılıyor...");
        await prisma.ticker.createMany({
          data: ["AAPL", "NVDA", "TSLA", "MSFT", "AMD", "AMZN", "GOOGL", "META"].map(s => ({ symbol: s })),
          skipDuplicates: true
        });
        tickers = await prisma.ticker.findMany({ where: { isActive: true }, select: { symbol: true } });
      }
    }

    const results = [];
    const errors = [];
    
    // Tarih Ayarları
    const now = new Date();
    // 7 gün geriye git (eski haberleri de yakalamak veya güncellemek için)
    const fromNewsDate = new Date(now.getTime() - 7 * 24 * 3600 * 1000); 
    // Candle için daha geriye git (Pre-5 hesaplamak için 15-20 gün lazım)
    const fromCandleTimestamp = Math.floor((now.getTime() - 30 * 24 * 3600 * 1000) / 1000);
    const toTimestamp = Math.floor(now.getTime() / 1000);

    // --- LOOP BAŞLANGICI ---
    console.log(`Starting sync for ${tickers.length} tickers...`);

    for (const t of tickers) {
      try {
        const symbol = t.symbol;
        
        // 1. Rate Limit Delay
        await new Promise(resolve => setTimeout(resolve, DELAY_MS));

        // 2. Fetch News
        const newsUrl = `https://finnhub.io/api/v1/company-news?symbol=${symbol}&from=${fromNewsDate.toISOString().slice(0, 10)}&to=${now.toISOString().slice(0, 10)}&token=${FINNHUB_API_KEY}`;
        const newsRes = await fetch(newsUrl);
        if (!newsRes.ok) throw new Error(`News fetch failed: ${newsRes.status}`);
        const newsData = await newsRes.json();

        if (!Array.isArray(newsData) || newsData.length === 0) {
          results.push({ symbol, status: "No news" });
          continue;
        }

        // 3. Fetch Candles
        const candleUrl = `https://finnhub.io/api/v1/stock/candle?symbol=${symbol}&resolution=D&from=${fromCandleTimestamp}&to=${toTimestamp}&token=${FINNHUB_API_KEY}`;
        const candleRes = await fetch(candleUrl);
        const candleData = await candleRes.json();

        // Candle helper arrays
        let tArr: number[] = [];
        let cArr: number[] = [];
        if (candleData.s === "ok" && Array.isArray(candleData.t)) {
          tArr = candleData.t; // timestamp array
          cArr = candleData.c; // close price array
        }

        // Haberleri işle (En son 5 haberi al yeter, DB şişmesin)
        const processedNews = [];
        const recentNews = newsData.slice(0, 5); 

        for (const item of recentNews) {
          if (!item.headline || !item.datetime) continue;

          // External ID oluştur (Duplicate önlemek için hash mantığı)
          // Finnhub "id" veriyor ama bazen güvenilmez, headline+date daha sağlam
          const cleanHeadline = item.headline.slice(0, 50).replace(/[^a-zA-Z0-9]/g, "");
          const externalId = `${symbol}-${item.datetime}-${cleanHeadline}`;

          // --- Getiri Hesaplama ---
          let ret1d = null;
          let ret5d = null;
          let retPre5 = null;

          if (tArr.length > 0) {
            // Haberin işlem gününü bul
            // Haberin saati (Unix) >= Candle günü (Unix - day start)
            // Basitçe: Haberin olduğu gün veya sonraki ilk gün
            const newsTs = item.datetime;
            
            let idx = -1;
            // Candle array sıralıdır, ilk eşleşeni bul
            for (let i = 0; i < tArr.length; i++) {
              // Finnhub candle timestampleri o günün piyasa kapanışı veya açılışı olabilir.
              // Genelde gün sonu verisidir.
              // Eğer candle zamanı > haber zamanı ise bu candle o haberin gününe aittir (veya sonrasına)
              // (Basit yaklaşım: tam gün eşleşmesi)
              if (tArr[i] >= newsTs) {
                idx = i;
                break;
              }
            }

            if (idx !== -1 && idx < cArr.length) {
              const basePrice = cArr[idx];
              
              // +1 Gün Sonra
              if (idx + 1 < cArr.length) ret1d = (cArr[idx + 1] - basePrice) / basePrice;
              // +5 Gün Sonra
              if (idx + 5 < cArr.length) ret5d = (cArr[idx + 5] - basePrice) / basePrice;
              // -5 Gün Önce (Pre)
              if (idx - 5 >= 0) retPre5 = (basePrice - cArr[idx - 5]) / cArr[idx - 5];
            }
          }

          const { score, pricedIn } = calculateScore(ret5d, ret1d, retPre5);

          // --- DB UPSERT (Ekle veya Güncelle) ---
          await prisma.newsEvent.upsert({
            where: { externalId },
            create: {
              tickerSymbol: symbol,
              headline: item.headline,
              url: item.url,
              type: item.category,
              publishedAt: new Date(item.datetime * 1000),
              externalId,
              score: {
                create: {
                  score,
                  pricedIn,
                  ret1d,
                  ret5d,
                  retPre5
                }
              }
            },
            update: {
              // Skor değişmiş olabilir (yeni günler eklendiği için)
              score: {
                upsert: {
                  create: { score, pricedIn, ret1d, ret5d, retPre5 },
                  update: { score, pricedIn, ret1d, ret5d, retPre5 }
                }
              }
            }
          });

          processedNews.push(externalId);
        }

        results.push({ symbol, processed: processedNews.length });

      } catch (e: any) {
        console.error(`Error processing ${t.symbol}:`, e);
        errors.push({ symbol: t.symbol, error: e.message });
      }
    }

    return NextResponse.json({ 
      ok: true, 
      processed: results.length, 
      details: results, 
      errors 
    });

  } catch (globalError: any) {
    return NextResponse.json({ error: "Global sync error", details: globalError.message }, { status: 500 });
  }
}
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
  
