import { NextResponse } from "next/server";
import { kv } from "@vercel/kv";

export const runtime = "nodejs";
export const maxDuration = 60;

const FINNHUB_API_KEY = process.env.FINNHUB_API_KEY;

// Ayarlar
const BATCH_SIZE = 10;
const PER_SYMBOL = 2;
const MAX_POOL_ITEMS = 600;
const MAX_NEWS_AGE_DAYS = 10;

// 200MA için en az 260 gün önerilir
const CANDLE_LOOKBACK_DAYS = 260;

// Candle KV cache (Finnhub free rate-limit için hayat kurtarır)
const CANDLE_CACHE_TTL_SEC = 6 * 60 * 60; // 6 saat

const DEFAULT_UNIVERSE: string[] = [
  "AAPL","MSFT","NVDA","AMZN","META","GOOGL","TSLA","AMD","AVGO","INTC","QCOM","TXN","MU","NFLX","ADBE","CRM",
  "PLTR","COIN","MSTR","UBER","SHOP","PYPL","ASML","AMAT","LRCX","KLAC","SNPS","CDNS","NOW","INTU","CSCO","ORCL"
];

const BULLISH_KEYWORDS = [
  "beat","record","jump","soar","surge","approve","launch","partnership","buyback","dividend","upgrade","growth",
  "raises","raise","strong","profit","wins","contract","guidance","earnings"
];

const BEARISH_KEYWORDS = [
  "miss","fail","drop","fall","plunge","sue","lawsuit","investigation","downgrade","cut","weak","loss","ban",
  "recall","resign","delay","lower","warning","sec","probe"
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

  // ✅ NEW
  technicalContext: string | null;
};

type CandleData = { t: number[]; c: number[] };

const clamp = (n: number, a: number, b: number) => Math.max(a, Math.min(b, n));

function assertCronAuth(req: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;

  // 1) query ?secret=...
  const { searchParams } = new URL(req.url);
  if (searchParams.get("secret") === secret) return true;

  // 2) header Authorization: Bearer <secret>
  const authHeader = req.headers.get("authorization");
  if (authHeader === `Bearer ${secret}`) return true;

  return false;
}

function pickBatch(universe: string[], cursor: number) {
  const batch: string[] = [];
  for (let i = 0; i < BATCH_SIZE; i++) batch.push(universe[(cursor + i) % universe.length]);
  const nextCursor = (cursor + BATCH_SIZE) % universe.length;
  return { batch, nextCursor };
}

/** last index where times[idx] <= target */
function findLastLE(times: number[], target: number) {
  let lo = 0, hi = times.length - 1, ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (times[mid] <= target) { ans = mid; lo = mid + 1; }
    else hi = mid - 1;
  }
  return ans;
}

async function fetchWithRetry(url: string, maxRetries = 3) {
  let lastErr: any = null;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const res = await fetch(url, { cache: "no-store" });

      if (res.status === 429) {
        // basit backoff
        const wait = attempt === 0 ? 800 : attempt === 1 ? 1600 : 2600;
        await new Promise((r) => setTimeout(r, wait));
        lastErr = new Error("429");
        continue;
      }

      if (res.status >= 500) {
        const wait = attempt === 0 ? 500 : attempt === 1 ? 1200 : 2200;
        await new Promise((r) => setTimeout(r, wait));
        lastErr = new Error(`HTTP_${res.status}`);
        continue;
      }

      return res;
    } catch (e) {
      lastErr = e;
      const wait = attempt === 0 ? 500 : attempt === 1 ? 1200 : 2200;
      await new Promise((r) => setTimeout(r, wait));
    }
  }
  throw lastErr ?? new Error("fetch failed");
}

function sentimentFromHeadline(headline: string) {
  const text = headline.toLowerCase();
  let s = 0;

  for (const w of BULLISH_KEYWORDS) if (text.includes(w)) s += 15;
  for (const w of BEARISH_KEYWORDS) if (text.includes(w)) s -= 15;

  // basit “but/despite/however” zayıflatma
  if (text.includes("but") || text.includes("despite") || text.includes("however")) {
    s = Math.round(s * 0.65);
  }

  // earnings/guidance bonus
  if (text.includes("earnings") || text.includes("guidance")) s += 10;

  return clamp(s, -30, 30);
}

function calcExpectedImpact(headline: string, retPre5: number | null) {
  const s = sentimentFromHeadline(headline);

  let exp = 65 + Math.round(s * 0.9);
  let pricedIn = false;

  if (typeof retPre5 === "number") {
    if (s > 0 && retPre5 > 0.05) { exp -= 22; pricedIn = true; }
    if (s < 0 && retPre5 < -0.05) { exp += 10; pricedIn = true; }
    if (s > 0 && retPre5 <= 0.02) exp += 10;
  }

  return { expectedImpact: clamp(exp, 50, 95), pricedIn };
}

function calcRealizedImpact(ret1d: number | null, ret5d: number | null) {
  const rUsed = (ret5d ?? ret1d);
  if (typeof rUsed !== "number") return null;

  const base = clamp(Math.round(Math.abs(rUsed) * 1000), 0, 50);
  return clamp(50 + base, 50, 100);
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

function smaAt(closes: number[], idx: number, period: number) {
  const start = idx - period + 1;
  if (start < 0) return null;
  let sum = 0;
  for (let i = start; i <= idx; i++) sum += closes[i];
  return sum / period;
}

function minAt(closes: number[], idx: number, lookback: number) {
  const start = Math.max(0, idx - lookback + 1);
  let m = Infinity;
  for (let i = start; i <= idx; i++) m = Math.min(m, closes[i]);
  return Number.isFinite(m) ? m : null;
}

function maxAt(closes: number[], idx: number, lookback: number) {
  const start = Math.max(0, idx - lookback + 1);
  let m = -Infinity;
  for (let i = start; i <= idx; i++) m = Math.max(m, closes[i]);
  return Number.isFinite(m) ? m : null;
}

/**
 * ✅ Basit teknik bağlam:
 * - Trend: Uptrend / Downtrend / Range
 * - Momentum: 10günlük hareket büyükse
 * - Near support/resistance: 20günlük min/max'a yakınsa
 */
function technicalContextAt(c: number[], idx: number) {
  if (!c?.length || idx < 0 || idx >= c.length) return null;

  const price = c[idx];

  const ma50 = smaAt(c, idx, 50);
  const ma200 = smaAt(c, idx, 200);

  let trend = "🟨 Range";
  if (ma50 !== null && ma200 !== null) {
    if (price > ma50 && ma50 > ma200) trend = "📈 Uptrend";
    else if (price < ma50 && ma50 < ma200) trend = "📉 Downtrend";
    else trend = "🟨 Range";
  }

  // momentum: 10 günlük getiri (varsa)
  let momentumTag: string | null = null;
  if (idx - 10 >= 0) {
    const r10 = (price - c[idx - 10]) / c[idx - 10];
    if (Math.abs(r10) >= 0.06) momentumTag = "🔥 Momentum";
  }

  // support / resistance: son 20 gün min/max'a yakınlık
  const sup = minAt(c, idx, 20);
  const res = maxAt(c, idx, 20);
  let levelTag: string | null = null;

  if (sup !== null) {
    const dist = (price - sup) / price;
    if (dist <= 0.02) levelTag = "🧲 Near support";
  }
  if (!levelTag && res !== null) {
    const dist = (res - price) / price;
    if (dist <= 0.02) levelTag = "🧲 Near resistance";
  }

  const parts = [trend, momentumTag, levelTag].filter(Boolean) as string[];
  return parts.join(" · ");
}

async function getCandlesCached(symbol: string, fromUnix: number, toUnix: number): Promise<CandleData | null> {
  const key = `candles:D:${symbol}:lb=${CANDLE_LOOKBACK_DAYS}`;
  try {
    const cached = (await kv.get(key)) as CandleData | null;
    if (cached?.t?.length && cached?.c?.length) return cached;
  } catch {}

  try {
    const url =
      `https://finnhub.io/api/v1/stock/candle?symbol=${encodeURIComponent(symbol)}` +
      `&resolution=D&from=${fromUnix}&to=${toUnix}&token=${FINNHUB_API_KEY}`;

    const res = await fetchWithRetry(url);
    if (!res.ok) return null;

    const data = await res.json();
    if (data?.s !== "ok") return null;

    const payload: CandleData = { t: data.t as number[], c: data.c as number[] };

    // cache yaz (fail olsa da sıkıntı değil)
    try { await kv.set(key, payload, { ex: CANDLE_CACHE_TTL_SEC }); } catch {}

    return payload;
  } catch {
    return null;
  }
}

async function fetchSymbolItems(symbol: string): Promise<LeaderItem[]> {
  const now = new Date();
  const toUnix = Math.floor(now.getTime() / 1000);
  const fromUnix = Math.floor(toUnix - CANDLE_LOOKBACK_DAYS * 24 * 3600);

  const newsFrom = new Date(now.getTime() - 7 * 24 * 3600 * 1000).toISOString().slice(0, 10);
  const newsTo = now.toISOString().slice(0, 10);

  const newsUrl =
    `https://finnhub.io/api/v1/company-news?symbol=${encodeURIComponent(symbol)}` +
    `&from=${newsFrom}&to=${newsTo}&token=${FINNHUB_API_KEY}`;

  const newsRes = await fetchWithRetry(newsUrl);
  if (!newsRes.ok) {
    if (newsRes.status === 429) throw new Error("429");
    return [];
  }

  const news = await newsRes.json();
  if (!Array.isArray(news) || news.length === 0) return [];

  // candles (cache’li)
  const candles = await getCandlesCached(symbol, fromUnix, toUnix);

  const items: LeaderItem[] = [];
  const seen = new Set<string>();

  for (const n of news) {
    if (!n?.headline || !n?.datetime) continue;

    // yaş filtresi
    const ageDays = (Date.now() - Number(n.datetime) * 1000) / (1000 * 60 * 60 * 24);
    if (ageDays > MAX_NEWS_AGE_DAYS) continue;

    const key = `${symbol}|${n.datetime}|${String(n.headline).slice(0, 120)}`;
    if (seen.has(key)) continue;
    seen.add(key);

    let ret1d: number | null = null;
    let ret5d: number | null = null;
    let retPre5: number | null = null;
    let tech: string | null = null;

    if (candles?.t?.length && candles?.c?.length) {
      const idx = findLastLE(candles.t, Number(n.datetime));
      if (idx !== -1) {
        const base = candles.c[idx];

        if (idx + 1 < candles.c.length) ret1d = (candles.c[idx + 1] - base) / base;
        if (idx + 5 < candles.c.length) ret5d = (candles.c[idx + 5] - base) / base;
        if (idx - 5 >= 0) retPre5 = (base - candles.c[idx - 5]) / candles.c[idx - 5];

        // ✅ teknik bağlamı haber zamanına göre üret
        tech = technicalContextAt(candles.c, idx);
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
      realizedImpact: realizedImpact ?? exp.expectedImpact,
      score,
      confidence,
      tooEarly,

      technicalContext: tech
    });

    if (items.length >= PER_SYMBOL) break;
  }

  return items;
}

export async function GET(req: Request) {
  if (!FINNHUB_API_KEY) {
    return NextResponse.json({ error: "No FINNHUB_API_KEY" }, { status: 500 });
  }

  if (!assertCronAuth(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const universe = ((await kv.get("symbols:universe")) as string[] | null) ?? DEFAULT_UNIVERSE;
    const cursor = ((await kv.get("symbols:cursor")) as number | null) ?? 0;

    const { batch, nextCursor } = pickBatch(universe, cursor);

    const newItems: LeaderItem[] = [];

    for (const sym of batch) {
      try {
        const arr = await fetchSymbolItems(sym);
        newItems.push(...arr);
      } catch (e: any) {
        // 429 ise “global” hata döndürelim (ürün davranışı)
        if (String(e?.message || "").includes("429")) throw e;
        console.error("symbol fetch error", sym, e);
      }
    }

    const poolRaw = (await kv.get("pool:v1")) as { asOf: string; items: LeaderItem[] } | null;
    const oldItems = poolRaw?.items || [];

    // yeni başa, eski arkaya
    const merged = [...newItems, ...oldItems].slice(0, MAX_POOL_ITEMS);

    await kv.set("pool:v1", { asOf: new Date().toISOString(), items: merged });
    await kv.set("symbols:cursor", nextCursor);

    return NextResponse.json({ ok: true, scanned: batch, added: newItems.length }, { status: 200 });
  } catch (e: any) {
    if (String(e?.message || "").includes("429")) {
      return NextResponse.json(
        { error: "Rate limit exceeded – please try again later" },
        { status: 429 }
      );
    }
    return NextResponse.json({ error: e?.message || "Unknown error" }, { status: 500 });
  }
}