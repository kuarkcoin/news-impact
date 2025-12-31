import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const maxDuration = 60; 

// Hisseler
const SYMBOLS = ["AAPL", "NVDA", "TSLA", "MSFT", "AMD"];

// API Anahtarı
const FINNHUB_API_KEY = process.env.FINNHUB_API_KEY;

// --- Yardımcı Fonksiyonlar ---
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

// --- Demo Veri (API Çalışmazsa Bu Görünecek) ---
const DEMO_ITEMS = [
  {
    symbol: "DEMO-AAPL",
    headline: "⚠️ API Verisi Alınamadı - Bu Örnek Veridir",
    type: "System",
    publishedAt: new Date().toISOString(),
    url: "https://google.com",
    score: 85,
    pricedIn: false,
    ret1d: 0.02,
    ret5d: 0.05,
    retPre5: 0.01
  },
  {
    symbol: "DEMO-TSLA",
    headline: "API Key Eksik veya Piyasalar Tatil Olabilir",
    type: "Alert",
    publishedAt: new Date().toISOString(),
    url: "#",
    score: 65,
    pricedIn: true,
    ret1d: -0.01,
    ret5d: 0.03,
    retPre5: 0.04
  }
];

// --- Veri Çekme Fonksiyonu ---
async function fetchStockData(symbol: string) {
  if (!FINNHUB_API_KEY) return null;

  const now = new Date();
  // 15 gün geriye bak (Tatil dönemleri için genişletildi)
  const fromNews = new Date(now.getTime() - 15 * 24 * 3600 * 1000);
  const toUnix = Math.floor(now.getTime() / 1000);
  const fromUnix = Math.floor(toUnix - 30 * 24 * 3600);

  try {
    // 1. Haber Çek
    const newsRes = await fetch(
      `https://finnhub.io/api/v1/company-news?symbol=${symbol}&from=${fromNews.toISOString().slice(0,10)}&to=${now.toISOString().slice(0,10)}&token=${FINNHUB_API_KEY}`,
      { next: { revalidate: 30 } }
    );
    
    if (!newsRes.ok) return null;
    const newsData = await newsRes.json();
    if (!Array.isArray(newsData) || newsData.length === 0) return null;

    const item = newsData[0]; // En yeni haber

    // 2. Fiyat Çek
    const candleRes = await fetch(
      `https://finnhub.io/api/v1/stock/candle?symbol=${symbol}&resolution=D&from=${fromUnix}&to=${toUnix}&token=${FINNHUB_API_KEY}`,
      { next: { revalidate: 30 } }
    );
    
    const candles = await candleRes.json();
    let ret1d = null, ret5d = null, retPre5 = null;

    if (candles.s === "ok" && candles.c) {
       const tArr = candles.t;
       const cArr = candles.c;
       let idx = tArr.findIndex((t: number) => t >= item.datetime);
       if (idx === -1) idx = tArr.length - 1;

       const base = cArr[idx];
       if (base) {
         if (idx + 1 < cArr.length) ret1d = (cArr[idx + 1] - base) / base;
         if (idx + 5 < cArr.length) ret5d = (cArr[idx + 5] - base) / base;
         if (idx - 5 >= 0) retPre5 = (base - cArr[idx - 5]) / cArr[idx - 5];
       }
    }

    const { score, pricedIn } = scoreFromRet(ret5d, ret1d, retPre5);

    return {
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
    };
  } catch (e) {
    console.error(`Error ${symbol}:`, e);
    return null;
  }
}

// --- ANA API ---
export async function GET() {
  try {
    // 1. API KEY KONTROLÜ
    if (!FINNHUB_API_KEY) {
      console.log("API Key eksik, demo veri dönülüyor.");
      return NextResponse.json({
        asOf: new Date().toISOString(),
        items: DEMO_ITEMS // <--- API Key yoksa bunu göster
      });
    }

    const promises = SYMBOLS.map(sym => fetchStockData(sym));
    const results = await Promise.all(promises);
    const flatResults = results.filter(item => item !== null);

    // 2. BOŞ VERİ KONTROLÜ
    if (flatResults.length === 0) {
      console.log("Veri bulunamadı, demo veri dönülüyor.");
      return NextResponse.json({
        asOf: new Date().toISOString(),
        items: DEMO_ITEMS // <--- API'den veri gelmezse bunu göster
      });
    }

    // 3. GERÇEK VERİ
    flatResults.sort((a, b) => (b.score || 0) - (a.score || 0));
    return NextResponse.json({
      asOf: new Date().toISOString(),
      items: flatResults
    });

  } catch (error: any) {
    return NextResponse.json({
      asOf: new Date().toISOString(),
      items: DEMO_ITEMS // <--- Hata olursa bunu göster
    });
  }
}
