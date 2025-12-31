// app/api/leaderboard/route.ts
import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const maxDuration = 60; // İşlem süresini 60sn'ye çıkarır (Vercel Hobby için max)

// --- AYARLAR ---
// Timeout yememek için listeyi şimdilik kısa tutuyoruz.
// İstersen buraya 'AMD', 'INTC' gibi eklemeler yapabilirsin.
const SYMBOLS = [
  "AAPL", "MSFT", "NVDA", "AMZN", "META", 
  "GOOGL", "TSLA", "AVGO", "COST", "PEP"
];

const FINNHUB_API_KEY = process.env.FINNHUB_API_KEY;

// Yardımcılar
const clamp = (n: number, a: number, b: number) => Math.max(a, Math.min(b, n));

function scoreFromRet(ret5d: number | null, ret1d: number | null, retPre5: number | null) {
  const r = ret5d ?? ret1d ?? 0;
  
  let pricedIn = false;
  if (typeof retPre5 === "number" && typeof r === "number" && Math.abs(r) > 0.005) {
    pricedIn = Math.abs(retPre5) > Math.abs(r) * 0.9;
  }

  const base = clamp(Math.round(Math.abs(r) * 1000), 0, 50);
  let pen = 0;
  if (pricedIn && typeof retPre5 === "number") {
    pen = clamp(Math.round((Math.abs(retPre5) - Math.abs(r)) * 1200), 0, 25);
  }

  return {
    score: clamp(50 + base - pen, 50, 100),
    pricedIn
  };
}

// --- DATA FETCHING ---

async function fetchStockData(symbol: string) {
  if (!FINNHUB_API_KEY) return null;

  const now = new Date();
  const fromNews = new Date(now.getTime() - 5 * 24 * 3600 * 1000); // 5 gün geri
  const toUnix = Math.floor(now.getTime() / 1000);
  const fromUnix = Math.floor(toUnix - 20 * 24 * 3600); // 20 gün geri (Candle için)

  // 1. Haberleri Çek
  // next: { revalidate: 3600 } -> Bu isteği 1 saat boyunca cache'le
  const newsRes = await fetch(
    `https://finnhub.io/api/v1/company-news?symbol=${symbol}&from=${fromNews.toISOString().slice(0,10)}&to=${now.toISOString().slice(0,10)}&token=${FINNHUB_API_KEY}`,
    { next: { revalidate: 3600 } } 
  );
  
  if (!newsRes.ok) return null;
  const newsData = await newsRes.json();
  if (!Array.isArray(newsData) || newsData.length === 0) return null;

  // En yeni 2 haberi al
  const topNews = newsData.slice(0, 2);

  // 2. Fiyatları Çek (Candles)
  const candleRes = await fetch(
    `https://finnhub.io/api/v1/stock/candle?symbol=${symbol}&resolution=D&from=${fromUnix}&to=${toUnix}&token=${FINNHUB_API_KEY}`,
    { next: { revalidate: 3600 } }
  );
  
  if (!candleRes.ok) return null;
  const candles = await candleRes.json();
  
  if (candles.s !== "ok" || !candles.t || !candles.c) return null;

  const tArr = candles.t; // Time
  const cArr = candles.c; // Close Price

  // Haberleri işle
  const results = [];
  
  for (const item of topNews) {
    // Haberin tarihine denk gelen candle indexini bul
    const newsTime = item.datetime;
    let idx = tArr.findIndex((t: number) => t >= newsTime);
    
    // Tam eşleşme yoksa en yakını al
    if (idx === -1) idx = tArr.length - 1;

    // Getirileri hesapla
    let ret1d = null, ret5d = null, retPre5 = null;
    const basePrice = cArr[idx];

    if (basePrice) {
      if (idx + 1 < cArr.length) ret1d = (cArr[idx + 1] - basePrice) / basePrice;
      if (idx + 5 < cArr.length) ret5d = (cArr[idx + 5] - basePrice) / basePrice;
      if (idx - 5 >= 0) retPre5 = (basePrice - cArr[idx - 5]) / cArr[idx - 5];
    }

    const { score, pricedIn } = scoreFromRet(ret5d, ret1d, retPre5);

    results.push({
      symbol,
      headline: item.headline,
      type: item.category,
      publishedAt: new Date(item.datetime * 1000).toISOString(),
      url: item.url,
      score,
      pricedIn,
      ret1d,
      ret5d,
      retPre5
    });
  }

  return results;
}

// --- ANA API HANDLER ---

export async function GET() {
  try {
    // Tüm hisseleri paralel olarak çek
    const promises = SYMBOLS.map(sym => fetchStockData(sym));
    const results = await Promise.all(promises);

    // Sonuçları birleştir ve boş (null) olanları temizle
    const flatResults = results.flat().filter(item => item !== null);

    // Skora göre sırala
    flatResults.sort((a, b) => (b?.score || 0) - (a?.score || 0));

    return NextResponse.json({
      asOf: new Date().toISOString(),
      items: flatResults
    });

  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
