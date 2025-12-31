import { NextResponse } from "next/server";

export const runtime = "nodejs";

const clampInt = (n: number, a: number, b: number) => Math.max(a, Math.min(b, n));

type Item = {
  symbol: string;
  headline: string;
  type: string;
  publishedAt: string;
  score: number;
  pricedIn: boolean | null;
  retPre5: number | null;
  ret1d: number | null;
  ret5d: number | null;
  url: string | null;
};

const MOCK: Item[] = [
  {
    symbol: "AAPL",
    headline: "Apple announces new AI features for iPhone and Mac",
    type: "Product",
    publishedAt: new Date(Date.now() - 2 * 3600 * 1000).toISOString(),
    score: 92,
    pricedIn: false,
    retPre5: 0.01,
    ret1d: 0.012,
    ret5d: 0.028,
    url: "https://example.com/aapl",
  },
  {
    symbol: "NVDA",
    headline: "NVIDIA beats earnings expectations; guidance raised",
    type: "Earnings",
    publishedAt: new Date(Date.now() - 6 * 3600 * 1000).toISOString(),
    score: 88,
    pricedIn: true,
    retPre5: 0.035,
    ret1d: 0.008,
    ret5d: 0.019,
    url: "https://example.com/nvda",
  },
  {
    symbol: "MSFT",
    headline: "Microsoft expands cloud AI partnership",
    type: "Analyst",
    publishedAt: new Date(Date.now() - 10 * 3600 * 1000).toISOString(),
    score: 81,
    pricedIn: null,
    retPre5: -0.004,
    ret1d: 0.006,
    ret5d: 0.013,
    url: "https://example.com/msft",
  },
];

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);

  const min = clampInt(Number(searchParams.get("min") ?? 50) || 50, 0, 100);
  const max = clampInt(Number(searchParams.get("max") ?? 100) || 100, 0, 100);
  const limit = clampInt(Number(searchParams.get("limit") ?? 30) || 30, 1, 200);

  const items = MOCK
    .filter((x) => x.score >= min && x.score <= max)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);

  return NextResponse.json(
    {
      asOf: new Date().toISOString(),
      range: { min, max },
      items,
    },
    { status: 200 }
  );
}
