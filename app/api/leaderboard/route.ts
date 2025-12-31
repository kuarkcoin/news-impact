import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const maxDuration = 60;

// Test için listeyi biraz daha genişletebilirsin artık, koruma ekledik.
const SYMBOLS = ["AAPL", "NVDA", "TSLA", "MSFT", "AMD", "AMZN", "META", "GOOGL", "INTC", "NFLX"];
const FINNHUB_API_KEY = process.env.FINNHUB_API_KEY;

const clamp = (n: number, a: number, b: number) => Math.max(a, Math.min(b, n));

// --- TİP TANIMLARI ---
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

// Rate Limit Koruması: Rastgele bekleme süresi
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function toUnixSec(d: Date) {
  return Math.floor(d.getTime() / 1000);
}

function dayStartUtcSec(unixSec: number) {
  const d = new Date(unixSec * 1000);
  const day = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  return Math.floor(day / 1000);
}

function scoreFromReturns(ret5d: number | null, ret1d: number | null, retPre5: number | null) {
  if (ret1d === null && ret5d === null) {
    return {
      expectedImpact: 50,
      realizedImpact: 50,
      pricedIn: null,
      confidence: 5,
      tooEarly: true,
    };
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

  let conf = 25;
  if (ret1d !== null) conf += 20;
  if (ret5d !== null) conf += 35;
  if (typeof retPre5 === "number") conf += 10;
  if (Math.abs(rUsed) >= 0.02) conf += 10;
  if (pricedIn === true) conf -= 10;
  conf = clamp(conf, 0, 100);

  return {
    expectedImpact,
    realizedImpact,
    pricedIn,
    confidence: conf,
    tooEarly: false,
  };
}

// --- VERİ ÇEKME ---

async function fetchCandles(symbol: string, fromUnix: number, toUnix: number) {
  try {
    const url = `https://finnhub.io/api/v1/stock/candle?symbol=${encodeURIComponent(
      symbol
    )}&resolution=D&from=${fromUnix}&to=${toUnix}&token=${FINNHUB_API_KEY}`;

    const res = await fetch(url, { next: { revalidate: 3600 } }); // Candle verisi sık değişmez, 1 saat cache
    if (!res.ok) return null;

    const data = await res.json();
    if (data?.s !== "ok" || !Array.isArray(data?.t) || !Array.isArray(data?.c)) return null;

    return {
      t: data.t as number[],
      c: data.c as number[],
    };
  } catch {
    return null;
  }
}

function findCandleIndexForNews(candleT: number[], newsUnixSec: number) {
  const daySec = dayStartUtcSec(newsUnixSec);
  // Binary Search
  let lo = 0;
  let hi = candleT.length - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (candleT[mid] >= daySec) {
      ans = mid;
      hi = mid - 1;
    } else {
      lo = mid + 1;
    }
  }
  return ans;
}

function safeRet(a: number, b: number) {
  if (!isFinite(a) || a === 0) return null;
  return (b - a) / a;
}

async function fetchSymbolItems(symbol: string): Promise<LeaderItem[]> {
  if (!FINNHUB_API_KEY) return [];

  // API Koruması: Her hisse isteği arasında ufak, rastgele bir gecikme yap
  // Bu sayede hepsi aynı milisaniyede Finnhub'a çarpmaz.
  await sleep(Math.floor(Math.random() * 500) + 100); 

  const now = new Date();
  
  // 10 gün öncesine kadar olan haberleri al (Böylece +5D verisi oluşmuş olur)
  const toDate = new Date(now.getTime() - 10 * 24 * 3600 * 1000);
  const fromDate = new Date(now.getTime() - 45 * 24 * 3600 * 1000);

  const fromStr = fromDate.toISOString().slice(0, 10);
  const toStr = toDate.toISOString().slice(0, 10);

  const toUnix = toUnixSec(now);
  const fromUnix = toUnix - 120 * 24 * 3600;

  try {
    // 1) News
    const newsUrl = `https://finnhub.io/api/v1/company-news?symbol=${encodeURIComponent(
      symbol
    )}&from=${fromStr}&to=${toStr}&token=${FINNHUB_API_KEY}`;

    const newsRes = await fetch(newsUrl, { next: { revalidate: 60 } });
    if (!newsRes.ok) return [];

    const news = await newsRes.json();
    if (!Array.isArray(news) || news.length === 0) return [];

    // 2) Candles
    const candles = await fetchCandles(symbol, fromUnix, toUnix);
    if (!candles) return [];

    const items: LeaderItem[] = [];
    const seen = new Set<string>();

    // Sadece en önemli/yeni 5 haberi işle (UI şişmesin)
    for (const n of news.slice(0, 5)) {
      const headline = String(n?.headline || "").trim();
      const dt = Number(n?.datetime || 0);
      if (!headline || !dt) continue;

      const key = `${symbol}-${dt}-${headline}`;
      if (seen.has(key)) continue;
      seen.add(key);

      const idx = findCandleIndexForNews(candles.t, dt);
      if (idx < 0 || idx >= candles.c.length) continue;

      const base = candles.c[idx];
      const ret1d = idx + 1 < candles.c.length ? safeRet(base, candles.c[idx + 1]) : null;
      const ret5d = idx + 5 < candles.c.length ? safeRet(base, candles.c[idx + 5]) : null;
      const retPre5 = idx - 5 >= 0 ? safeRet(candles.c[idx - 5], base) : null;

      const { expectedImpact, realizedImpact, pricedIn, confidence, tooEarly } =
        scoreFromReturns(ret5d, ret1d, retPre5);

      items.push({
        symbol,
        headline,
        type: n?.category ? String(n.category) : null,
        publishedAt: new Date(dt * 1000).toISOString(),
        url: n?.url ? String(n.url) : null,
        retPre5,
        ret1d,
        ret5d,
        pricedIn,
        expectedImpact,
        realizedImpact,
        score: expectedImpact, // UI'da ana sıralama puanı
        confidence,
        tooEarly,
      });
    }

    return items;
  } catch (e) {
    console.error(`Error processing ${symbol}:`, e);
    return [];
  }
}

// --- MAIN HANDLER ---

export async function GET(req: Request) {
  try {
    if (!FINNHUB_API_KEY) {
      return NextResponse.json({ error: "FINNHUB_API_KEY missing" }, { status: 500 });
    }

    const { searchParams } = new URL(req.url);
    const min = clamp(Number(searchParams.get("min") ?? 50) || 50, 0, 100);
    const limit = clamp(Number(searchParams.get("limit") ?? 30) || 30, 1, 200);

    // Promise.all ile paralel istek atıyoruz, ama içerdeki sleep sayesinde
    // Finnhub'a bombardıman yapmıyoruz.
    const all = await Promise.all(SYMBOLS.map((s) => fetchSymbolItems(s)));
    const flat = all.flat();

    const items = flat
      .filter((x) => x.score >= min)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);

    return NextResponse.json(
      {
        asOf: new Date().toISOString(),
        range: { min, max: 100 },
        count: items.length,
        items,
      },
      { status: 200 }
    );
  } catch (e: any) {
    return NextResponse.json(
      { error: e?.message || "Unknown error" },
      { status: 500 }
    );
  }
}
