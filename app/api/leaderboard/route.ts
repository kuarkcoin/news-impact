import { NextResponse } from "next/server";
import { kv } from "@vercel/kv";

export const runtime = "edge";

function clamp(n: number, a: number, b: number) {
  return Math.max(a, Math.min(b, n));
}

export async function GET(req: Request) {
  try {
    const { searchParams } = new URL(req.url);
    const min = clamp(parseInt(searchParams.get("min") || "50", 10) || 50, 30, 100);
    const limit = clamp(parseInt(searchParams.get("limit") || "50", 10) || 50, 10, 200);

    const data = (await kv.get("pool:v1")) as any;

    if (!data?.items) {
      return NextResponse.json({ asOf: new Date().toISOString(), items: [] }, { status: 200 });
    }

    const items = Array.isArray(data.items) ? data.items : [];

    const filtered = items
      .filter((x: any) => (x?.score ?? 0) >= min)
      .sort((a: any, b: any) => (b?.score ?? 0) - (a?.score ?? 0))
      .slice(0, limit);

    return NextResponse.json({ asOf: data.asOf ?? new Date().toISOString(), items: filtered }, { status: 200 });
  } catch (e: any) {
    return NextResponse.json({ error: "Veri okunamadı" }, { status: 500 });
  }
}