import { NextResponse } from "next/server";

export const runtime = "nodejs";

const clampInt = (n: number, a: number, b: number) => Math.max(a, Math.min(b, n));
const clamp = (n: number, a: number, b: number) => Math.max(a, Math.min(b, n));

type Item = {
  symbol: string;
  headline: string;
  type: string | null;
  publishedAt: string; // ISO
  score: number;       // 50..100
  pricedIn: boolean | null;
  retPre5: number | null;
  ret1d: number | null;
  ret5d: number | null;
  url: string | null;
};

const NDX = [
  "AAPL","MSFT","NVDA","AMZN","META","GOOGL","GOOG","AVGO","TSLA","COST",
  "ADBE","PEP","CSCO","NFLX","AMD","INTC","QCOM","TXN","AMGN","HON",
  "INTU","CMCSA","SBUX","BKNG","ISRG","MU","PYPL","AMAT","MDLZ","ADI",
  "LRCX","GILD","VRTX","REGN","PANW","SNPS","CDNS","KLAC","PDD","ABNB",
  "MRNA","CRWD","MELI","ORLY","MAR","NXPI","CTAS","WDAY","AEP","KDP"
];

function dayStartUtc(date: Date) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}
function toUnixSec(d: Date) {
  return Math.floor(d.getTime() / 1000);
}

async function mapLimit<T, R>(
  arr: T[],
  limit: number,
  fn: (x: T, i: number) => Promise<R>
): Promise<R[]> {
  const out: R[] = new Array(arr.length) as any;
  let i = 0;
  const workers = new Array(Math.min(limit, arr.length)).fill(0).map(async () => {
    while (true) {
      const idx = i++;
      if (idx >= arr.length) return;
      out[idx] = await fn(arr[idx], idx);
    }
  });
  await Promise.all(workers);
  return out;
}

function scoreFromRet(ret5d: number | null, pricedIn: boolean | null, retPre5: number | null) {
  if (typeof ret5d !== "number") return 50;
  const base = clamp(Math.round(Math.abs(ret5d) * 1000), 0, 50);
  let pen = 0;
  if (pricedIn && typeof retPre5 === "number") {
    pen = clamp(Math.round(Math.max(0, Math.abs(retPre5) - Math.abs(ret5d)) * 1200), 0, 25);
  }
  return clamp(50 + base - pen, 50, 100);
}

export async function GET(req: Request) {
  try {
    const key = process.env.FINNHUB_API_KEY;
    if (!key) return NextResponse.json({ error: "Missing FINNHUB_API_KEY" }, { status: 500 });

    const { searchParams } = new URL(req.url);
    const min = clampInt(Number(searchParams.get("min") ?? 50) || 50, 0, 100);
    const max = clampInt(Number(searchParams.get("max") ?? 100) || 100, 0, 100);
    const limit = clampInt(Number(searchParams.get("limit") ?? 30) || 30, 1, 200);

    const now = new Date();
    // ✅ Daha geniş pencere: 7 gün haber, 200 gün mum (tatiller/haftasonu güvenli)
    const fromNews = new Date(now.getTime() - 7 * 24 * 3600 * 1000);
    const fromPrice = new Date(now.getTime() - 200 * 24 * 3600 * 1000);

    const maxTickers = clampInt(Number(process.env.MAX_TICKERS ?? 30) || 30, 5, NDX.length);
    const concurrency = clampInt(Number(process.env.SCAN_CONCURRENCY ?? 6) || 6, 1, 12);

    const symbols = NDX.slice(0, maxTickers);

    const perSymbol = await mapLimit(symbols, concurrency, async (symbol) => {
      // 1) news
      const newsUrl =
        `https://finnhub.io/api/v1/company-news?symbol=${encodeURIComponent(symbol)}` +
        `&from=${fromNews.toISOString().slice(0, 10)}&to=${now.toISOString().slice(0, 10)}&token=${key}`;

      const nRes = await fetch(newsUrl, { cache: "no-store" });
      if (!nRes.ok) return null;

      const news = (await nRes.json().catch(() => null)) as any[] | null;
      if (!Array.isArray(news) || news.length === 0) return null;

      // ✅ tek haber yerine: ilk 3 habere bak, çalışır olanı seç
      const candidates = news.slice(0, 3);

      // 2) candles (1 kez çek)
      const from = toUnixSec(fromPrice);
      const to = toUnixSec(now);

      const cUrl =
        `https://finnhub.io/api/v1/stock/candle?symbol=${encodeURIComponent(symbol)}` +
        `&resolution=D&from=${from}&to=${to}&token=${key}`;

      const cRes = await fetch(cUrl, { cache: "no-store" });
      const candles = await cRes.json().catch(() => null) as any;

      const tArr: number[] = Array.isArray(candles?.t) ? candles.t : [];
      const cArr: number[] = Array.isArray(candles?.c) ? candles.c : [];

      // ✅ Mum yoksa bile haber item’ı döndür (ret’ler null)
      const hasCandles = candles?.s === "ok" && tArr.length >= 2 && cArr.length >= 2;

      for (const n of candidates) {
        const headline = String(n?.headline || "").trim();
        const publishedSec = Number(n?.datetime || 0);
        if (!headline || !publishedSec) continue;

        let ret1d: number | null = null;
        let ret5d: number | null = null;
        let retPre5: number | null = null;
        let pricedIn: boolean | null = null;

        if (hasCandles) {
          const newsDay = dayStartUtc(new Date(publishedSec * 1000));
          const newsDaySec = Math.floor(newsDay.getTime() / 1000);

          // first t >= newsDaySec
          let lo = 0, hi = tArr.length - 1, idx = -1;
          while (lo <= hi) {
            const mid = (lo + hi) >> 1;
            if (tArr[mid] >= newsDaySec) { idx = mid; hi = mid - 1; }
            else lo = mid + 1;
          }

          if (idx >= 0 && idx < cArr.length) {
            const base = cArr[idx];
            if (base) {
              const i1 = Math.min(idx + 1, cArr.length - 1);
              const i5 = Math.min(idx + 5, cArr.length - 1);
              ret1d = (i1 !== idx) ? (cArr[i1] / base - 1) : null;
              ret5d = (i5 !== idx) ? (cArr[i5] / base - 1) : null;

              if (idx - 5 >= 0) retPre5 = base / cArr[idx - 5] - 1;

              if (typeof retPre5 === "number" && typeof ret5d === "number") {
                pricedIn = Math.abs(retPre5) > Math.abs(ret5d) * 0.9;
              }
            }
          }
        }

        const score = scoreFromRet(ret5d, pricedIn, retPre5);

        const item: Item = {
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
        };

        return item;
      }

      return null;
    });

    const items = (perSymbol.filter(Boolean) as Item[])
      .filter((x) => x.score >= min && x.score <= max)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);

    return NextResponse.json(
      {
        asOf: new Date().toISOString(),
        range: { min, max },
        scanned: symbols.length,
        returned: items.length,
        items,
      },
      { status: 200 }
    );
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || "Unknown error" }, { status: 500 });
  }
}