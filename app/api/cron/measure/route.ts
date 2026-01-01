import { NextResponse } from "next/server";
import { kv } from "@vercel/kv";

export const runtime = "nodejs";
export const maxDuration = 60;

const FINNHUB_API_KEY = process.env.FINNHUB_API_KEY;
const CRON_SECRET = process.env.CRON_SECRET;

// =========================
// CONFIG (Top-haber ölçümü)
// =========================
const MEASURE_MIN_SCORE = 75;        // sadece yüksek skorlar ölçülsün
const MEASURE_MAX_ITEMS = 25;        // her çalışmada en fazla 25 haber ölç
const MIN_AGE_HOURS = 20;            // ölçüm için haber en az ~20 saat yaşlı olsun
const CANDLE_LOOKBACK_DAYS = 120;    // candle aralığı

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

  // opsiyonel alanlar (KV içinde tutabiliriz)
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

async function fetchCandles(symbol: string, fromUnix: number, toUnix: number) {
  if (!FINNHUB_API_KEY) return null;

  const url =
    `https://finnhub.io/api/v1/stock/candle?symbol=${encodeURIComponent(symbol)}` +
    `&resolution=D&from=${fromUnix}&to=${toUnix}&token=${FINNHUB_API_KEY}`;

  const res = await fetchWithRetry(url);
  if (!res.ok) {
    if (res.status === 429) throw new Error("429");
    return null;
  }

  const data = await res.json();
  if (data?.s !== "ok" || !Array.isArray(data.t) || !Array.isArray(data.c)) return null;

  return { t: data.t as number[], c: data.c as number[] };
}

// last index where times[idx] <= target
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

function calcRealizedImpact(ret1d: number | null, ret5d: number | null) {
  const rUsed = (ret5d ?? ret1d);
  if (typeof rUsed !== "number") return null;
  const base = clamp(Math.round(Math.abs(rUsed) * 1000), 0, 50); // %5 ≈ 50
  return clamp(50 + base, 50, 100);
}

function calcConfidence(ret1d: number | null, ret5d: number | null) {
  let c = 30;
  if (ret1d !== null) c = 70;
  if (ret5d !== null) c = 90;
  return clamp(c, 0, 100);
}

function rebuildLeaderboard(items: LeaderItem[]) {
  // tek sembol = en iyi skor
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
    return NextResponse.json(
      {
        error: "Unauthorized",
        debug: {
          hasEnvSecret: !!CRON_SECRET,
          envSecretLen: (CRON_SECRET || "").length,
          hasFinnhubKey: !!FINNHUB_API_KEY,
          hasKvEnv: !!process.env.KV_REST_API_URL && !!process.env.KV_REST_API_TOKEN
        }
      },
      { status: 401 }
    );
  }

  try {
    if (!process.env.KV_REST_API_URL || !process.env.KV_REST_API_TOKEN) {
      return NextResponse.json(
        { error: "Vercel KV env missing. Connect KV to project and redeploy." },
        { status: 500 }
      );
    }

    const pool = (await kv.get("pool:v1")) as PoolPayload | null;
    const allItems = Array.isArray(pool?.items) ? pool!.items : [];

    if (!allItems.length) {
      return NextResponse.json({ ok: true, measured: 0, note: "pool empty" }, { status: 200 });
    }

    const nowMs = Date.now();

    // ölçülecek adaylar: tooEarly=true, score yüksek, yeterince yaşlı, daha önce ölçülmemiş
    const candidates = allItems
      .filter((x) => x?.tooEarly === true)
      .filter((x) => (x.score ?? 0) >= MEASURE_MIN_SCORE)
      .filter((x) => {
        const t = new Date(x.publishedAt).getTime();
        if (!Number.isFinite(t)) return false;
        const ageHours = (nowMs - t) / (1000 * 60 * 60);
        return ageHours >= MIN_AGE_HOURS;
      })
      .filter((x) => !x.measuredAt) // sadece 1 kez ölç
      .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
      .slice(0, MEASURE_MAX_ITEMS);

    if (!candidates.length) {
      return NextResponse.json({ ok: true, measured: 0, note: "no eligible items" }, { status: 200 });
    }

    // symbol -> candle cache (bu run için)
    const candleCache = new Map<string, { t: number[]; c: number[] } | null>();

    const toUnix = Math.floor(Date.now() / 1000);
    const fromUnix = Math.floor(toUnix - CANDLE_LOOKBACK_DAYS * 24 * 3600);

    // hızlı lookup için index: (symbol|publishedAt|headlineLower)
    const keyOf = (it: LeaderItem) =>
      `${it.symbol}|${it.publishedAt}|${(it.headline || "").trim().toLowerCase()}`;

    const index = new Map<string, number>();
    for (let i = 0; i < allItems.length; i++) index.set(keyOf(allItems[i]), i);

    let measuredCount = 0;

    for (const it of candidates) {
      const k = keyOf(it);
      const idxInAll = index.get(k);
      if (idxInAll === undefined) continue;

      const sym = it.symbol;

      let candles = candleCache.get(sym);
      if (candles === undefined) {
        candles = await fetchCandles(sym, fromUnix, toUnix);
        candleCache.set(sym, candles);
      }
      if (!candles?.t?.length || !candles?.c?.length) continue;

      const newsUnix = Math.floor(new Date(it.publishedAt).getTime() / 1000);
      const idx = findLastLE(candles.t, newsUnix);
      if (idx === -1) continue;

      const base = candles.c[idx];

      const ret1d = (idx + 1 < candles.c.length) ? (candles.c[idx + 1] - base) / base : null;
      const ret5d = (idx + 5 < candles.c.length) ? (candles.c[idx + 5] - base) / base : null;

      const realizedImpact = calcRealizedImpact(ret1d, ret5d);
      if (realizedImpact === null) continue;

      const confidence = calcConfidence(ret1d, ret5d);

      // skor: realized ağırlıklı + expected
      const expected = allItems[idxInAll].expectedImpact ?? it.expectedImpact ?? 65;
      const combined = clamp(Math.round(realizedImpact * 0.7 + expected * 0.3), 50, 100);

      const updated: LeaderItem = {
        ...allItems[idxInAll],
        ret1d,
        ret5d,
        realizedImpact,
        confidence,
        score: combined,
        tooEarly: false,
        measuredAt: new Date().toISOString()
      };

      allItems[idxInAll] = updated;
      measuredCount++;
    }

    // KV yaz
    const poolPayload: PoolPayload = { asOf: new Date().toISOString(), items: allItems };
    await kv.set("pool:v1", poolPayload);

    // leaderboard güncelle
    const leaderboard = rebuildLeaderboard(allItems);
    await kv.set("leaderboard:v1", { asOf: new Date().toISOString(), items: leaderboard });

    return NextResponse.json(
      {
        ok: true,
        measured: measuredCount,
        candidates: candidates.length,
        uniqueSymbolsFetched: candleCache.size
      },
      { status: 200 }
    );
  } catch (e: any) {
    if (String(e?.message || "").includes("429")) {
      return NextResponse.json({ error: "Finnhub rate limit (429). Try later." }, { status: 429 });
    }
    return NextResponse.json({ error: e?.message || "Unknown error" }, { status: 500 });
  }
}
