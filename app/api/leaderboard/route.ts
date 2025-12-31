import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const maxDuration = 60; // Timeout süresini artırdık

// Hisseleri azalttık (Test için 5 tane yeterli, çok olursa yavaşlar)
const SYMBOLS = ["AAPL", "NVDA", "TSLA", "MSFT", "AMD"];
const FINNHUB_API_KEY = process.env.FINNHUB_API_KEY;

// --- DEMO VERİ (Eğer her şey ters giderse bu görünür) ---
const DEMO_ITEMS = [
  {
    symbol: "DEMO-ERR",
    headline: "Hız Sınırı veya API Hatası - Lütfen Vercel Loglarını Kontrol Et",
    type: "Error",
    publishedAt: new Date().toISOString(),
    url: "#",
    retPre5: 0, ret1d: 0, ret5d: 0,
    pricedIn: false,
    score: 50, expectedImpact: 50, realizedImpact: 50, confidence: 0, tooEarly: true
  }
];

// --- MATEMATİK & TİPLER ---

const clamp = (n: number, a: number, b: number) => Math.max(a, Math.min(b, n));

type LeaderItem = {
  symbol: string;
  headline: string;
  type: string | null;
  publishedAt: string;
  url: string | null;
  retPre5: number | null;
  ret1d: number | null;
  ret5d: number | null;
  pricedIn: boolean | null;
  expectedImpact: number;
  realizedImpact: number;
  score: number;
  confidence: number;
  tooEarly: boolean;
};

function scoreFromReturns(ret5d: number | null, ret1d: number | null, retPre5: number | null) {
  // Veri yoksa
  if (ret1d === null && ret5d === null) {
    return { expectedImpact: 50, realizedImpact: 50, pricedIn: null, confidence: 0, tooEarly: true, score: 50 };
  }

  const rUsed = ret5d ?? ret1d ?? 0;
  const realizedBase = clamp(Math.round(Math.abs(rUsed) * 1000), 0, 50);
  const realizedImpact = clamp(50 + realizedBase, 50, 100);

  let pricedIn: boolean | null = null;
  if (typeof retPre5 === "number" && Math.abs(rUsed) > 0.005) {
    pricedIn = Math.abs(retPre5) > Math.abs(rUsed) * 0.9;
  }

  let pen = 0;
  if (pricedIn === true && typeof retPre5 === "number") {
    pen = clamp(Math.round((Math.abs(retPre5) - Math.abs(rUsed)) * 1200), 0, 25);
  }

  const expectedImpact = clamp(50 + realizedBase - pen, 50, 100);

  let conf = 20;
  if (ret1d !== null) conf += 20;
  if (ret5d !== null) conf += 40;
  
  return {
    expectedImpact,
    realizedImpact,
    pricedIn,
    confidence: clamp(conf, 0, 100),
    tooEarly: false,
    score: expectedImpact
  };
}

// --- VERİ ÇEKME ---

async function fetchCandles(symbol: string, fromUnix: number, toUnix: number) {
  try {
    const url = `https://finnhub.io/api/v1/stock/candle?symbol=${encodeURIComponent(
      symbol
    )}&resolution=D&from=${fromUnix}&to=${toUnix}&token=${FINNHUB_API_KEY}`;
    
    // Cache yok, her seferinde taze veri dene (Debug için)
    const res = await fetch(url, { cache: 'no-store' }); 
    if (!res.ok) {
        console.log(`Candle Error ${symbol}: ${res.status}`);
        return null;
    }
    const data = await res.json();
    if (data?.s !== "ok") return null;
    return { t: data.t as number[], c: data.c as number[] };
  } catch (e) { 
    console.log(`Candle Fetch Exception ${symbol}:`, e);
    return null; 
  }
}

async function fetchSymbolItems(symbol: string): Promise<LeaderItem[]> {
  const now = new Date();
  // 30 gün geriye git
  const fromDate = new Date(now.getTime() - 30 * 24 * 3600 * 1000);
  const toUnix = Math.floor(now.getTime() / 1000);
  const fromUnix = Math.floor(toUnix - 120 * 24 * 3600);

  try {
    // 1) News
    const newsRes = await fetch(
      `https://finnhub.io/api/v1/company-news?symbol=${symbol}&from=${fromDate.toISOString().slice(0,10)}&to=${now.toISOString().slice(0,10)}&token=${FINNHUB_API_KEY}`,
      { cache: 'no-store' }
    );
    if (!newsRes.ok) {
        console.log(`News Error ${symbol}: ${newsRes.status}`);
        return [];
    }
    const news = await newsRes.json();
    if (!Array.isArray(news) || news.length === 0) {
        console.log(`No news found for ${symbol}`);
        return [];
    }

    // 2) Candles
    const candles = await fetchCandles(symbol, fromUnix, toUnix);
    
    // Eğer candle yoksa, haberi yine de göster ama puanı 50 yap (Veri kaybını önle)
    // Sadece en yeni 2 haberi al
    const items: LeaderItem[] = [];
    
    for (const n of news.slice(0, 2)) {
      if (!n.headline || !n.datetime) continue;

      let ret1d = null, ret5d = null, retPre5 = null;
      
      if (candles) {
        const idx = candles.t.findIndex((t: number) => t >= n.datetime);
        if (idx !== -1) {
            const base = candles.c[idx];
            if (idx + 1 < candles.c.length) ret1d = (candles.c[idx + 1] - base) / base;
            if (idx + 5 < candles.c.length) ret5d = (candles.c[idx + 5] - base) / base;
            if (idx - 5 >= 0) retPre5 = (base - candles.c[idx - 5]) / candles.c[idx - 5];
        }
      }

      const scores = scoreFromReturns(ret5d, ret1d, retPre5);

      items.push({
        symbol,
        headline: n.headline,
        type: n.category,
        publishedAt: new Date(n.datetime * 1000).toISOString(),
        url: n.url,
        retPre5, ret1d, ret5d,
        ...scores
      });
    }
    return items;
  } catch (e) {
    console.error(`Error processing ${symbol}:`, e);
    return [];
  }
}

export async function GET(req: Request) {
  try {
    if (!FINNHUB_API_KEY) {
      console.log("API Key Missing inside GET");
      return NextResponse.json({ asOf: new Date().toISOString(), items: DEMO_ITEMS });
    }

    // --- ÖNEMLİ DEĞİŞİKLİK: SIRALI (SEQUENTIAL) ÇEKİM ---
    // Promise.all YERİNE for döngüsü kullanıyoruz.
    // Bu sayede API'ye aynı anda 8 istek gitmiyor, tek tek gidiyor.
    // Hız sınırı hatası (429) almanı engeller.
    
    const allItems: LeaderItem[] = [];
    
    console.log("Starting sequential fetch...");
    
    for (const sym of SYMBOLS) {
        // Her istekten önce biraz bekle (Rate Limit Koruması)
        // await new Promise(r => setTimeout(r, 200)); 
        const items = await fetchSymbolItems(sym);
        allItems.push(...items);
    }

    console.log(`Total items fetched: ${allItems.length}`);

    if (allItems.length === 0) {
      console.log("Fetched 0 items, returning DEMO");
      return NextResponse.json({
        asOf: new Date().toISOString(),
        items: DEMO_ITEMS
      });
    }

    // Sırala
    allItems.sort((a, b) => b.score - a.score);

    return NextResponse.json({
      asOf: new Date().toISOString(),
      items: allItems
    });

  } catch (e) {
    console.error("Global Error:", e);
    return NextResponse.json({ asOf: new Date().toISOString(), items: DEMO_ITEMS });
  }
}
