import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';

export const runtime = 'nodejs';

// ---------- helpers ----------
const clamp = (n: number, a: number, b: number) => Math.max(a, Math.min(b, n));
const toUnix = (d: Date) => Math.floor(d.getTime() / 1000);
const dayStartUTC = (d: Date) =>
  new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));

async function fetchJSON(url: string) {
  const r = await fetch(url, { cache: 'no-store' });
  if (!r.ok) throw new Error(`Fetch failed ${r.status}`);
  return r.json();
}

// ---------- core ----------
export async function POST(req: Request) {
  try {
    // ---- auth (cron/manuel çağrı için)
    const secret = req.headers.get('x-scan-secret');
    if (!process.env.SCAN_SECRET || secret !== process.env.SCAN_SECRET) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const FINN = process.env.FINNHUB_API_KEY;
    const POLY = process.env.POLYGON_API_KEY;
    if (!FINN || !POLY) {
      return NextResponse.json({ error: 'Missing API keys' }, { status: 500 });
    }

    // ---- tickers (Nasdaq-100 sen DB’ye koymuştun)
    const tickers = await prisma.ticker.findMany({ select: { id: true, symbol: true } });
    if (tickers.length === 0) {
      return NextResponse.json({ error: 'No tickers in DB' }, { status: 400 });
    }

    const now = new Date();
    const fromNews = new Date(now.getTime() - 48 * 3600 * 1000); // son 48 saat
    const fromCandles = new Date(now.getTime() - 40 * 24 * 3600 * 1000); // 40 gün buffer

    let created = 0;

    for (const t of tickers) {
      // ---- 1) news (Finnhub)
      const newsUrl =
        `https://finnhub.io/api/v1/company-news?symbol=${t.symbol}` +
        `&from=${fromNews.toISOString().slice(0, 10)}` +
        `&to=${now.toISOString().slice(0, 10)}` +
        `&token=${FINN}`;

      const news = (await fetchJSON(newsUrl)) as any[];

      if (!Array.isArray(news) || news.length === 0) continue;

      // ---- 2) candles (Polygon, daily)
      const polyUrl =
        `https://api.polygon.io/v2/aggs/ticker/${t.symbol}/range/1/day/` +
        `${fromCandles.toISOString().slice(0, 10)}/${now.toISOString().slice(0, 10)}` +
        `?adjusted=true&sort=asc&limit=5000&apiKey=${POLY}`;

      const poly = await fetchJSON(polyUrl);
      const bars: { t: number; c: number }[] = (poly?.results || []).map((x: any) => ({
        t: Math.floor(x.t / 1000),
        c: x.c,
      }));

      if (bars.length < 10) continue;

      // helpers
      const times = bars.map((b) => b.t);
      const closes = bars.map((b) => b.c);

      const findIdxByDay = (sec: number) => {
        const d = dayStartUTC(new Date(sec * 1000));
        const ds = toUnix(d);
        let lo = 0,
          hi = times.length - 1,
          ans = -1;
        while (lo <= hi) {
          const m = (lo + hi) >> 1;
          if (times[m] >= ds) {
            ans = m;
            hi = m - 1;
          } else lo = m + 1;
        }
        return ans;
      };

      for (const n of news.slice(0, 10)) {
        const headline = String(n.headline || '').trim();
        if (!headline) continue;

        const publishedAt = new Date((n.datetime || 0) * 1000);
        const hash = `${t.symbol}-${n.datetime}-${headline.slice(0, 80)}`;

        // ---- dedupe
        const exists = await prisma.newsEvent.findUnique({ where: { hash } });
        if (exists) continue;

        // ---- create NewsEvent
        const ev = await prisma.newsEvent.create({
          data: {
            tickerId: t.id,
            headline,
            url: n.url || null,
            type: n.category || 'General',
            publishedAt,
            hash,
          },
        });

        // ---- returns
        const idx = findIdxByDay(n.datetime || 0);
        if (idx < 0) continue;

        const base = closes[idx];
        const ret1d = idx + 1 < closes.length ? closes[idx + 1] / base - 1 : null;
        const ret5d = idx + 5 < closes.length ? closes[idx + 5] / base - 1 : null;
        const retPre5 = idx - 5 >= 0 ? base / closes[idx - 5] - 1 : null;

        // ---- priced-in
        const pricedIn =
          typeof retPre5 === 'number' &&
          typeof ret5d === 'number' &&
          Math.abs(retPre5) > Math.abs(ret5d) * 0.9;

        // ---- score (50..100)
        const basePts =
          (typeof ret5d === 'number' ? clamp(Math.abs(ret5d) * 1000, 0, 50) : 0) +
          (typeof ret1d === 'number' ? clamp(Math.abs(ret1d) * 600, 0, 25) : 0);

        const penalty =
          pricedIn && typeof retPre5 === 'number' && typeof ret5d === 'number'
            ? clamp((Math.abs(retPre5) - Math.abs(ret5d)) * 1200, 0, 30)
            : 0;

        const score = Math.round(clamp(50 + basePts - penalty, 50, 100));

        // ---- save score
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

        created++;
      }
    }

    return NextResponse.json({ ok: true, created });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || 'Unknown error' }, { status: 500 });
  }
}
