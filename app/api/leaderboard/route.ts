// app/api/leaderboard/route.ts
import { NextResponse } from "next/server";
import { kv } from "@vercel/kv";

export const runtime = "nodejs";
export const maxDuration = 60;

const FINNHUB_API_KEY = process.env.FINNHUB_API_KEY;

// 🔥 HAVUZ (Taranacak Hisseler)
const ALL_SYMBOLS = [
  "AAPL", "MSFT", "NVDA", "AMZN", "META", "GOOGL", "TSLA",
  "AMD", "AVGO", "INTC", "QCOM", "TXN", "MU", "NFLX", "ADBE",
  "CRM", "PLTR", "COIN", "MSTR", "UBER", "SHOP", "PYPL"
];

// Finnhub Free için daha güvenli ayarlar
const BATCH_SIZE = 6;            // daha güvenli
const CONCURRENCY = 2;           // daha güvenli
const CACHE_TTL_MS = 120_000;    // 120 sn
const MAX_NEWS_AGE_DAYS = 10;    // eski haberleri kes

// --- KELİME ANALİZİ (BASİT NLP) ---
const BULLISH_KEYWORDS = [
  "beat", "record", "jump", "soar", "surge", "approve", "launch",
  "partnership", "buyback", "dividend", "upgrade", "growth",
  "raises", "raise", "strong", "profit", "wins", "contract",
  "guidance", "earnings"
];

const BEARISH_KEYWORDS = [
  "miss", "fail", "drop", "fall", "plunge", "sue", "lawsuit",
  "investigation", "downgrade", "cut", "weak", "loss", "ban",
  "recall", "resign", "delay", "lower", "warning", "sec", "probe"
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

  expectedImpact: number; // 50..100
  realizedImpact: number; // 50..100
  score: number;          // 50..100
  confidence: number;     // 0..100
  tooEarly: boolean;      // veri yoksa true
};

const clamp = (n: number, a: number, b: number) => Math.max(a, Math.min(b, n));

/** Persistent cache (Vercel KV) */
async function getCache(key: string) {
  try {
    return await kv.get(key);
  } catch {
    return null;
  }
}

async function setCache(key: string, payload: any) {
  try {
    await kv.set(key, payload, { ex: Math.floor(CACHE_TTL_MS / 1000) });
  } catch {
    // cache fail olsa da response dönelim
  }
}

/** Fisher-Yates shuffle */
function shuffleArray(array: string[]) {
  const arr = [...array];
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

/** Concurrency pool */
async function mapPool<T, R>(items: T[], concurrency: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let idx = 0;

  const workers = Array.from({ length: Math.max(1, concurrency) }, async () => {
    while (true) {
      const i = idx++;
      if (i >= items.length) break;
      out[i] = await fn(items[i]);
    }
  });

  await Promise.all(workers);
  return out;
}

/** Backoff retry for Finnhub */
async function fetchWithRetry(url: string, init?: RequestInit, maxRetries = 3) {
  let lastErr: any = null;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const res = await fetch(url, { ...init, cache: "no-store" });

      if (res.status === 429) {
        // retry
        const wait = attempt === 0 ? 400 : attempt === 1 ? 1000 : 2200;
        await new Promise((r) => setTimeout(r, wait));
        lastErr = new Error("429");
        continue;
      }

      if (res.status >= 500 && res.status <= 599) {
        const wait = attempt === 0 ? 300 : attempt === 1 ? 800 : 1800;
        await new Promise((r) => setTimeout(r, wait));
        continue;
      }

      return res;
    } catch (e) {
      lastErr = e;
      const wait = attempt === 0 ? 300 : attempt === 1 ? 800 : 1800;
      await new Promise((r) => setTimeout(r, wait));
    }
  }

  throw lastErr ?? new Error("fetch failed");
}

/** Candles */
async function fetchCandles(symbol: string, fromUnix: number, toUnix: number) {
  try {
    const url = `https://finnhub.io/api/v1/stock/candle?symbol=${encodeURIComponent(
      symbol
    )}&resolution=D&from=${fromUnix}&to=${toUnix}&token=${FINNHUB_API_KEY}`;
    const res = await fetchWithRetry(url);
    if (!res.ok) return null;
    const data = await res.json();
    if (data?.s !== "ok") return null;
    return { t: data.t as number[], c: data.c as number[] };
  } catch {
    return null;
  }
}

/** last index where times[idx] <= target */
function findLastLE(times: number[], target: number) {
  let lo = 0, hi = times.length - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (times[mid] <= target) {
      ans = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return ans;
}

/** Sentiment (küçük iyileştirmelerle) */
function sentimentFromHeadline(headline: string) {
  const text = headline.toLowerCase();
  let s = 0;

  // Pozitif biraz daha güçlü, negatif daha sert
  for (const w of BULLISH_KEYWORDS) if (text.includes(w)) s += 18;
  for (const w of BEARISH_KEYWORDS) if (text.includes(w)) s -= 15;

  // "but / despite / however" varsa sentimenti zayıflat (basit tersleyici)
  if (text.includes("but") || text.includes("despite") || text.includes("however")) {
    s = Math.round(s * 0.65);
  }

  // Earnings / Guidance ekstra bonus (etkisi genelde güçlü)
  if (text.includes("earnings") || text.includes("guidance")) s += 10;

  return clamp(s, -30, 30);
}

function calcRealizedImpact(ret1d: number | null, ret5d: number | null) {
  const rUsed = (ret5d ?? ret1d);
  if (typeof rUsed !== "number") return null;

  // |%| * 1000 => %5 ≈ 50 puan
  const base = clamp(Math.round(Math.abs(rUsed) * 1000), 0, 50);
  return clamp(50 + base, 50, 100);
}

function calcExpectedImpact(headline: string, retPre5: number | null) {
  const s = sentimentFromHeadline(headline);

  let exp = 65 + Math.round(s * 0.9); // 65 ± ~27
  let pricedIn = false;

  if (typeof retPre5 === "number") {
    // iyi haber + önceden güçlü yükseliş => priced-in
    if (s > 0 && retPre5 > 0.05) {
      exp -= 22;
      pricedIn = true;
    }
    // kötü haber + önceden güçlü düşüş => zaten fiyatlandı/oversold
    if (s < 0 && retPre5 < -0.05) {
      exp += 10;
      pricedIn = true;
    }
    // iyi haber + önceden yatay/düşük => sürpriz etkisi
    if (s > 0 && retPre5 <= 0.02) exp += 10;
  }

  return { expectedImpact: clamp(exp, 50, 95), pricedIn };
}

function combineScore(expectedImpact: number, realizedImpact: number | null, pricedIn: boolean) {
  let score = realizedImpact === null
    ? expectedImpact
    : Math.round(realizedImpact * 0.7 + expectedImpact * 0.3);

  if (pricedIn) score -= 8;

  return clamp(score, 50, 100);
}

function calcConfidence(ret1d: number | null, ret5d: number | null, pricedIn: boolean) {
  let c = 30;
  if (ret1d !== null) c = 70;
  if (ret5d !== null) c = 90;
  if (pricedIn) c += 5;
  return clamp(c, 0, 100);
}

async function fetchSymbolItems(symbol: string, perSymbol: number): Promise<LeaderItem[]> {
  const now = new Date();
  const fromDate = new Date(now.getTime() - 30 * 24 * 3600 * 1000); // son 30 gün
  const toUnix = Math.floor(now.getTime() / 1000);
  const fromUnix = Math.floor(toUnix - 120 * 24 * 3600); // 120 gün candle

  const items: LeaderItem[] = [];

  const newsUrl =
    `https://finnhub.io/api/v1/company-news?symbol=${encodeURIComponent(symbol)}` +
    `&from=${fromDate.toISOString().slice(0, 10)}&to=${now.toISOString().slice(0, 10)}` +
    `&token=${FINNHUB_API_KEY}`;

  let news: any[] = [];
  const newsRes = await fetchWithRetry(newsUrl);
  if (!newsRes.ok) {
    if (newsRes.status === 429) throw new Error("429");
    return items;
  }
  const json = await newsRes.json();
  if (Array.isArray(json)) news = json;
  if (!news.length) return items;

  const candles = await fetchCandles(symbol, fromUnix, toUnix);
  const seen = new Set<string>();

  for (const n of news) {
    if (!n?.headline || !n?.datetime) continue;

    // ✅ Haber yaşı filtresi
    const ageDays = (Date.now() - Number(n.datetime) * 1000) / (1000 * 60 * 60 * 24);
    if (ageDays > MAX_NEWS_AGE_DAYS) continue;

    const key = `${symbol}|${n.datetime}|${String(n.headline).slice(0, 120)}`;
    if (seen.has(key)) continue;
    seen.add(key);

    let ret1d: number | null = null;
    let ret5d: number | null = null;
    let retPre5: number | null = null;

    if (candles?.t?.length && candles?.c?.length) {
      const idx = findLastLE(candles.t, Number(n.datetime));
      if (idx !== -1) {
        const base = candles.c[idx];

        if (idx + 1 < candles.c.length) ret1d = (candles.c[idx + 1] - base) / base;
        if (idx + 5 < candles.c.length) ret5d = (candles.c[idx + 5] - base) / base;
        if (idx - 5 >= 0) retPre5 = (base - candles.c[idx - 5]) / candles.c[idx - 5];
      }
    }

    const exp = calcExpectedImpact(String(n.headline), retPre5);
    const realizedImpact = calcRealizedImpact(ret1d, ret5d);
    const score = combineScore(exp.expectedImpact, realizedImpact, exp.pricedIn);
    const confidence = calcConfidence(ret1d, ret5d, exp.pricedIn);
    const tooEarly = realizedImpact === null;

    items.push({
      symbol,
      headline: String(n.headline),
      type: n.category ?? null,
      publishedAt: new Date(Number(n.datetime) * 1000).toISOString(),
      url: n.url ?? null,

      retPre5,
      ret1d,
      ret5d,

      pricedIn: exp.pricedIn,
      expectedImpact: exp.expectedImpact,
      realizedImpact: realizedImpact ?? exp.expectedImpact, // istersen null yapabiliriz
      score,
      confidence,
      tooEarly
    });

    if (items.length >= perSymbol) break;
  }

  return items;
}

export async function GET(req: Request) {
  try {
    if (!FINNHUB_API_KEY) {
      return NextResponse.json({ error: "No API Key", items: [] }, { status: 500 });
    }

    const { searchParams } = new URL(req.url);
    const min = parseInt(searchParams.get("min") || "50", 10);
    const limit = parseInt(searchParams.get("limit") || "50", 10);
    const perSymbol = parseInt(searchParams.get("perSymbol") || "2", 10);

    const safeMin = clamp(Number.isFinite(min) ? min : 50, 30, 100);
    const safeLimit = clamp(Number.isFinite(limit) ? limit : 50, 10, 100);
    const safePer = clamp(Number.isFinite(perSymbol) ? perSymbol : 2, 1, 4);

    const cacheKey = `lb:v2|min=${safeMin}|limit=${safeLimit}|per=${safePer}`;
    const cached = await getCache(cacheKey);
    if (cached) return NextResponse.json(cached, { status: 200 });

    const symbols = shuffleArray(ALL_SYMBOLS).slice(0, BATCH_SIZE);

    const results = await mapPool(symbols, CONCURRENCY, async (sym) => {
      try {
        return await fetchSymbolItems(sym, safePer);
      } catch (e: any) {
        // 429’ları yukarı taşıyoruz (global response için)
        if (String(e?.message || "").includes("429")) throw e;
        return [];
      }
    });

    const all: LeaderItem[] = [];
    const globalSeen = new Set<string>();

    for (const arr of results) {
      for (const it of arr) {
        const k = `${it.symbol}|${it.publishedAt}|${it.headline.trim().toLowerCase()}`;
        if (globalSeen.has(k)) continue;
        globalSeen.add(k);
        all.push(it);
      }
    }

    const filtered = all
      .filter((x) => (x.score ?? 0) >= safeMin)
      .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
      .slice(0, safeLimit);

    const payload = { asOf: new Date().toISOString(), items: filtered };

    await setCache(cacheKey, payload);
    return NextResponse.json(payload, { status: 200 });
  } catch (e: any) {
    // ✅ 429 UX
    if (String(e?.message || "").includes("429")) {
      return NextResponse.json(
        { error: "Rate limit exceeded – please try again in 1-2 minutes", items: [] },
        { status: 429 }
      );
    }
    return NextResponse.json({ error: e?.message || "Unknown error", items: [] }, { status: 500 });
  }
}