import { NextResponse } from "next/server";

export const runtime = "nodejs";

type SeedTicker = { symbol: string };
type SeedNewsEvent = {
  symbol: string;
  headline: string;
  url: string;
  type: "Earnings" | "Analyst" | "Product";
  publishedAt: string; // ISO
  hash: string;
};
type SeedNewsScore = {
  symbol: string;
  hash: string; // newsEvent hash
  retPre5: number;
  ret1d: number;
  ret5d: number;
  pricedIn: boolean;
  score: number; // 50..100
  calculatedAt: string; // ISO
};

const clamp = (n: number, a: number, b: number) => Math.max(a, Math.min(b, n));

export async function POST(req: Request) {
  try {
    const secret = req.headers.get("x-seed-secret");
    if (!process.env.SEED_SECRET || secret !== process.env.SEED_SECRET) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const now = new Date();

    const tickers: SeedTicker[] = [
      { symbol: "AAPL" },
      { symbol: "MSFT" },
      { symbol: "NVDA" },
      { symbol: "AMZN" },
      { symbol: "META" },
      { symbol: "GOOGL" },
      { symbol: "TSLA" },
    ];

    const events: SeedNewsEvent[] = [];
    const scores: SeedNewsScore[] = [];

    for (let i = 0; i < 12; i++) {
      const t = tickers[i % tickers.length];
      const publishedAt = new Date(now.getTime() - (i * 6 + 2) * 3600 * 1000);

      const hash = `seed-${t.symbol}-${publishedAt.toISOString()}`;

      const type: SeedNewsEvent["type"] =
        i % 3 === 0 ? "Earnings" : i % 3 === 1 ? "Analyst" : "Product";

      const ev: SeedNewsEvent = {
        symbol: t.symbol,
        headline: `${t.symbol} — Sample news event #${i + 1}`,
        url: `https://example.com/${t.symbol}/${i + 1}`,
        type,
        publishedAt: publishedAt.toISOString(),
        hash,
      };
      events.push(ev);

      // returns (fake)
      const ret1d = Math.random() * 0.06 - 0.01; // -1%..+5%
      const ret5d = Math.random() * 0.12 - 0.02; // -2%..+10%
      const retPre5 = Math.random() * 0.10 - 0.03; // -3%..+7%

      const pricedIn = Math.abs(retPre5) > Math.abs(ret5d) * 0.9;

      // score 50..100 (benzer mantık)
      const base = clamp(Math.round(Math.abs(ret5d) * 1000), 0, 50); // 0..50
      const pen = pricedIn
        ? clamp(Math.round((Math.abs(retPre5) - Math.abs(ret5d)) * 1200), 0, 25)
        : 0;

      const score = clamp(50 + base - pen, 50, 100);

      scores.push({
        symbol: t.symbol,
        hash,
        retPre5,
        ret1d,
        ret5d,
        pricedIn,
        score,
        calculatedAt: new Date().toISOString(),
      });
    }

    return NextResponse.json(
      {
        ok: true,
        created: 12,
        tickers,
        events,
        scores,
        note: "Prisma disabled: seed data returned in response only (not persisted).",
        asOf: new Date().toISOString(),
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

// İstersen GET ile hızlı kontrol
export async function GET() {
  return NextResponse.json(
    {
      ok: true,
      message: "Seed endpoint is up (Prisma disabled). Use POST with x-seed-secret.",
      asOf: new Date().toISOString(),
    },
    { status: 200 }
  );
}