import { NextResponse } from 'next/server';

export const runtime = 'nodejs';

function clampInt(n: number, a: number, b: number) {
  return Math.max(a, Math.min(b, n));
}

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);

  const min = clampInt(Number(searchParams.get('min') ?? 50) || 50, 0, 100);
  const max = clampInt(Number(searchParams.get('max') ?? 100) || 100, 0, 100);
  const limit = clampInt(Number(searchParams.get('limit') ?? 30) || 30, 1, 200);

  return NextResponse.json(
    {
      asOf: new Date().toISOString(),
      range: { min, max },
      items: [], // şimdilik boş
      note: 'Leaderboard temporary disabled (no DB connected)',
    },
    { status: 200 }
  );
}