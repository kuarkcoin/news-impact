import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const maxDuration = 60;

const FINNHUB_API_KEY = process.env.FINNHUB_API_KEY;

// ✅ Başlangıç için 25-30 sembol ideal (rate limit riski azalır)
// İstersen bunu 50-100’e çıkarırız ama önce stabil çalışsın.
const SYMBOLS = [
  "AAPL","MSFT","NVDA","AMZN","META","GOOGL","TSLA","AMD","AVGO","ASML",
  "NFLX","ADBE","COST","INTC","QCOM","TXN","CSCO","AMAT","MU","INTU",
  "PEP","CMCSA","SBUX","ISRG","BKNG","PANW","CRWD","SNPS","NOW","UBER"
];

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

function scoreFromReturns(ret5d: number | null, ret1d: number | null, retPre5: number | null) {
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
  if (ret1d !== null) conf += 25;
  if (ret5d !== null) conf += 45;

  return {
    expectedImpact,
    realizedImpact,
    pricedIn,
    confidence: clamp(conf, 0, 100),
    tooEarly: false,
    score: expectedImpact,
  };
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
  } catch {
    return null;
  }
}

function makeKey(symbol: string, datetimeSec: number, headline: string) {
  return `${symbol}|${datetimeSec}|${headline.trim().toLowerCase()}`;
}

async function fetchSymbolItems(symbol: string, perSymbol: number): Promise<LeaderItem[]> {
  const now = new Date();
  const fromDate = new Date(now.getTime() - 30 * 24 * 3600 * 1000);

  const toUnix = Math.floor(now.getTime() / 1000);
  const fromUnix = Math.floor(toUnix - 140 * 24 * 3600); // candles için geniş tut

  const items: LeaderItem[] = [];

  // 1) News
  const newsRes = await fetch(
    `https://finnhub.io/api/v1/company-news?symbol=${symbol}&from=${fromDate.toISOString().slice(0, 10)}&to=${now
      .toISOString()
      .slice(0, 10)}&token=${FINNHUB_API_KEY}`,
    { cache: "no-store" }
  );

  if (!newsRes.ok) return items;

  const news = await newsRes.json();
  if (!Array.isArray(news) || news.length === 0) return items;

  // 2) Candles
  const candles = await fetchCandles(symbol, fromUnix, toUnix);

  // 3) Dedupe + Top N
  const seen = new Set<string>();

  for (const n of news) {
    if (!n?.headline || !n?.datetime) continue;

    const key = makeKey(symbol, n.datetime, n.headline);
    if (seen.has(key)) continue;
    seen.add(key);

    let ret1d: number | null = null;
    let ret5d: number | null = null;
    let retPre5: number | null = null;

    if (candles) {
      const idx = candles.t.findIndex((t) => t >= n.datetime);
      if (idx !== -1 && idx < candles.c.length) {
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
      type: n.category ?? null,
      publishedAt: new Date(n.datetime * 1000).toISOString(),
      url: n.url ?? null,

      retPre5,
      ret1d,
      ret5d,

      ...scores,
    });

    if (items.length >= perSymbol) break;
  }

  return items;
}

export async function GET(req: Request) {
  try {
    if (!FINNHUB_API_KEY) {
      return NextResponse.json({ error: "FINNHUB_API_KEY missing", asOf: new Date().toISOString(), items: [] }, { status: 500 });
    }

    const { searchParams } = new URL(req.url);
    const min = clamp(parseInt(searchParams.get("min") || "50", 10), 0, 100);
    const limit = clamp(parseInt(searchParams.get("limit") || "50", 10), 1, 200);

    // ✅ her sembolden kaç haber alalım
    const perSymbol = clamp(parseInt(searchParams.get("perSymbol") || "2", 10), 1, 5);

    const all: LeaderItem[] = [];
    const globalSeen = new Set<string>();

    // ✅ sequential + küçük delay (rate limit savunması)
    for (const sym of SYMBOLS) {
      const items = await fetchSymbolItems(sym, perSymbol);

      // global dedupe (bazı “midday stories” farklı sembollerde aynı başlık olabiliyor)
      for (const it of items) {
        const k = `${it.symbol}|${it.publishedAt}|${it.headline.trim().toLowerCase()}`;
        if (globalSeen.has(k)) continue;
        globalSeen.add(k);
        all.push(it);
      }

      await sleep(120); // 100-200ms iyi çalışır
    }

    // filter + sort + limit
    const filtered = all
      .filter((x) => (x.score ?? 0) >= min)
      .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
      .slice(0, limit);

    return NextResponse.json({ asOf: new Date().toISOString(), items: filtered }, { status: 200 });
  } catch (e: any) {
    return NextResponse.json(
      { error: e?.message || "Unknown error", asOf: new Date().toISOString(), items: [] },
      { status: 500 }
    );
  }
}