import { NextResponse } from "next/server";
import { kv } from "@vercel/kv";

export const runtime = "edge";

type Metrics = {
  updatedAt: string;

  totalMeasured: number;

  directionCorrect: number;
  directionAccuracy: number; // 0..100

  sumAbsError: number;
  avgAbsError: number;

  highScoreCount: number; // score>=80
  highScoreHits: number;  // realized>=70
  highScoreHitRate: number; // 0..100
};

const emptyMetrics = (): Metrics => ({
  updatedAt: new Date().toISOString(),
  totalMeasured: 0,

  directionCorrect: 0,
  directionAccuracy: 0,

  sumAbsError: 0,
  avgAbsError: 0,

  highScoreCount: 0,
  highScoreHits: 0,
  highScoreHitRate: 0
});

export async function GET() {
  try {
    if (!process.env.KV_REST_API_URL || !process.env.KV_REST_API_TOKEN) {
      return NextResponse.json(
        { error: "Vercel KV env missing. Connect KV to project and redeploy." },
        { status: 500 }
      );
    }

    const m = (await kv.get("metrics:v1")) as Metrics | null;
    return NextResponse.json(m ?? emptyMetrics(), { status: 200 });
  } catch {
    return NextResponse.json({ error: "Metrics okunamadı" }, { status: 500 });
  }
}
