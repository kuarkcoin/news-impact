import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const maxDuration = 60;

const FINNHUB_API_KEY = process.env.FINNHUB_API_KEY;

// 🔥 HAVUZ (Taranacak Hisseler)
const ALL_SYMBOLS = [
  "AAPL", "MSFT", "NVDA", "AMZN", "META", "GOOGL", "TSLA",
  "AMD", "AVGO", "INTC", "QCOM", "TXN", "MU", "NFLX", "ADBE", 
  "CRM", "PLTR", "COIN", "MSTR", "UBER", "SHOP", "PYPL"
];

// --- KELİME ANALİZİ (BASİT NLP) ---
// Haberin içeriğine göre puan tahmini yapmak için
const BULLISH_KEYWORDS = ["beat", "record", "jump", "soar", "surge", "approve", "launch", "partnership", "buyback", "dividen", "upgrade", "growth", "high"];
const BEARISH_KEYWORDS = ["miss", "fail", "drop", "fall", "plunge", "sue", "lawsuit", "investigation", "downgrade", "cut", "weak", "loss", "ban"];

const BATCH_SIZE = 15; // Hız için biraz düşürdük

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

const clamp = (n: number, a: number, b: number) => Math.max(a, Math.min(b, n));

// --- 🔥 AKILLI SKORLAMA MOTORU ---
function calculateSmartScore(
  headline: string,
  retPre5: number | null, // Haber öncesi 5 günlük hareket
  ret1d: number | null,   // Haber sonrası 1 günlük (Varsa)
  ret5d: number | null    // Haber sonrası 5 günlük (Varsa)
) {
  const text = headline.toLowerCase();
  
  // 1. GERÇEKLEŞEN ETKİ (Eğer tarih eskiyse ve veri varsa bunu kullanırız)
  if (ret5d !== null || ret1d !== null) {
    const rUsed = ret5d ?? ret1d ?? 0;
    const realizedBase = clamp(Math.round(Math.abs(rUsed) * 1000), 0, 50);
    
    // Priced-in Cezası
    let penalty = 0;
    let isPricedIn = false;
    
    // Eğer hisse haberden önce çok yükseldiyse ve haber sonrası hareket zayıfsa -> Priced In
    if (typeof retPre5 === "number" && Math.abs(retPre5) > 0.05 && Math.abs(rUsed) < Math.abs(retPre5) * 0.5) {
      isPricedIn = true;
      penalty = 20; // Puan kır
    }

    const score = clamp(50 + realizedBase - penalty, 40, 100);
    return { score, pricedIn: isPricedIn, confidence: ret5d ? 90 : 60, tooEarly: false };
  }

  // 2. TAHMİNİ ETKİ (Eğer haber BUGÜN çıktıysa veri yoktur, biz tahmin ederiz)
  // Burası senin istediğin "Daha önce fiyatlanmış mı?" mantığı.
  
  let baseScore = 50;
  let confidence = 30; // Tahmin olduğu için güven düşük başlar
  let isPricedIn = false;

  // A) Kelime Analizi (Sentiment)
  let sentimentScore = 0;
  BULLISH_KEYWORDS.forEach(w => { if(text.includes(w)) sentimentScore += 15; });
  BEARISH_KEYWORDS.forEach(w => { if(text.includes(w)) sentimentScore -= 15; });
  
  // Sentiment sınırla (-20 ile +20 arası)
  sentimentScore = clamp(sentimentScore, -20, 20);
  baseScore += sentimentScore;

  // B) Fiyatlanma Analizi (THE LOGIC YOU ASKED FOR)
  if (typeof retPre5 === "number") {
    // Senaryo 1: Haber İYİ ama hisse zaten %5+ YÜKSELMİŞ (Buy the rumor, sell the news)
    if (sentimentScore > 0 && retPre5 > 0.05) {
      baseScore -= 25; // 🔥 Cezayı bas! Skor 50'nin altına iner.
      isPricedIn = true;
      confidence += 20; // Analizimize güvenimiz artar
    }
    
    // Senaryo 2: Haber KÖTÜ ama hisse zaten %5+ DÜŞMÜŞ (Oversold)
    else if (sentimentScore < 0 && retPre5 < -0.05) {
      baseScore += 15; // Tepki alımı gelebilir, puanı çok düşürme
      isPricedIn = true;
    }
    
    // Senaryo 3: Haber İYİ ve hisse DÜŞMÜŞ veya YATAY (Sürpriz Etkisi!)
    else if (sentimentScore > 0 && retPre5 <= 0.02) {
      baseScore += 15; // 🔥 Fırlama ihtimali yüksek!
    }
  }

  return {
    score: clamp(baseScore, 30, 95), // 30 ile 95 arası puan ver
    pricedIn: isPricedIn,
    confidence, // Tahmin güvenilirliği
    tooEarly: true // Veri yok, bu bir tahmin
  };
}

// Fisher-Yates Shuffle
function shuffleArray(array: string[]) {
  const arr = [...array];
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

async function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function fetchCandles(symbol: string, fromUnix: number, toUnix: number) {
  try {
    const url = `https://finnhub.io/api/v1/stock/candle?symbol=${encodeURIComponent(
      symbol
    )}&resolution=D&from=${fromUnix}&to=${toUnix}&token=${FINNHUB_API_KEY}`;
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) return null;
    const data = await res.json();
    if (data?.s !== "ok") return null;
    return { t: data.t as number[], c: data.c as number[] };
  } catch { return null; }
}

async function fetchSymbolItems(symbol: string, perSymbol: number): Promise<LeaderItem[]> {
  const now = new Date();
  
  // 🔥 HEM BUGÜNÜ HEM GEÇMİŞİ KAPSAYAN TARİH
  // Son 30 günün haberlerini alıyoruz.
  const fromDate = new Date(now.getTime() - 30 * 24 * 3600 * 1000); 
  
  const toUnix = Math.floor(now.getTime() / 1000);
  const fromUnix = Math.floor(toUnix - 90 * 24 * 3600); 

  const items: LeaderItem[] = [];

  const newsRes = await fetch(
    `https://finnhub.io/api/v1/company-news?symbol=${symbol}&from=${fromDate.toISOString().slice(0, 10)}&to=${now.toISOString().slice(0, 10)}&token=${FINNHUB_API_KEY}`,
    { cache: "no-store" }
  );

  if (!newsRes.ok) return items;
  const news = await newsRes.json();
  if (!Array.isArray(news) || news.length === 0) return items;

  const candles = await fetchCandles(symbol, fromUnix, toUnix);
  const seen = new Set<string>();

  for (const n of news) {
    if (!n?.headline || !n?.datetime) continue;
    const key = `${symbol}|${n.datetime}|${n.headline}`;
    if (seen.has(key)) continue;
    seen.add(key);

    let ret1d: number | null = null;
    let ret5d: number | null = null;
    let retPre5: number | null = null;

    if (candles) {
      const idx = candles.t.findIndex((t) => t >= n.datetime);
      if (idx !== -1) { // Candle bulunduysa (Gelecek veri olmasa bile geçmiş veri olabilir)
        const base = candles.c[idx]; // Haber günü kapanışı
        
        // Gelecek Verisi (Varsa)
        if (idx + 1 < candles.c.length) ret1d = (candles.c[idx + 1] - base) / base;
        if (idx + 5 < candles.c.length) ret5d = (candles.c[idx + 5] - base) / base;
        
        // Geçmiş Verisi (Priced-in hesabı için ŞART)
        if (idx - 5 >= 0) retPre5 = (base - candles.c[idx - 5]) / candles.c[idx - 5];
      }
    }

    // 🔥 YENİ HESAPLAMA MOTORU
    const analysis = calculateSmartScore(n.headline, retPre5, ret1d, ret5d);

    items.push({
      symbol,
      headline: n.headline,
      type: n.category ?? null,
      publishedAt: new Date(n.datetime * 1000).toISOString(),
      url: n.url ?? null,
      retPre5,
      ret1d,
      ret5d,
      ...analysis, // score, pricedIn, confidence, tooEarly buradan geliyor
      expectedImpact: analysis.score,
      realizedImpact: analysis.score
    });

    if (items.length >= perSymbol) break;
  }
  return items;
}

export async function GET(req: Request) {
  try {
    if (!FINNHUB_API_KEY) return NextResponse.json({ error: "No API Key", items: [] }, { status: 500 });

    const { searchParams } = new URL(req.url);
    const min = parseInt(searchParams.get("min") || "30", 10); // Filtreyi 30'a çektim ki düşenleri de gör
    const limit = parseInt(searchParams.get("limit") || "50", 10);
    const perSymbol = parseInt(searchParams.get("perSymbol") || "2", 10);

    const shuffledSymbols = shuffleArray(ALL_SYMBOLS).slice(0, BATCH_SIZE);
    
    const all: LeaderItem[] = [];
    const globalSeen = new Set<string>();

    for (const sym of shuffledSymbols) {
      const items = await fetchSymbolItems(sym, perSymbol);
      for (const it of items) {
        const k = `${it.symbol}|${it.headline.trim().toLowerCase()}`;
        if (globalSeen.has(k)) continue;
        globalSeen.add(k);
        all.push(it);
      }
      await sleep(100);
    }

    const filtered = all
      .filter((x) => x.score >= min)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);

    return NextResponse.json({ asOf: new Date().toISOString(), items: filtered }, { status: 200 });
  } catch (e: any) {
    return NextResponse.json({ error: e.message, items: [] }, { status: 500 });
  }
}
