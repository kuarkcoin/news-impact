// app/api/leaderboard/route.ts
import { NextResponse } from "next/server";
import { kv } from "@vercel/kv";

export const runtime = "edge";

type Dir = -1 | 0 | 1;

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

  expectedDir?: Dir;
  realizedDir?: Dir;
  rsi14?: number | null;
  breakout20?: boolean | null;
  bullTrap?: boolean | null;
  volumeSpike?: boolean | null;

  aiSummary?: string | null;
  aiBullets?: string[] | null;
  aiSentiment?: "bullish" | "bearish" | "mixed" | "neutral" | null;

  // ✅ UI için eklenecek
  signals?: string[];
  signalsText?: string;
};

function clamp(n: number, a: number, b: number) {
  return Math.max(a, Math.min(b, n));
}

function safeInt(v: string | null, fallback: number) {
  const n = parseInt(v ?? "", 10);
  return Number.isFinite(n) ? n : fallback;
}

function fmtPct(x: number | null | undefined) {
  if (typeof x !== "number") return "—";
  const v = x * 100;
  const sign = v > 0 ? "+" : "";
  return `${sign}${v.toFixed(1)}%`;
}

function buildSignals(it: LeaderItem): string[] {
  const sig: string[] = [];

  // Direction
  if (it.expectedDir === 1) sig.push("E▲ Bull");
  else if (it.expectedDir === -1) sig.push("E▼ Bear");
  else if (it.expectedDir === 0) sig.push("E■ Flat");

  if (it.realizedDir === 1) sig.push("R▲ Bull");
  else if (it.realizedDir === -1) sig.push("R▼ Bear");
  else if (it.realizedDir === 0) sig.push("R■ Flat");

  // Confidence / Too early
  if (it.tooEarly) sig.push("⚠️ Too early");
  if (typeof it.confidence === "number") sig.push(`Conf ${it.confidence}%`);

  // Technicals
  if (typeof it.rsi14 === "number") {
    if (it.rsi14 >= 70) sig.push(`RSI ${it.rsi14.toFixed(0)} OB`);
    else if (it.rsi14 <= 30) sig.push(`RSI ${it.rsi14.toFixed(0)} OS`);
    else sig.push(`RSI ${it.rsi14.toFixed(0)}`);
  }
  if (it.breakout20 === true) sig.push("🚪 20D breakout");
  if (it.volumeSpike === true) sig.push("📊 Vol spike");
  if (it.bullTrap === true) sig.push("🪤 Bull trap");

  // Priced-in & returns
  if (it.pricedIn === true) sig.push("🧾 Priced-in");
  if (typeof it.ret1d === "number") sig.push(`+1D ${fmtPct(it.ret1d)}`);
  if (typeof it.ret5d === "number") sig.push(`+5D ${fmtPct(it.ret5d)}`);

  // Fallback: technicalContext
  if (it.technicalContext) sig.push(it.technicalContext);

  // temizle
  const cleaned = sig
    .map((s) => (s || "").trim())
    .filter((s) => s && s !== "—");

  return cleaned.length ? cleaned : ["—"];
}

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);

  const min = clamp(safeInt(searchParams.get("min"), 50), 0, 100);
  const limit = clamp(safeInt(searchParams.get("limit"), 50), 1, 200);

  const sort = (searchParams.get("sort") || "score") as "score" | "newest" | "confidence";
  const q = (searchParams.get("q") || "").trim().toLowerCase();
  const debug = searchParams.get("debug") === "1";

  try {
    const data = (await kv.get("pool:v1")) as { asOf?: string; items?: LeaderItem[] } | null;

    if (!data?.items || !Array.isArray(data.items) || data.items.length === 0) {
      return NextResponse.json(
        { asOf: data?.asOf ?? new Date().toISOString(), items: [] },
        { status: 200 }
      );
    }

    let items: LeaderItem[] = data.items;

    // Search filter
    if (q) {
      items = items.filter((it) => {
        const blob = [
          it.symbol,
          it.headline,
          it.type || "",
          it.technicalContext || "",
          it.aiSummary || "",
          Array.isArray(it.aiBullets) ? it.aiBullets.join(" ") : "",
          it.aiSentiment || "",
        ]
          .join(" ")
          .toLowerCase();

        return blob.includes(q);
      });
    }

    // min score
    items = items.filter((x) => (x?.score ?? 0) >= min);

    // sort
    items = [...items].sort((a, b) => {
      if (sort === "newest") return new Date(b.publishedAt).getTime() - new Date(a.publishedAt).getTime();
      if (sort === "confidence") return (b.confidence ?? 0) - (a.confidence ?? 0);
      return (b.score ?? 0) - (a.score ?? 0);
    });

    // limit
    items = items.slice(0, limit);

    // ✅ GUARANTEE: signals + signalsText
    items = items.map((it) => {
      const sigArr = Array.isArray(it.signals) && it.signals.length ? it.signals : buildSignals(it);
      return {
        ...it,
        signals: sigArr,
        signalsText: sigArr.filter((x) => x && x !== "—").join(" · ") || "—",
      };
    });

    return NextResponse.json(
      { asOf: data.asOf ?? new Date().toISOString(), items },
      { status: 200 }
    );
  } catch (e: any) {
    if (debug) {
      return NextResponse.json(
        { error: "KV read failed", detail: String(e?.message || e) },
        { status: 500 }
      );
    }
    return NextResponse.json(
      { asOf: new Date().toISOString(), items: [] },
      { status: 200 }
    );
  }
}