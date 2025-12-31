import { NextResponse } from "next/server";

export const runtime = "nodejs";

/* =========================
   CONFIG
========================= */

// Nasdaq-100'ün tamamını sonra DB'den alacağız.
// Şimdilik 30-40 ticker yeter: hem hızlı hem rate-limit dostu.
// İstersen listeyi büyütürüz.
const NASDAQ100_SAMPLE: string[] = [
  "AAPL","MSFT","NVDA","AMZN","META","GOOGL","GOOG","TSLA","AVGO","COST",
  "ADBE","PEP","CSCO","AMD","NFLX","INTC","AMGN","QCOM","TXN","INTU",
  "BKNG","SBUX","ISRG","MU","GILD","MDLZ","ADI","PANW","VRTX","REGN",
  "LRCX","KLAC","SNPS","CDNS","ABNB","MELI","ASML","ORLY","PYPL","MAR"
];

const CONCURRENCY = 4; // Aynı anda kaç ticker çağıracağız (rate limit için küçük tut)
const DEFAULT_DAYS_BACK = 7; // haberleri kaç gün geri tarayalım
const DEFAULT_PER_SYMBOL = 3; // her ticker için kaç haber
const CANDLE_BUFFER_DAYS = 50; // candle için kaç gün geri (1D ve 5D yetmesi için)

/* =========================
   HELPERS
========================= */

const clamp = (n: number, a: number, b: number) => Math.max(a, Math.min(b, n));
const clampInt = (n: number, a: number, b: number) => clamp(Math.round(n), a, b);

function dayStartUtc(date: Date) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

function toUnixSec(d: Date) {
  return Math.floor(d.getTime() / 1000);
}

function scoreFromRet(
  ret5d: number | null,
  ret1d: number | null,
  pricedIn: boolean | null,
  retPre5: number | null
) {
  // Öncelik: 5D varsa onu kullan, yoksa 1D
  const r = typeof ret5d === "number" ? ret5d : (typeof ret1d === "number" ? ret1d : null);
  if (typeof r !== "number") return 50;

  // 1D küçük hareket -> multiplier biraz daha yüksek
  const mult = typeof ret5d === "number" ? 1000 : 1600;
  const base = clamp(Math.round(Math.abs(r) * mult), 0, 50);

  let pen = 0;
  if (pricedIn && typeof retPre5 === "number") {
    const ref = typeof ret5d === "number" ? ret5d : (typeof ret1d === "number" ? ret1d : 0);
    pen = clamp(
      Math.round(Math.max(0, Math.abs(retPre5) - Math.abs(ref)) * 1200),
      0,
      25
    );
  }

  return clamp(50 + base - pen, 50, 100);
}

async function mapLimit<T, R>(
  items: T[],
  limit: number,
  worker: (item: T, idx: number) => Promise<R>
): Promise<R[]> {
  const results: R[] = new Array(items.length) as any;
  let i = 0;

  const runners = new Array(limit).fill(0).map(async () => {
    while (i < items.length) {
      const idx = i++;
      results[idx] = await worker(items[idx], idx);
    }
  });

  await Promise.all(runners);
  return results;
}

type Item = {
  symbol: string;
  headline: string;
  type: string | null;
  publishedAt: string; // ISO
  score: number; // 50..100
  pricedIn: boolean | null;
  retPre5: number | null;
  ret1d: number | null;
  ret5d: number | null;
  url: string | null;
};

/* =========================
   ROUTE
========================= */

export async function GET(req: Request) {
  try {
    const key = process.env.FINNHUB_API_KEY;
    if (!key) {
      return NextResponse.json({ error: "Missing FINNHUB_API_KEY" }, { status: 500 });
    }

    const { searchParams } = new URL(req.url);

    const min = clampInt(Number(searchParams.get("min") ?? 50) || 50, 0, 100);
    const max = clampInt(Number(searchParams.get("max") ?? 100) || 100, 0, 100);
    const limit = clampInt(Number(searchParams.get("limit") ?? 30) || 30, 1, 500);

    const daysBack = clampInt(Number(searchParams.get("days") ?? DEFAULT_DAYS_BACK) || DEFAULT_DAYS_BACK, 1, 30);
    const perSymbol = clampInt(Number(searchParams.get("perSymbol") ?? DEFAULT_PER_SYMBOL) || DEFAULT_PER_SYMBOL, 1, 10);

    // Universe (istersen query ile daraltırsın)
    const symbols = NASDAQ100_SAMPLE;

    const now = new Date();
    const fromNews = new Date(now.getTime() - daysBack * 24 * 3600 * 1000);
    const fromCandle = new Date(now.getTime() - CANDLE_BUFFER_DAYS * 24 * 3600 * 1000);

    const fromC = toUnixSec(fromCandle);
    const toC = toUnixSec(now);

    const perSymbolResults = await mapLimit(symbols, CONCURRENCY, async (symbol) => {
      // 1) Haberler
      const newsUrl =
        `https://finnhub.io/api/v1/company-news?symbol=${encodeURIComponent(symbol)}` +
        `&from=${fromNews.toISOString().slice(0, 10)}&to=${now.toISOString().slice(0, 10)}&token=${key}`;

      const newsRes = await fetch(newsUrl, { cache: "no-store" });
      if (!newsRes.ok) return null;
      const news = (await newsRes.json()) as any[];
      if (!Array.isArray(news) || news.length === 0) return null;

      // 2) Candle (Daily)
      const candlesUrl =
        `https://finnhub.io/api/v1/stock/candle?symbol=${encodeURIComponent(symbol)}` +
        `&resolution=D&from=${fromC}&to=${toC}&token=${key}`;

      const cRes = await fetch(candlesUrl, { cache: "no-store" });
      if (!cRes.ok) return null;
      const candles = await cRes.json();

      if (candles?.s !== "ok" || !Array.isArray(candles?.t) || !Array.isArray(candles?.c)) {
        return null;
      }

      const tArr: number[] = candles.t; // unix seconds (day start UTC)
      const cArr: number[] = candles.c;

      if (tArr.length < 8 || cArr.length < 8) return null;

      // Haber zamanını candle index'e eşle: "haber günü veya sonraki ilk işlem günü"
      const findIndexForNewsTime = (newsTimeSec: number) => {
        const d = dayStartUtc(new Date(newsTimeSec * 1000));
        const daySec = Math.floor(d.getTime() / 1000);

        // first candle with t >= daySec
        let lo = 0, hi = tArr.length - 1, ans = -1;
        while (lo <= hi) {
          const mid = (lo + hi) >> 1;
          if (tArr[mid] >= daySec) {
            ans = mid;
            hi = mid - 1;
          } else lo = mid + 1;
        }
        return ans;
      };

      // Haberleri seç: çok tekrar edenleri azalt (aynı headline)
      const used = new Set<string>();
      const picked: any[] = [];
      for (const n of news) {
        const headline = String(n?.headline || "").trim();
        if (!headline) continue;
        const hkey = headline.toLowerCase();
        if (used.has(hkey)) continue;
        used.add(hkey);
        picked.push(n);
        if (picked.length >= perSymbol) break;
      }

      if (picked.length === 0) return null;

      const out: Item[] = [];

      for (const n of picked) {
        const headline = String(n?.headline || "").trim();
        const publishedSec = Number(n?.datetime || 0);
        if (!headline || !publishedSec) continue;

        const idx = findIndexForNewsTime(publishedSec);
        if (idx < 0) continue;

        const base = typeof cArr[idx] === "number" ? cArr[idx] : null;

        // +1D, +5D
        const ret1d =
          base && idx + 1 < cArr.length && typeof cArr[idx + 1] === "number"
            ? cArr[idx + 1] / base - 1
            : null;

        const ret5d =
          base && idx + 5 < cArr.length && typeof cArr[idx + 5] === "number"
            ? cArr[idx + 5] / base - 1
            : null;

        // Pre5: haber gününden önceki 5. işlem günü (varsa)
        const preBase =
          idx - 5 >= 0 && typeof cArr[idx - 5] === "number" ? cArr[idx - 5] : null;

        const retPre5 =
          base && preBase ? base / preBase - 1 : null;

        const pricedIn =
          typeof retPre5 === "number" && typeof ret5d === "number"
            ? Math.abs(retPre5) > Math.abs(ret5d) * 0.9
            : (typeof retPre5 === "number" && typeof ret1d === "number"
              ? Math.abs(retPre5) > Math.abs(ret1d) * 0.9
              : null);

        const score = scoreFromRet(ret5d, ret1d, pricedIn, retPre5);

        out.push({
          symbol,
          headline,
          type: n?.category ? String(n.category) : null,
          publishedAt: new Date(publishedSec * 1000).toISOString(),
          score,
          pricedIn,
          retPre5,
          ret1d,
          ret5d,
          url: n?.url ? String(n.url) : null,
        });
      }

      return out.length ? out : null;
    });

    // Flatten
    const flat = (perSymbolResults.filter(Boolean) as any[]).flat().filter(Boolean) as Item[];

    // Filter + sort + limit
    const items = flat
      .filter((x) => x.score >= min && x.score <= max)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);

    return NextResponse.json(
      {
        asOf: new Date().toISOString(),
        range: { min, max },
        meta: {
          universe: symbols.length,
          daysBack,
          perSymbol,
          concurrency: CONCURRENCY,
          returned: items.length,
        },
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