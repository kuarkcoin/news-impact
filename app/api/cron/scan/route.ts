import { NextResponse } from "next/server";
import { kv } from "@vercel/kv";

export const runtime = "nodejs";
export const maxDuration = 60; // Finnhub yavaş olabilir, süreyi artırdık

const FINNHUB_API_KEY = process.env.FINNHUB_API_KEY;
const CRON_SECRET = process.env.CRON_SECRET;

// Ayarlar
const BATCH_SIZE = 10;
const PER_SYMBOL = 2;
const MAX_POOL_ITEMS = 600;
const MAX_NEWS_AGE_DAYS = 10;
const CANDLE_LOOKBACK_DAYS = 140;

const DEFAULT_UNIVERSE: string[] = [
  "AAPL","MSFT","NVDA","AMZN","META","GOOGL","TSLA","AMD","AVGO","INTC","QCOM","TXN","MU","NFLX","ADBE","CRM",
  "PLTR","COIN","MSTR","UBER","SHOP","PYPL","ASML","AMAT","LRCX","KLAC","SNPS","CDNS","NOW","INTU","CSCO","ORCL"
];

const BULLISH_KEYWORDS = ["beat", "record", "jump", "soar", "surge", "approve", "launch", "partnership", "buyback", "dividend", "upgrade", "growth", "raises", "raise", "strong", "profit", "wins", "contract", "guidance", "earnings"];
const BEARISH_KEYWORDS = ["miss", "fail", "drop", "fall", "plunge", "sue", "lawsuit", "investigation", "downgrade", "cut", "weak", "loss", "ban", "recall", "resign", "delay", "lower", "warning", "sec", "probe"];

type LeaderItem = {
  symbol: string; headline: string; type: string | null; publishedAt: string; url: string | null;
  retPre5: number | null; ret1d: number | null; ret5d: number | null; pricedIn: boolean | null;
  expectedImpact: number; realizedImpact: number; score: number; confidence: number; tooEarly: boolean;
};

// --- YARDIMCI FONKSİYONLAR ---
const clamp = (n: number, a: number, b: number) => Math.max(a, Math.min(b, n));

function pickBatch(universe: string[], cursor: number) {
  const batch: string[] = [];
  for (let i = 0; i < BATCH_SIZE; i++) batch.push(universe[(cursor + i) % universe.length]);
  const nextCursor = (cursor + BATCH_SIZE) % universe.length;
  return { batch, nextCursor };
}

async function fetchWithRetry(url: string, maxRetries = 3) {
  let lastErr: any = null;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const res = await fetch(url, { cache: "no-store" });
      if (res.status === 429) {
        await new Promise((r) => setTimeout(r, 2000));
        continue;
      }
      return res;
    } catch (e) { lastErr = e; }
  }
  throw lastErr;
}

async function fetchSymbolItems(symbol: string): Promise<LeaderItem[]> {
  const now = new Date();
  const toUnix = Math.floor(now.getTime() / 1000);
  const fromUnix = Math.floor(toUnix - CANDLE_LOOKBACK_DAYS * 24 * 3600);
  
  const newsUrl = `https://finnhub.io/api/v1/company-news?symbol=${symbol}&from=${new Date(now.getTime()-7*24*3600*1000).toISOString().slice(0,10)}&to=${now.toISOString().slice(0,10)}&token=${FINNHUB_API_KEY}`;
  
  const newsRes = await fetchWithRetry(newsUrl);
  const news = await newsRes.json();
  if (!Array.isArray(news)) return [];

  const items: LeaderItem[] = [];
  for (const n of news.slice(0, PER_SYMBOL)) {
    const text = n.headline.toLowerCase();
    let s = 0;
    for (const w of BULLISH_KEYWORDS) if (text.includes(w)) s += 15;
    for (const w of BEARISH_KEYWORDS) if (text.includes(w)) s -= 15;

    const expImpact = clamp(65 + s, 50, 95);
    items.push({
      symbol, headline: n.headline, type: n.category || "General",
      publishedAt: new Date(n.datetime*1000).toISOString(),
      url: n.url, retPre5: null, ret1d: null, ret5d: null, pricedIn: false,
      expectedImpact: expImpact, realizedImpact: expImpact,
      score: expImpact, confidence: 30, tooEarly: true
    });
  }
  return items;
}

function assertCronAuth(req: Request) {
  const secret = process.env.CRON_SECRET;
  const { searchParams } = new URL(req.url);
  const authHeader = req.headers.get("authorization");
  return searchParams.get("secret") === secret || authHeader === `Bearer ${secret}`;
}

// --- ANA GET FONKSİYONU ---
export async function GET(req: Request) {
  if (!assertCronAuth(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const universe = (await kv.get("symbols:universe")) as string[] || DEFAULT_UNIVERSE;
    const cursor = (await kv.get("symbols:cursor") as number) || 0;

    const { batch, nextCursor } = pickBatch(universe, cursor);
    const newItems: LeaderItem[] = [];

    for (const sym of batch) {
      try {
        const items = await fetchSymbolItems(sym);
        newItems.push(...items);
      } catch (e) { console.error(`${sym} fetch error`, e); }
    }

    const poolRaw = await kv.get("pool:v1") as { items: LeaderItem[] } | null;
    const oldItems = poolRaw?.items || [];
    const merged = [...newItems, ...oldItems].slice(0, MAX_POOL_ITEMS);
    
    await kv.set("pool:v1", { asOf: new Date().toISOString(), items: merged });
    await kv.set("symbols:cursor", nextCursor);

    return NextResponse.json({ ok: true, scanned: batch, added: newItems.length });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
