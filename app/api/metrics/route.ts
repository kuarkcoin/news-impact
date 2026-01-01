// app/api/metrics/route.ts
import { NextResponse } from "next/server";
import { kv } from "@vercel/kv";

export const runtime = "edge";

type LeaderItem = {
  expectedDir?: -1 | 0 | 1;
  realizedDir?: -1 | 0 | 1;
  tooEarly?: boolean;
  score?: number;
  bullTrap?: boolean | null;
  type?: string | null;
  technicalContext?: string | null;
};

function pct(n: number) {
  return Math.round(n * 10) / 10;
}

function bucket(items: LeaderItem[], label: string) {
  const measured = items.filter((x) => x && x.tooEarly === false);
  const totalMeasured = measured.length;

  if (!totalMeasured) {
    return { label, totalMeasured: 0, directionAccuracy: 0, highScoreHitRate: 0 };
  }

  const correct = measured.filter((x) => (x.expectedDir ?? 0) !== 0 && (x.expectedDir ?? 0) === (x.realizedDir ?? 0)).length;
  const directionAccuracy = pct((correct / totalMeasured) * 100);

  const hi = measured.filter((x) => (x.score ?? 0) >= 80);
  const hiCorrect = hi.filter((x) => (x.expectedDir ?? 0) !== 0 && (x.expectedDir ?? 0) === (x.realizedDir ?? 0)).length;
  const highScoreHitRate = hi.length ? pct((hiCorrect / hi.length) * 100) : 0;

  return { label, totalMeasured, directionAccuracy, highScoreHitRate };
}

export async function GET() {
  const data = (await kv.get("pool:v1")) as { asOf?: string; items?: LeaderItem[] } | null;
  const items = (data?.items || []) as LeaderItem[];

  const measured = items.filter((x) => x && x.tooEarly === false);
  const totalMeasured = measured.length;

  const correct = measured.filter((x) => (x.expectedDir ?? 0) !== 0 && (x.expectedDir ?? 0) === (x.realizedDir ?? 0)).length;
  const directionAccuracy = totalMeasured ? pct((correct / totalMeasured) * 100) : 0;

  // avgAbsError = “puan” bazlı error yerine sade: 0/1 direction error % (daha tutarlı)
  const avgAbsError = totalMeasured ? pct(((totalMeasured - correct) / totalMeasured) * 100) : 0;

  const hi = measured.filter((x) => (x.score ?? 0) >= 80);
  const hiCorrect = hi.filter((x) => (x.expectedDir ?? 0) !== 0 && (x.expectedDir ?? 0) === (x.realizedDir ?? 0)).length;
  const highScoreHitRate = hi.length ? pct((hiCorrect / hi.length) * 100) : 0;

  // ✅ Buckets
  const earnings = items.filter((x) => (x.type || "").toLowerCase().includes("earn"));
  const upgrades = items.filter((x) => (x.type || "").toLowerCase().includes("upgrade"));
  const bullTraps = items.filter((x) => x.bullTrap === true);

  const uptrend = items.filter((x) => (x.technicalContext || "").includes("📈 Uptrend"));
  const downtrend = items.filter((x) => (x.technicalContext || "").includes("📉 Downtrend"));
  const range = items.filter((x) => (x.technicalContext || "").includes("🟨 Range"));

  return NextResponse.json({
    updatedAt: new Date().toISOString(),
    totalMeasured,
    directionAccuracy,
    avgAbsError,
    highScoreHitRate,

    buckets: [
      bucket(earnings, "Earnings"),
      bucket(upgrades, "Upgrades"),
      bucket(bullTraps, "BullTrap flagged"),
      bucket(uptrend, "Uptrend"),
      bucket(downtrend, "Downtrend"),
      bucket(range, "Range"),
    ],
  });
}