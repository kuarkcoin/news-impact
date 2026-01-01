import { NextResponse } from "next/server";
import { kv } from "@vercel/kv";

export const runtime = "nodejs";
export const maxDuration = 60;

const FINNHUB_API_KEY = process.env.FINNHUB_API_KEY;
const CRON_SECRET = process.env.CRON_SECRET;

const BATCH_SIZE = 15;
const PER_SYMBOL = 1;
const MAX_POOL_ITEMS = 800;
const MAX_NEWS_AGE_DAYS = 10;

const DEFAULT_UNIVERSE: string[] = [
  "AAPL","MSFT","NVDA","AMZN","META","GOOGL","GOOG","TSLA","AMD","AVGO","INTC","QCOM","TXN","MU","NFLX","ADBE",
  "CRM","PLTR","COIN","MSTR","UBER","SHOP","PYPL","ASML","AMAT","LRCX","KLAC","SNPS","CDNS","NOW","INTU","CSCO",
  "ORCL","IBM","DELL","HPQ","PANW","CRWD","ZS","OKTA","NET","DDOG","MDB","SMCI","ARM","TSM","ADI","NXPI",
  "MRVL","ON","GFS","ANET","JPM","BAC","WFC","GS","MS","BLK","V","MA","COST","WMT","HD","LOW","MCD","SBUX",
  "NKE","DIS","CMCSA","T","VZ","TMUS","ABNB","BKNG","UNH","LLY","AMGN","TMO","DHR","MRK","ABBV","AVGO","TSM",
  "PFE","CVX","XOM","COP","NEE","PG","KO","PEP","ADP","TEAM","SNOW","DOCU","ZM","TWLO","ROKU","SPOT","EA","TTWO",
  "FDX","UPS","WM","RSG","CAT","BA","GE","HON","LMT","RTX","NOC","CSX","UNP","NSC","OXY","EOG","MPC","VLO"
].slice(0, 200);

const BULLISH_KEYWORDS = [
  "beat","record","jump","soar","surge","approve","launch","partnership","buyback","dividend","upgrade","growth",
  "raises","raise","strong","profit","wins","contract","guidance","earnings","revenue","margin","outperform"
];
const BEARISH_KEYWORDS = [
  "miss","fail","drop","fall","plunge","sue","lawsuit","investigation","downgrade","cut","weak","loss","ban",
  "recall","resign","delay","lower","warning","sec","probe","fraud","decline","underperform"
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

  measuredAt?: string | null;
};

type PoolPayload = { asOf: string; items: LeaderItem[] };

const clamp = (n: number, a: number, b: number) => Math.max(a, Math.min(b, n));

function assertCronAuth(req: Request) {
  if (!CRON_SECRET) return false;

  const { searchParams } = new URL(req.url);
  const qs = searchParams.get("secret");
  if (qs && qs === CRON_SECRET) return true;

  const authHeader = req.headers.get("authorization");
  if (authHeader === `Bearer ${CRON_SECRET}`) return true;

  return false;
}

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
        await new Promise((r) => setTimeout(r, attempt === 0 ? 900 : 1700));
        lastErr = new Error("429");
        continue;
      }

      if (res.status >= 500 && res.status <= 599) {
        await new Promise((r) => setTimeout(r, attempt === 0 ? 700 : 1400));
        lastErr = new Error(`HTTP_${res.status}`);
        continue;
      }

      return res;
    } catch (e) {
      lastErr = e;
      await new Promise((r) => setTimeout(r, attempt === 0 ? 700 : 1400));
    }
  }

  throw lastErr ?? new Error("fetch failed");
}

function scoreFromHeadline(headline: string) {
  const text = headline.toLowerCase();
  let s = 0;
  for (const w of BULLISH_KEYWORDS) if (text.includes(w)) s += 15;
  for (const w of BEARISH_KEYWORDS) if (text.includes(w)) s -= 15;

  const expectedImpact = clamp(65 + s, 50, 95);
  return { expectedImpact, realizedImpact: expectedImpact, score: expectedImpact };
}

async function fetchSymbolItems(symbol: string): Promise<LeaderItem[]> {
  if (!FINNHUB_API_KEY) return [];

  const now = new Date();
  const from = new Date(now.getTime() - 7 * 24 * 3600 * 1000).toISOString().slice(0, 10);
  const to = now.toISOString().slice(0, 10);

  const newsUrl =
    `https://finnhub.io/api/v1/company-news?symbol=${encodeURIComponent(symbol)}` +
    `&from=${from}&to=${to}&token=${FINNHUB_API_KEY}`;

  const newsRes = await fetchWithRetry(newsUrl);
  if (!newsRes.ok) {
    if (newsRes.status === 429) throw new Error("429");
    return [];
  }

  const news = await newsRes.json();
  if (!Array.isArray(news) || news.length === 0) return [];

  const items: LeaderItem[] = [];

  for (const n of news) {
    if (!n?.headline || !n?.datetime) continue;

    const ageDays = (Date.now() - Number(n.datetime) * 1000) / (1000 * 60 * 60 * 24);
    if (ageDays > MAX_NEWS_AGE_DAYS) continue;

    const { expectedImpact, realizedImpact, score } = scoreFromHeadline(String(n.headline));

    items.push({
      symbol,
      headline: String(n.headline),
      type: n.category ?? null,
      publishedAt: new Date(Number(n.datetime) * 1000).toISOString(),
      url: n.url ?? null,

      retPre5: null,
      ret1d: null,
      ret5d: null,

      pricedIn: false,
      expectedImpact,
      realizedImpact,
      score,
      confidence: 30,
      tooEarly: true,
      measuredAt: null
    });

    if (items.length >= PER_SYMBOL) break;
  }

  return items;
}

function rebuildLeaderboard(items: LeaderItem[]) {
  const bestBySymbol = new Map<string, LeaderItem>();
  for (const it of items) {
    const prev = bestBySymbol.get(it.symbol);
    if (!prev || (it.score ?? 0) > (prev.score ?? 0)) bestBySymbol.set(it.symbol, it);
  }

  return Array.from(bestBySymbol.values())
    .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
    .slice(0, 120);
}

export async function GET(req: Request) {
  if (!assertCronAuth(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    if (!process.env.KV_REST_API_URL || !process.env.KV_REST_API_TOKEN) {
      return NextResponse.json(
        { error: "Vercel KV env missing. Connect KV to project and redeploy." },
        { status: 500 }
      );
    }

    const universe = ((await kv.get("symbols:universe")) as string[] | null) ?? DEFAULT_UNIVERSE;
    const cursor = ((await kv.get("symbols:cursor")) as number | null) ?? 0;

    const { batch, nextCursor } = pickBatch(universe, cursor);

    // yeni haberler
    const newItems: LeaderItem[] = [];
    for (const sym of batch) {
      const arr = await fetchSymbolItems(sym);
      newItems.push(...arr);
    }

    // mevcut pool
    const poolRaw = (await kv.get("pool:v1")) as PoolPayload | null;
    const oldItems = Array.isArray(poolRaw?.items) ? poolRaw!.items : [];

    // dedupe: aynı symbol+headline+publishedAt
    const seen = new Set<string>();
    const merged: LeaderItem[] = [];

    const keyOf = (it: LeaderItem) =>
      `${it.symbol}|${it.publishedAt}|${(it.headline || "").trim().toLowerCase()}`;

    for (const it of [...newItems, ...oldItems]) {
      const k = keyOf(it);
      if (seen.has(k)) continue;
      seen.add(k);
      merged.push(it);
      if (merged.length >= MAX_POOL_ITEMS) break;
    }

    const poolPayload: PoolPayload = { asOf: new Date().toISOString(), items: merged };
    await kv.set("pool:v1", poolPayload);

    const leaderboard = rebuildLeaderboard(merged);
    await kv.set("leaderboard:v1", { asOf: new Date().toISOString(), items: leaderboard });

    await kv.set("symbols:cursor", nextCursor);

    return NextResponse.json(
      { ok: true, scanned: batch, added: newItems.length, nextCursor, universeSize: universe.length },
      { status: 200 }
    );
  } catch (e: any) {
    if (String(e?.message || "").includes("429")) {
      return NextResponse.json({ error: "Finnhub rate limit (429). Try later." }, { status: 429 });
    }
    return NextResponse.json({ error: e?.message || "Unknown error" }, { status: 500 });
  }
}
