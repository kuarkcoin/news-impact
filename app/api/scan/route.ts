import { NextResponse } from "next/server";
import { prisma } from "../../../lib/prisma"; // ✅ alias yerine relative (build garanti)

export const runtime = "nodejs";

function clamp(n: number, a: number, b: number) {
  return Math.max(a, Math.min(b, n));
}

function isoDateUTC(d: Date) {
  return d.toISOString().slice(0, 10);
}

function utcDayStartMs(d: Date) {
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

// Binary search: first index where ts[i] >= target
function lowerBound(ts: number[], target: number) {
  let lo = 0;
  let hi = ts.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (ts[mid] < target) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

export async function POST(req: Request) {
  try {
    const secret = req.headers.get("x-scan-secret");
    if (!process.env.SCAN_SECRET || secret !== process.env.SCAN_SECRET) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const FINN = process.env.FINNHUB_API_KEY;
    const POLY = process.env.POLYGON_API_KEY;

    if (!FINN) return NextResponse.json({ error: "Missing FINNHUB_API_KEY" }, { status: 500 });
    if (!POLY) return NextResponse.json({ error: "Missing POLYGON_API_KEY" }, { status: 500 });

    // Ticker list
    const tickers = await prisma.ticker.findMany({
      select: { id: true, symbol: true },
    });

    let createdOrUpdated = 0;

    const now = new Date();
    const fromNews = new Date(now.getTime() - 7 * 24 * 3600 * 1000);
    const fromPrice = new Date(now.getTime() - 60 * 24 * 3600 * 1000); // buffer daha geniş (tatil/haftasonu)

    for (const t of tickers) {
      const symbol = t.symbol.toUpperCase().trim();
      if (!symbol) continue;

      // 1) Finnhub news
      const newsUrl =
        `https://finnhub.io/api/v1/company-news?symbol=${encodeURIComponent(symbol)}` +
        `&from=${isoDateUTC(fromNews)}&to=${isoDateUTC(now)}&token=${FINN}`;

      const newsRes = await fetch(newsUrl, { cache: "no-store" });
      if (!newsRes.ok) continue;
      const news = (await newsRes.json()) as any[];
      if (!Array.isArray(news) || news.length === 0) continue;

      // 2) Polygon prices (daily aggs)
      const priceUrl =
        `https://api.polygon.io/v2/aggs/ticker/${encodeURIComponent(symbol)}` +
        `/range/1/day/${isoDateUTC(fromPrice)}/${isoDateUTC(now)}?adjusted=true&apiKey=${POLY}`;

      const priceRes = await fetch(priceUrl, { cache: "no-store" });
      if (!priceRes.ok) continue;

      const priceJson = await priceRes.json();
      const prices = Array.isArray(priceJson?.results) ? priceJson.results : [];
      if (prices.length < 15) continue;

      // Polygon: t(ms), c(close)
      const ts: number[] = prices.map((p: any) => Number(p.t)).filter((x) => Number.isFinite(x));
      const closes: number[] = prices.map((p: any) => Number(p.c)).filter((x) => Number.isFinite(x));
      if (ts.length !== closes.length || ts.length < 15) continue;

      // DB: Bu ticker için son 7 gün içinde var olan hash’leri bir seferde çek (N+1’i azaltır)
      const existing = await prisma.newsEvent.findMany({
        where: {
          tickerId: t.id,
          publishedAt: { gte: fromNews },
        },
        select: { hash: true },
      });
      const existingSet = new Set(existing.map((e) => e.hash));

      // Sadece ilk 10 haberi işleyelim (rate-limit / hız)
      const slice = news.slice(0, 10);

      for (const n of slice) {
        const headline = String(n?.headline || "").trim();
        const dtSec = Number(n?.datetime || 0);
        if (!headline || !Number.isFinite(dtSec) || dtSec <= 0) continue;

        const publishedAt = new Date(dtSec * 1000);
        const hash = `${symbol}-${dtSec}-${headline}`; // schema’da unique olmalı

        if (existingSet.has(hash)) continue;

        // Haber gününün UTC day start’ını bul → fiyat serisinde ilk trading day index
        const dayStart = utcDayStartMs(publishedAt);
        const idx0 = lowerBound(ts, dayStart);

        // idx0 haber günü veya sonraki ilk işlem günü olabilir.
        // Ret hesaplamak için idx0-5 ve idx0+5 lazım:
        if (idx0 < 5) continue;
        if (idx0 + 5 >= closes.length) continue;

        const d0 = closes[idx0];
        if (!d0 || !Number.isFinite(d0)) continue;

        const ret1d = closes[idx0 + 1] / d0 - 1;
        const ret5d = closes[idx0 + 5] / d0 - 1;
        const retPre5 = d0 / closes[idx0 - 5] - 1;

        // priced-in: haber öncesi 5 günde hareket, haber sonrası 5 güne çok yakınsa -> fiyatlanmış
        const pricedIn = Math.abs(retPre5) > Math.abs(ret5d) * 0.9;

        // skor: 50–100, temel + priced-in cezası
        const baseScore = clamp(Math.round(50 + Math.abs(ret5d) * 1000), 50, 100);
        const score = pricedIn ? clamp(Math.round(baseScore * 0.65), 50, 100) : baseScore;

        // event + score yaz
        // (schema varsayımı: NewsEvent.hash unique, NewsScore.newsEventId unique)
        const ev = await prisma.newsEvent.create({
          data: {
            tickerId: t.id,
            headline,
            url: n?.url ? String(n.url) : null,
            type: n?.category ? String(n.category) : null,
            publishedAt,
            hash,
          },
        });

        await prisma.newsScore.create({
          data: {
            tickerId: t.id,
            newsEventId: ev.id,
            retPre5,
            ret1d,
            ret5d,
            pricedIn,
            score,
          },
        });

        existingSet.add(hash);
        createdOrUpdated++;
      }
    }

    return NextResponse.json({
      ok: true,
      created: createdOrUpdated,
      scannedTickers: tickers.length,
      asOf: now.toISOString(),
    });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || "Unknown error" }, { status: 500 });
  }
}