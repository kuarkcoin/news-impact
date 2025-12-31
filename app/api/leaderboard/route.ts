import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';

export const runtime = 'nodejs';

function clampInt(n: number, a: number, b: number) {
  return Math.max(a, Math.min(b, n));
}

export async function GET(req: Request) {
  try {
    const { searchParams } = new URL(req.url);

    const min = clampInt(Number(searchParams.get('min') ?? 50) || 50, 0, 100);
    const max = clampInt(Number(searchParams.get('max') ?? 100) || 100, 0, 100);
    const limit = clampInt(Number(searchParams.get('limit') ?? 30) || 30, 1, 200);

    // opsiyonel: son kaç saat içinden
    const hours = clampInt(Number(searchParams.get('hours') ?? 72) || 72, 1, 24 * 30);
    const since = new Date(Date.now() - hours * 3600 * 1000);

    const rows = await prisma.newsScore.findMany({
      where: {
        score: { gte: min, lte: max },
        calculatedAt: { gte: since },
      },
      orderBy: [{ score: 'desc' }, { calculatedAt: 'desc' }],
      take: limit,
      include: {
        ticker: { select: { symbol: true } },
        newsEvent: { select: { headline: true, url: true, publishedAt: true, type: true } },
      },
    });

    const items = rows.map((r) => ({
      symbol: r.ticker.symbol,
      headline: r.newsEvent.headline,
      type: r.newsEvent.type ?? 'General',
      publishedAt: r.newsEvent.publishedAt.toISOString(),
      score: r.score,
      pricedIn: r.pricedIn ?? null,
      retPre5: r.retPre5 ?? null,
      ret1d: r.ret1d ?? null,
      ret5d: r.ret5d ?? null,
      url: r.newsEvent.url ?? null,
    }));

    return NextResponse.json(
      {
        asOf: new Date().toISOString(),
        range: { min, max },
        items,
      },
      { status: 200 }
    );
  } catch (e: any) {
    return NextResponse.json(
      { error: e?.message || 'Unknown error' },
      { status: 500 }
    );
  }
}
