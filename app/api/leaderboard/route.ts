// app/api/leaderboard/route.ts
import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const maxDuration = 60; // 60 saniye zaman aşımı

// Listeyi test için kısa tutalım, çalışınca artırırız
const SYMBOLS = ["AAPL", "NVDA", "TSLA", "MSFT", "AMD"];

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
  if (!FINNHUB_API_KEY) {
    console.error("API KEY EKSİK!");
    return null;
  }

  const now = new Date();
  // TATİL GÜNLERİ İÇİN ARALIĞI ARTIRDIK: 10 GÜN
  const fromNews = new Date(now.getTime() - 10 * 24 * 3600 * 1000); 
  const toUnix = Math.floor(now.getTime() / 1000);
  const fromUnix = Math.floor(toUnix - 30 * 24 * 3600); 

  try {
    // 1. Haberleri Çek
    const newsUrl = `https://finnhub.io/api/v1/company-news?symbol=${symbol}&from=${fromNews.toISOString().slice(0,10)}&to=${now.toISOString().slice(0,10)}&token=${FINNHUB_API_KEY}`;
    const newsRes = await fetch(newsUrl, { next: { revalidate: 60 } }); // Cache süresini test için 60sn yaptık
    
    if (!newsRes.ok) {
      console.log(`${symbol} news error: ${newsRes.status}`);
      return null;
    }
    
    const newsData = await newsRes.json();
    if (!Array.isArray(newsData) || newsData.length === 0) {
      console.log(`${symbol}: Haber bulunamadı.`);
      return null;
    }

    // En yeni 1 haberi al
    const topNews = newsData.slice(0, 1);
    const item = topNews[0];

    // 2. Fiyatları Çek
    const candleUrl = `https://finnhub.io/api/v1/stock/candle?symbol=${symbol}&resolution=D&from=${fromUnix}&to=${toUnix}&token=${FINNHUB_API_KEY}`;
    const candleRes = await fetch(candleUrl, { next: { revalidate: 60 } });
    
    if (!candleRes.ok) return null;
    const candles = await candleRes.json();
    
    let ret1d = null, ret5d = null, retPre5 = null;
    
    // Candle verisi varsa hesapla, yoksa 0 kabul et
    if (candles.s === "ok" && candles.c) {
       const tArr = candles.t;
       const cArr = candles.c;
       const newsTime = item.datetime;
       let idx = tArr.findIndex((t: number) => t >= newsTime);
       if (idx === -1) idx = tArr.length - 1;

       const basePrice = cArr[idx];
       if (basePrice) {
         if (idx + 1 < cArr.length) ret1d = (cArr[idx + 1] - basePrice) / basePrice;
         if (idx + 5 < cArr.length) ret5d = (cArr[idx + 5] - basePrice) / basePrice;
         if (idx - 5 >= 0) retPre5 = (basePrice - cArr[idx - 5]) / cArr[idx - 5];
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
    console.error(`Error fetching ${symbol}:`, e);
    return null;
  }
}

// --- ANA API HANDLER ---

export async function GET() {
  try {
    if (!FINNHUB_API_KEY) {
      return NextResponse.json({ error: "API Key Config Hatası" }, { status: 500 });
    }

    console.log("Fetching data for symbols:", SYMBOLS);
    const promises = SYMBOLS.map(sym => fetchStockData(sym));
    const results = await Promise.all(promises);

    const flatResults = results.filter(item => item !== null);
    
    // Eğer hiç veri gelmezse, Frontend boş görünmesin diye sahte bir veri dönelim (Debug için)
    if (flatResults.length === 0) {
       console.log("Hiç veri bulunamadı, örnek veri dönülüyor.");
       /* // TEST İÇİN BUNU AÇABİLİRSİN:
       flatResults.push({
         symbol: "TEST-DATA",
         headline: "Piyasalar kapalı olduğu için veri çekilemedi. API Key kontrol edin.",
         type: "System",
         publishedAt: new Date().toISOString(),
         url: "#",
         score: 50,
         pricedIn: false,
         ret1d: 0,
         ret5d: 0,
         retPre5: 0
       });
       */
    }

    flatResults.sort((a, b) => (b?.score || 0) - (a?.score || 0));

    return NextResponse.json({
      asOf: new Date().toISOString(),
      items: flatResults
    });

  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
