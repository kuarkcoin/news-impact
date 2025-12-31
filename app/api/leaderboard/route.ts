import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const maxDuration = 60;

const FINNHUB_API_KEY = process.env.FINNHUB_API_KEY;

// 🔥 GENİŞLETİLMİŞ HAVUZ
const ALL_SYMBOLS = [
  "AAPL", "MSFT", "NVDA", "AMZN", "META", "GOOGL", "TSLA",
  "AMD", "AVGO", "INTC", "QCOM", "TXN", "MU", "NFLX", "ADBE", 
  "CRM", "PLTR", "COIN", "MSTR", "UBER", "SHOP", "PYPL", "TSM",
  "ASML", "LRCX", "AMAT", "PANW", "CRWD", "SNOW", "DDOG", "ZS"
];

// --- 1. ZENGİNLEŞTİRİLMİŞ KELİME HAVUZU ---
const BULLISH_KEYWORDS = [
  "beat", "record", "jump", "soar", "surge", "approve", "launch", "partnership", 
  "buyback", "dividend", "upgrade", "growth", "high", "raises", "strong", 
  "acquisition", "merger", "outperform", "bull", "breakout", "rally", "gain",
  "positive", "success", "won", "contract", "deal", "guidance up"
];

const BEARISH_KEYWORDS = [
  "miss", "fail", "drop", "fall", "plunge", "sue", "lawsuit", "investigation", 
  "downgrade", "cut", "weak", "loss", "ban", "warning", "delay", "halt",
  "bear", "sell", "underperform", "crash", "correction", "risk", "debt", 
  "layoff", "fired", "probe", "reject", "guidance down"
];

const BATCH_SIZE = 15;
const DELAY_MS = 150; // Rate limit için güvenli aralık

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

// --- YARDIMCI FONKSİYONLAR ---

const clamp = (n: number, a: number, b: number) => Math.max(a, Math.min(b, n));

function shuffleArray<T>(array: T[]): T[] {
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

// --- 2. RETRY MEKANİZMASI (Hata durumunda 3 kez dener) ---
async function fetchWithRetry(url: string, retries = 3, delay = 500) {
  for (let i = 0; i < retries; i++) {
    try {
      const res = await fetch(url, { cache: "no-store" });
      if (res.ok) return res; // Başarılıysa dön
      
      // Rate limit (429) ise daha uzun bekle
      if (res.status === 429) await sleep(delay * 2);
      
    } catch (err) {
      console.warn(`Fetch failed (attempt ${i + 1}/${retries}):`, err);
    }
    // Hata durumunda bekle ve tekrar dene
    if (i < retries - 1) await sleep(delay);
  }
  return null; // Hepsi başarısız olduysa null dön
}

// --- 3. BINARY SEARCH (Hızlı Tarih Bulma) ---
// Candle array sıralı olduğu için findIndex yerine bunu kullanıyoruz.
function findCandleIndex(times: number[], targetUnix: number): number {
  let left = 0;
  let right = times.length - 1;
  let ans = -1;

  while (left <= right) {
    const mid = (left + right) >>> 1; // Bitwise shift (Math.floor'dan hızlı)
    if (times[mid] >= targetUnix) {
      ans = mid;     // Potansiyel aday
      right = mid - 1; // Daha öncesine bak (en yakın tarihi bulmak için)
    } else {
      left = mid + 1;
    }
  }
  return ans;
}

// --- AKILLI SKORLAMA MOTORU ---
function calculateSmartScore(
  headline: string,
  retPre5: number | null,
  ret1d: number | null,
  ret5d: number | null
) {
  const text = headline.toLowerCase();
  
  // A) GERÇEKLEŞEN ETKİ (Realized)
  if (ret5d !== null || ret1d !== null) {
    const rUsed = ret5d ?? ret1d ?? 0;
    const realizedBase = clamp(Math.round(Math.abs(rUsed) * 1000), 0, 50);
    
    let penalty = 0;
    let isPricedIn = false;
    
    if (typeof retPre5 === "number" && Math.abs(retPre5) > 0.05 && Math.abs(rUsed) < Math.abs(retPre5) * 0.5) {
      isPricedIn = true;
      penalty = 20;
    }

    const score = clamp(50 + realizedBase - penalty, 40, 100);
    return { score, pricedIn: isPricedIn, confidence: ret5d ? 90 : 60, tooEarly: false };
  }

  // B) TAHMİNİ ETKİ (NLP + Priced-in Logic)
  let baseScore = 50;
  let confidence = 30;
  let isPricedIn = false;

  // Kelime Analizi
  let sentimentScore = 0;
  BULLISH_KEYWORDS.forEach(w => { if(text.includes(w)) sentimentScore += 15; });
  BEARISH_KEYWORDS.forEach(w => { if(text.includes(w)) sentimentScore -= 15; });
  sentimentScore = clamp(sentimentScore, -25, 25); // Aralığı biraz açtık
  baseScore += sentimentScore;

  // Fiyatlanma Analizi
  if (typeof retPre5 === "number") {
    // İyi Haber + Yüksek Prim -> Satış Riski
    if (sentimentScore > 0 && retPre5 > 0.05) {
      baseScore -= 25; 
      isPricedIn = true;
      confidence += 20;
    }
    // Kötü Haber + Dip Fiyat -> Tepki Alımı
    else if (sentimentScore < 0 && retPre5 < -0.05) {
      baseScore += 15;
      isPricedIn = true;
    }
    // İyi Haber + Yatay/Düşük -> Sürpriz Yükseliş
    else if (sentimentScore > 0 && retPre5 <= 0.02) {
      baseScore += 15;
    }
  }

  return {
    score: clamp(baseScore, 30, 95),
    pricedIn: isPricedIn,
    confidence,
    tooEarly: true
  };
}

async function fetchSymbolItems(symbol: string, perSymbol: number): Promise<LeaderItem[]> {
  const now = new Date();
  const fromDate = new Date(now.getTime() - 30 * 24 * 3600 * 1000); // 30 Günlük Haber
  
  const toUnix = Math.floor(now.getTime() / 1000);
  const fromUnix = Math.floor(toUnix - 120 * 24 * 3600); 

  const items: LeaderItem[] = [];

  // 1. Haberleri Çek (Retry ile)
  const newsUrl = `https://finnhub.io/api/v1/company-news?symbol=${symbol}&from=${fromDate.toISOString().slice(0, 10)}&to=${now.toISOString().slice(0, 10)}&token=${FINNHUB_API_KEY}`;
  const newsRes = await fetchWithRetry(newsUrl);

  if (!newsRes) return items;
  const news = await newsRes.json();
  if (!Array.isArray(news) || news.length === 0) return items;

  // 2. Fiyatları Çek (Retry ile)
  const candleUrl = `https://finnhub.io/api/v1/stock/candle?symbol=${encodeURIComponent(symbol)}&resolution=D&from=${fromUnix}&to=${toUnix}&token=${FINNHUB_API_KEY}`;
  const candleRes = await fetchWithRetry(candleUrl);
  
  let candles: { t: number[], c: number[] } | null = null;
  if (candleRes) {
      const data = await candleRes.json();
      if (data.s === "ok") candles = { t: data.t, c: data.c };
  }

  const seen = new Set<string>();

  for (const n of news) {
    if (!n?.headline || !n?.datetime) continue;
    
    // Basit Dedupe (Local)
    const key = `${n.datetime}|${n.headline}`;
    if (seen.has(key)) continue;
    seen.add(key);

    let ret1d: number | null = null;
    let ret5d: number | null = null;
    let retPre5: number | null = null;

    if (candles) {
      // 3. Binary Search Kullanımı
      const idx = findCandleIndex(candles.t, n.datetime);
      
      if (idx !== -1 && idx < candles.c.length) {
        const base = candles.c[idx];
        
        if (idx + 1 < candles.c.length) ret1d = (candles.c[idx + 1] - base) / base;
        if (idx + 5 < candles.c.length) ret5d = (candles.c[idx + 5] - base) / base;
        if (idx - 5 >= 0) retPre5 = (base - candles.c[idx - 5]) / candles.c[idx - 5];
      }
    }

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
      ...analysis,
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
    const min = parseInt(searchParams.get("min") || "30", 10);
    const limit = parseInt(searchParams.get("limit") || "50", 10);
    const perSymbol = parseInt(searchParams.get("perSymbol") || "2", 10);

    const shuffledSymbols = shuffleArray(ALL_SYMBOLS).slice(0, BATCH_SIZE);
    
    const all: LeaderItem[] = [];
    const globalSeen = new Set<string>();

    for (const sym of shuffledSymbols) {
      const items = await fetchSymbolItems(sym, perSymbol);
      
      for (const it of items) {
        // --- 4. GÜÇLÜ GLOBAL DEDUPE ---
        // Sembol + Tam Tarih + Başlık (Küçük harf trim)
        const k = `${it.symbol}|${it.publishedAt}|${it.headline.trim().toLowerCase()}`;
        
        if (globalSeen.has(k)) continue;
        globalSeen.add(k);
        all.push(it);
      }
      
      // 5. Optimize Edilmiş Delay
      await sleep(DELAY_MS);
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
