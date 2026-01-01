// app/api/leaderboard/route.ts
import { NextResponse } from "next/server";
import { kv } from "@vercel/kv";

export const runtime = "edge";

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

  technicalContext?: string | null;
};

function clamp(n: number, a: number, b: number) {
  return Math.max(a, Math.min(b, n));
}

function safeInt(v: string | null, fallback: number) {
  const n = parseInt(v ?? "", 10);
  return Number.isFinite(n) ? n : fallback;
}

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);

  const min = clamp(safeInt(searchParams.get("min"), 50), 30, 100);
  const limit = clamp(safeInt(searchParams.get("limit"), 50), 10, 200);

  // opsiyonel: sort (UI ile uyumlu)
  const sort = (searchParams.get("sort") || "score") as "score" | "newest" | "confidence";

  // opsiyonel: server-side search
  const q = (searchParams.get("q") || "").trim().toLowerCase();

  // opsiyonel: debug
  const debug = searchParams.get("debug") === "1";

  try {
    const data = (await kv.get("pool:v1")) as { asOf?: string; items?: LeaderItem[] } | null;

    if (!data?.items || !Array.isArray(data.items) || data.items.length === 0) {
      return NextResponse.json(
        { asOf: data?.asOf ?? new Date().toISOString(), items: [] },
        { status: 200 }
      );
    }

    let items = data.items;

    // q filtresi (istersen frontend’e bırak, ama destekli)
    if (q) {
      items = items.filter((it) => {
        const blob = `${it.symbol} ${it.headline} ${it.type || ""}`.toLowerCase();
        return blob.includes(q);
      });
    }

    // min filtresi
    items = items.filter((x) => (x?.score ?? 0) >= min);

    // sort
    items = [...items].sort((a, b) => {
      if (sort === "newest") {
        return new Date(b.publishedAt).getTime() - new Date(a.publishedAt).getTime();
      }
      if (sort === "confidence") {
        return (b.confidence ?? 0) - (a.confidence ?? 0);
      }
      return (b.score ?? 0) - (a.score ?? 0);
    });

    // limit
    items = items.slice(0, limit);

    return NextResponse.json(
      { asOf: data.asOf ?? new Date().toISOString(), items },
      { status: 200 }
    );
  } catch (e: any) {
    // debug=1 ise gerçek hatayı dön (prod’da kapalı)
    if (debug) {
      return NextResponse.json(
        { error: "KV read failed", detail: String(e?.message || e) },
        { status: 500 }
      );
    }
    return NextResponse.json({ asOf: new Date().toISOString(), items: [] }, { status: 200 });
  }
}