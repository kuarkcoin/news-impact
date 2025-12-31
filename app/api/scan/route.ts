import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';

export const runtime = 'nodejs';

export async function POST(req: Request) {
  try {
    const secret = req.headers.get('x-scan-secret');
    if (secret !== process.env.SCAN_SECRET) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const FINN = process.env.FINNHUB_API_KEY!;
    const POLY = process.env.POLYGON_API_KEY!;

    const tickers = await prisma.ticker.findMany();

    let created = 0;
    const now = new Date();
    const fromNews = new Date(now.getTime() - 7 * 24 * 3600 * 1000);
    const fromPrice = new Date(now.getTime() - 40 * 24 * 3600 * 1000);

    for (const t of tickers) {
      // 1️⃣ Finnhub news
      const newsRes = await fetch(
        `https://finnhub.io/api/v1/company-news?symbol=${t.symbol}&from=${fromNews.toISOString().slice(0,10)}&to=${now.toISOString().slice(0,10)}&token=${FINN}`
      );
      const news = await newsRes.json();

      if (!Array.isArray(news)) continue;

      // 2️⃣ Polygon prices
      const priceRes = await fetch(
        `https://api.polygon.io/v2/aggs/ticker/${t.symbol}/range/1/day/${fromPrice.toISOString().slice(0,10)}/${now.toISOString().slice(0,10)}?adjusted=true&apiKey=${POLY}`
      );
      const prices = (await priceRes.json())?.results || [];
      if (prices.length < 10) continue;

      const closes = prices.map((x:any) => x.c);

      for (const n of news.slice(0, 10)) {
        const hash = `${t.symbol}-${n.datetime}-${n.headline}`;
        const exists = await prisma.newsEvent.findUnique({ where: { hash } });
        if (exists) continue;

        const ev = await prisma.newsEvent.create({
          data: {
            tickerId: t.id,
            headline: n.headline,
            url: n.url,
            type: n.category,
            publishedAt: new Date(n.datetime * 1000),
            hash,
          },
        });

        const ret1d = closes[1] / closes[0] - 1;
        const ret5d = closes[5] / closes[0] - 1;
        const retPre5 = closes[0] / closes[5] - 1;

        const pricedIn = Math.abs(retPre5) > Math.abs(ret5d) * 0.9;
        const score = Math.max(
          50,
          Math.min(100, Math.round(50 + Math.abs(ret5d) * 1000))
        );

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
  } catch (e:any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
