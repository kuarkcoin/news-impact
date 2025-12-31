import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';

export const runtime = 'nodejs';

export async function POST(req: Request) {
  try {
    const secret = req.headers.get('x-seed-secret');
    if (!process.env.SEED_SECRET || secret !== process.env.SEED_SECRET) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const now = new Date();

    const tickers = [
      { symbol: 'AAPL' },
      { symbol: 'MSFT' },
      { symbol: 'NVDA' },
      { symbol: 'AMZN' },
      { symbol: 'META' },
      { symbol: 'GOOGL' },
      { symbol: 'TSLA' },
    ];

    for (const t of tickers) {
      await prisma.ticker.upsert({
        where: { symbol: t.symbol },
        update: {},
        create: { symbol: t.symbol },
      });
    }

    const all = await prisma.ticker.findMany({ select: { id: true, symbol: true } });

    // create 12 fake news events + scores
    for (let i = 0; i < 12; i++) {
      const t = all[i % all.length];
      const publishedAt = new Date(now.getTime() - (i * 6 + 2) * 3600 * 1000);

      const hash = `seed-${t.symbol}-${publishedAt.toISOString()}`;

      const ev = await prisma.newsEvent.upsert({
        where: { hash },
        update: {},
        create: {
          tickerId: t.id,
          headline: `${t.symbol} — Sample news event #${i + 1}`,
          url: `https://example.com/${t.symbol}/${i + 1}`,
          type: i % 3 === 0 ? 'Earnings' : i % 3 === 1 ? 'Analyst' : 'Product',
          publishedAt,
          hash,
        },
      });

      const ret1d = (Math.random() * 0.06 - 0.01); // -1%..+5%
      const ret5d = (Math.random() * 0.12 - 0.02); // -2%..+10%
      const retPre5 = (Math.random() * 0.10 - 0.03); // -3%..+7%

      const pricedIn = Math.abs(retPre5) > Math.abs(ret5d) * 0.9;

      // simple score in 50..100
      const base = Math.min(50, Math.round(Math.abs(ret5d) * 1000)); // 0..50
      const pen = pricedIn ? Math.min(25, Math.round((Math.abs(retPre5) - Math.abs(ret5d)) * 1200)) : 0;
      const score = Math.max(50, Math.min(100, 50 + base - Math.max(0, pen)));

      await prisma.newsScore.upsert({
        where: { tickerId_newsEventId: { tickerId: t.id, newsEventId: ev.id } },
        update: {
          retPre5,
          ret1d,
          ret5d,
          pricedIn,
          score,
          calculatedAt: new Date(),
        },
        create: {
          tickerId: t.id,
          newsEventId: ev.id,
          retPre5,
          ret1d,
          ret5d,
          pricedIn,
          score,
        },
      });
    }

    return NextResponse.json({ ok: true, created: 12 });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || 'Unknown error' }, { status: 500 });
  }
}
