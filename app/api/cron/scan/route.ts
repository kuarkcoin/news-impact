import { NextResponse } from "next/server";
import { kv } from "@vercel/kv";

export const runtime = "nodejs";
export const maxDuration = 60;

const FINNHUB_API_KEY = process.env.FINNHUB_API_KEY;
const CRON_SECRET = process.env.CRON_SECRET;

// 200 hisse için güvenli tarama
const BATCH_SIZE = 10;             // her cron’da 10 hisse
const PER_SYMBOL = 2;              // hisse başı 2 haber
const MAX_POOL_ITEMS = 600;        // KV havuzu şişmesin
const MAX_NEWS_AGE_DAYS = 10;      // 10 günden eski haberi alma
const CANDLE_LOOKBACK_DAYS = 140;  // priced-in + 5gün sonrası için

const BULLISH_KEYWORDS = [
  "beat","record","jump","soar","surge","approve","launch","partnership","buyback","dividend",
  "upgrade","growth","raises","raise","strong","profit","wins","contract","guidance","earnings"
];

const BEARISH_KEYWORDS = [
  "miss","fail","drop","fall","plunge","sue","lawsuit","investigation","downgrade","cut","weak",
  "loss","ban","recall","resign","delay","lower","warning","sec","probe"
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

type PoolPayload = { asOf: string; items: LeaderItem[] };

const clamp = (n: number, a: number, b: number) => Math.max(a, Math.min(b, n));

/**
 * İstersen bu listeyi kendi 200 hisselik listenle değiştir.
 * Finnhub’da bulunmayanlar otomatik boş döner (problem değil).
 */
const DEFAULT_UNIVERSE: string[] = [
  "AAPL","MSFT","NVDA","AMZN","META","GOOGL","TSLA","AMD","AVGO","INTC","QCOM","TXN","MU","NFLX","ADBE",
  "CRM","PLTR","COIN","MSTR","UBER","SHOP","PYPL","ASML","AMAT","LRCX","KLAC","SNPS","CDNS","NOW","INTU",
  "CSCO","ORCL","IBM","ACN","ADP","PANW","CRWD","FTNT","ZS","DDOG","MDB","NET","TEAM","SNOW","OKTA","DOCU",
  "SQ","ABNB","BKNG","EXPE","ROKU","SPOT","DIS","WBD","PARA","CMCSA","TMUS","VZ","T","CSX","UNP","DAL",
  "UAL","AAL","LUV","NKE","COST","WMT","TGT","HD","LOW","SBUX","MCD","KO","PEP","PG","JNJ","PFE","MRK",
  "ABBV","BMY","LLY","AMGN","GILD","REGN","ISRG","VRTX","TMO","DHR","ABT","SYK","BSX","UNH","XOM","CVX",
  "COP","SLB","EOG","OXY","JPM","BAC","C","GS","MS","SCHW","BLK","AXP","V","MA","SPGI","ICE","CME","BA",
  "LMT","NOC","RTX","GD","HON","GE","CAT","DE","ETN","PH","ITW","PLD","AMT","EQIX","GOLD","NEM","FCX","NUE",
  "TSM","MRVL","ADI","NXPI","ON","STM","ARM","GFS","SMCI","RIVN","LCID","F","GM","HOOD","SOFI","TWLO","HUBS",
  "WDAY","RBLX","U","EA","TTWO","ENPH","FSLR","NEE","DUK","SO","EXC","AEP","SRE","O","CCI","BABA","JD","PDD",
  "BIDU","NTES","TCEHY","MELI","SE","RIO","BHP","VALE","ALB","AA","X"
].slice(0, 200);

// ----------------- AUTH (Query Secret) -----------------
function assertCronAuth(req: Request) {
  if (!CRON_SECRET) return false;
  const { searchParams } = new URL(req.url);
  const secret = searchParams.get("secret");
  return secret === CRON_SECRET;
}

// ----------------- Fetch helpers -----------------
async function fetchWithRetry(url: string, maxRetries = 3) {
  let lastErr: any = null;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const res = await fetch(url, { cache: "no-store" });

      if (res.status === 429 || (res.status >= 500 && res.status <= 599)) {
        const wait = attempt === 0 ? 500 : attempt === 1 ? 1200 : 2500;
        await new Promise((r) => setTimeout(r, wait));
        lastErr = new Error(String(res.status));
        continue;
      }

      return res;
    } catch (e) {
      lastErr = e;
      const wait = attempt === 0 ? 400 : attempt === 1 ? 900 : 2000;
      await new Promise((r) => setTimeout(r, wait));
    }
  }

  throw lastErr ?? new Error("fetch failed");
}

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

function dedupeKey(it: LeaderItem) {
  return `${it.symbol}|${it.publishedAt}|${(it.headline || "").trim().toLowerCase()}`;
}

function sentimentFromHeadline(headline: string) {
  const text = headline.toLowerCase();
  let s = 0;

  for (const w of BULLISH_KEYWORDS) if (text.includes(w)) s += 18;
  for (const w of BEARISH_KEYWORDS) if (text.includes(w)) s -= 15;

  if (text.includes("but") || text.includes("despite") || text.includes("however")) s = Math.round(s * 0.65);
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
  let score =
    realizedImpact === null ? expectedImpact : Math.round(realizedImpact * 0.7 + expectedImpact * 0.3);
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

async function fetchCandles(symbol: string, fromUnix: number, toUnix: number) {
  const url = `https://finnhub.io/api/v1/stock/candle?symbol=${encodeURIComponent(symbol)}&resolution=D&from=${fromUnix}&to=${toUnix}&token=${FINNHUB_API_KEY}`;
  const res = await fetchWithRetry(url);
  if (!res.ok) return null;
  const data = await res.json();
  if (data?.s !== "ok") return null;
  return { t: data.t as number[], c: data.c as number[] };
}

async function fetchSymbolItems(symbol: string): Promise<LeaderItem[]> {
  const now = new Date();
  const fromDate = new Date(now.getTime() - 30 * 24 * 3600 * 1000);

  const toUnix = Math.floor(now.getTime() / 1000);
  const fromUnix = Math.floor(toUnix - CANDLE_LOOKBACK_DAYS * 24 * 3600);

  const newsUrl =
    `https://finnhub.io/api/v1/company-news?symbol=${encodeURIComponent(symbol)}` +
    `&from=${fromDate.toISOString().slice(0, 10)}&to=${now.toISOString().slice(0, 10)}` +
    `&token=${FINNHUB_API_KEY}`;

  const newsRes = await fetchWithRetry(newsUrl);
  if (!newsRes.ok) {
    if (newsRes.status === 429) throw new Error("429");
    return [];
  }

  const news = await newsRes.json();
  if (!Array.isArray(news) || news.length === 0) return [];

  const candles = await fetchCandles(symbol, fromUnix, toUnix);

  const items: LeaderItem[] = [];
  const seen = new Set<string>();

  for (const n of news) {
    if (!n?.headline || !n?.datetime) continue;

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
    const realized = calcRealizedImpact(ret1d, ret5d);
    const score = combineScore(exp.expectedImpact, realized, exp.pricedIn);
    const confidence = calcConfidence(ret1d, ret5d, exp.pricedIn);
    const tooEarly = realized === null;

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
      realizedImpact: realized ?? exp.expectedImpact,
      score,
      confidence,
      tooEarly,
    });

    if (items.length >= PER_SYMBOL) break;
  }

  return items;
}

async function getUniverse(): Promise<string[]> {
  const u = (await kv.get("symbols:universe")) as string[] | null;
  if (Array.isArray(u) && u.length) return u;
  await kv.set("symbols:universe", DEFAULT_UNIVERSE);
  await kv.set("symbols:cursor", 0);
  return DEFAULT_UNIVERSE;
}

function pickBatch(universe: string[], cursor: number) {
  const batch: string[] = [];
  for (let i = 0; i < BATCH_SIZE; i++) batch.push(universe[(cursor + i) % universe.length]);
  const nextCursor = (cursor + BATCH_SIZE) % universe.length;
  return { batch, nextCursor };
}

export async function GET(req: Request) {
  try {
    if (!FINNHUB_API_KEY) return NextResponse.json({ error: "No FINNHUB_API_KEY" }, { status: 500 });
    if (!CRON_SECRET) return NextResponse.json({ error: "No CRON_SECRET" }, { status: 500 });

    if (!assertCronAuth(req)) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const universe = await getUniverse();
    const cursorRaw = (await kv.get("symbols:cursor")) as number | null;
    const cursor = typeof cursorRaw === "number" ? cursorRaw : 0;

    const { batch, nextCursor } = pickBatch(universe, cursor);

    const poolRaw = (await kv.get("pool:v1")) as PoolPayload | null;
    const poolItems = Array.isArray(poolRaw?.items) ? poolRaw!.items : [];

    const seen = new Set(poolItems.map(dedupeKey));

    const newItems: LeaderItem[] = [];
    for (const sym of batch) {
      const arr = await fetchSymbolItems(sym);
      for (const it of arr) {
        const k = dedupeKey(it);
        if (seen.has(k)) continue;
        seen.add(k);
        newItems.push(it);
      }
    }

    const merged = [...newItems, ...poolItems].slice(0, MAX_POOL_ITEMS);

    await kv.set("pool:v1", { asOf: new Date().toISOString(), items: merged });

    const leaderboard = [...merged].sort((a, b) => (b.score ?? 0) - (a.score ?? 0)).slice(0, 80);
    await kv.set("leaderboard:v1", { asOf: new Date().toISOString(), items: leaderboard });

    await kv.set("symbols:cursor", nextCursor);

    return NextResponse.json(
      { ok: true, scanned: batch, added: newItems.length, nextCursor, totalPool: merged.length },
      { status: 200 }
    );
  } catch (e: any) {
    if (String(e?.message || "").includes("429")) {
      return NextResponse.json({ error: "Finnhub rate limit (429). Try later." }, { status: 429 });
    }
    return NextResponse.json({ error: e?.message || "Unknown error" }, { status: 500 });
  }
}
