import { NextResponse } from "next/server";
import { kv } from "@vercel/kv";

export const runtime = "nodejs";
export const maxDuration = 30;

type LeaderItem = {
  symbol: string;
  headline: string;
  type: string | null;
  publishedAt: string;
  url: string | null;

  retPre5: number | null;
  ret1d: number | null;
  ret5d: number | null;

  pricedIn: boolean | null;
  expectedImpact: number;
  realizedImpact: number;
  score: number;
  confidence: number;
  tooEarly: boolean;
};

type Payload = { asOf: string; items: LeaderItem[] };

const clamp = (n: number, a: number, b: number) => Math.max(a, Math.min(b, n));

export async function GET(req: Request) {
  try {
    if (!process.env.KV_REST_API_URL || !process.env.KV_REST_API_TOKEN) {
      return NextResponse.json(
        { error: "Vercel KV env missing. Connect KV to project and redeploy.", items: [] },
        { status: 500 }
      );
    }

    const { searchParams } = new URL(req.url);
    const min = clamp(parseInt(searchParams.get("min") || "50", 10), 0, 100);
    const limit = clamp(parseInt(searchParams.get("limit") || "50", 10), 1, 200);

    const data = (await kv.get("leaderboard:v1")) as Payload | null;

    const items = (data?.items || [])
      .filter((x) => (x.score ?? 0) >= min)
      .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
      .slice(0, limit);

    return NextResponse.json({ asOf: data?.asOf || new Date().toISOString(), items }, { status: 200 });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || "Veri okunamadı", items: [] }, { status: 500 });
  }
}
