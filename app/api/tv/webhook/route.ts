import { NextResponse } from "next/server";
import { kv } from "@vercel/kv";

export const runtime = "nodejs";
export const maxDuration = 10;

export async function POST(req: Request) {
  try {
    const body = await req.json();

    const secret = body?.secret;
    if (!process.env.TV_WEBHOOK_SECRET || secret !== process.env.TV_WEBHOOK_SECRET) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const item = {
      symbol: String(body?.symbol || "").toUpperCase(),
      exchange: String(body?.exchange || ""),
      time: String(body?.time || ""),
      price: Number(body?.price ?? null),
      signal: String(body?.signal || ""),
      score: body?.score ? Number(body.score) : null,
      tf: String(body?.tf || ""),
      raw: body
    };

    // son sinyaller listesi (max 200)
    const key = "tv:signals:v1";
    const prev = ((await kv.get(key)) as any[]) || [];
    const next = [item, ...prev].slice(0, 200);
    await kv.set(key, next);

    return NextResponse.json({ ok: true });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || "Bad request" }, { status: 400 });
  }
}