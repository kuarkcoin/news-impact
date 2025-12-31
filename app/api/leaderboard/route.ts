import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const maxDuration = 60;

const SYMBOLS = ["AAPL", "NVDA", "TSLA", "MSFT", "AMD", "AMZN", "META", "GOOGL"];
const FINNHUB_API_KEY = process.env.FINNHUB_API_KEY;

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
  expectedImpact: number; // 50..100
  realizedImpact: number; // 50..100
  score: number;

  confidence: number; // 0..100
  tooEarly: boolean;  // label
};

function toUnixSec(d: Date) {
  return Math.floor(d.getTime() / 1000);
}
function dayStartUtcSec(unixSec: number) {
  const d = new Date(unixSec * 1000);
  const day = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  return Math.floor(day / 1000);
}
function safeRet(a: number, b: number) {
  if (!isFinite(a) || a === 0) return null;
  return (b - a) / a;
}

function scoreFromReturns(ret5d: number | null, ret1d: number | null, retPre5: number | null) {
  if (ret1d === null && ret5d === null) {
    return {
      expectedImpact: 50,
      realizedImpact: 50,
      pricedIn: null as boolean | null,
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

  return { expectedImpact, realizedImpact, pricedIn, confidence: conf, tooEarly: false };
}

async function fetchJsonSafe(url: string) {
  const res = await fetch(url, { cache: "no-store" });
  const text = await res.text().catch(() => "");
  let json: any = null;
  try { json = text ? JSON.parse(text) : null; } catch {}
  return { ok: res.ok, status: res.status, text: text.slice(0, 220), json };
}

async function fetchCandles(symbol: string, fromUnix: number, toUnix: number) {
  const url = `https://finnhub.io/api/v1/stock/candle?symbol=${encodeURIComponent(
    symbol
  )}&resolution=D&from=${fromUnix}&to=${toUnix}&token=${FINNHUB_API_KEY}`;

  const { ok, status, json, text } = await fetchJsonSafe(url);
  if (!ok) return { ok: false, status, reason: text, t: [] as number[], c: [] as number[] };

  if (json?.s !== "ok" || !Array.isArray(json?.t) || !Array.isArray(json?.c)) {
    return { ok: false, status: 200, reason: "candles malformed", t: [], c: [] as number[] };
  }

  return { ok: true, status: 200, reason: null as any, t: json.t as number[], c: json.c as number[] };
}

function findCandleIndexForNews(candleT: number[], newsUnixSec: number) {
  const daySec = dayStartUtcSec(newsUnixSec);
  let lo = 0, hi = candleT.length - 1, ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (candleT[mid] >= daySec) { ans = mid; hi = mid - 1; }
    else lo = mid + 1;
  }
  return ans;
}

async function fetchSymbolItems(symbol: string): Promise<{ items: LeaderItem[]; debug: any }> {
  const debug: any = { symbol };

  if (!FINNHUB_API_KEY) {
    debug.error = "FINNHUB_API_KEY missing (server env)";
    return { items: [], debug };
  }

  const now = new Date();
  const fromDate = new Date(now.getTime() - 14 * 24 * 3600 * 1000);
  const toDate = now;

  const fromStr = fromDate.toISOString().slice(0, 10);
  const toStr = toDate.toISOString().slice(0, 10);

  // Finnhub free limit risk: tek endpoint test
  const testUrl = `https://finnhub.io/api/v1/quote?symbol=AAPL&token=${FINNHUB_API_KEY}`;
  const test = await fetchJsonSafe(testUrl);
  debug.keyTest = { ok: test.ok, status: test.status, sample: test.ok ? test.json : test.text };
  if (!test.ok) {
    debug.note = "API key invalid/blocked OR rate-limited (see keyTest)";
    return { items: [], debug };
  }

  const newsUrl = `https://finnhub.io/api/v1/company-news?symbol=${encodeURIComponent(
    symbol
  )}&from=${fromStr}&to=${toStr}&token=${FINNHUB_API_KEY}`;

  const newsRes = await fetchJsonSafe(newsUrl);
  debug.news = { ok: newsRes.ok, status: newsRes.status, sample: newsRes.ok ? undefined : newsRes.text };

  if (!newsRes.ok) return { items: [], debug };

  const news = newsRes.json;
  debug.newsCount = Array.isArray(news) ? news.length : 0;

  if (!Array.isArray(news) || news.length === 0) {
    debug.note = "No news in date range";
    return { items: [], debug };
  }

  const toUnix = toUnixSec(now);
  const fromUnix = toUnix - 140 * 24 * 3600;

  const candles = await fetchCandles(symbol, fromUnix, toUnix);
  debug.candles = { ok: candles.ok, status: candles.status, count: candles.t.length, reason: candles.reason };

  if (!candles.ok || candles.t.length < 10) return { items: [], debug };

  const items: LeaderItem[] = [];
  const seen = new Set<string>();

  for (const n of news.slice(0, 10)) {
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
      score: expectedImpact,

      confidence,
      tooEarly,
    });
  }

  debug.itemsBuilt = items.length;
  return { items, debug };
}

export async function GET(req: Request) {
  try {
    const { searchParams } = new URL(req.url);
    const min = clamp(Number(searchParams.get("min") ?? 50) || 50, 0, 100);
    const limit = clamp(Number(searchParams.get("limit") ?? 30) || 30, 1, 200);

    const results = await Promise.all(SYMBOLS.map((s) => fetchSymbolItems(s)));
    const flat = results.flatMap((r) => r.items);

    const items = flat
      .filter((x) => x.score >= min)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);

    return NextResponse.json(
      {
        asOf: new Date().toISOString(),
        range: { min, max: 100 },
        items,
        debug: results.map((r) => r.debug), // ✅ her zaman debug
      },
      { status: 200 }
    );
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || "Unknown error" }, { status: 500 });
  }
}