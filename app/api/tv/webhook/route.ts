import { NextResponse } from "next/server";
import { kv } from "@vercel/kv";

export const runtime = "nodejs";
export const maxDuration = 60;

type TvPayload = {
  secret?: string;
  symbol?: string;
  action?: "BUY" | "SELL" | "AL" | "SAT";
  message?: string;
  timeframe?: string;
  score?: number;
  price?: number;
  ts?: number; // unix seconds
  barTime?: number; // unix ms or seconds
  raw?: any;
};

function bad(msg: string, code = 400) {
  return NextResponse.json({ ok: false, error: msg }, { status: code });
}

function normalizeAction(a?: string) {
  const x = (a || "").toUpperCase().trim();
  if (x === "AL") return "BUY";
  if (x === "SAT") return "SELL";
  if (x === "BUY" || x === "SELL") return x;
  return "INFO";
}

export async function POST(req: Request) {
  const secret = process.env.TV_WEBHOOK_SECRET;
  if (!secret) return bad("Missing TV_WEBHOOK_SECRET", 500);

  let bodyText = "";
  let data: TvPayload = {};

  try {
    bodyText = await req.text();
    // TradingView bazen JSON gönderir, bazen düz metin.
    try {
      data = JSON.parse(bodyText);
    } catch {
      // düz metin ise minimal parse
      data = { message: bodyText };
    }
  } catch {
    return bad("Invalid body", 400);
  }

  // Secret doğrulama (JSON içinden veya header’dan)
  const headerSecret = req.headers.get("x-tv-secret") || "";
  const payloadSecret = (data.secret || "").trim();

  if (headerSecret !== secret && payloadSecret !== secret) {
    return bad("Unauthorized", 401);
  }

  const symbol = (data.symbol || "").toUpperCase().trim();
  if (!symbol) return bad("Missing symbol", 400);

  const action = normalizeAction(data.action);
  const timeframe = (data.timeframe || "").toUpperCase().trim() || null;

  const nowIso = new Date().toISOString();
  const item = {
    id: `tv_${Date.now()}_${Math.random().toString(16).slice(2)}`,
    source: "tradingview",
    symbol,
    action,                 // BUY / SELL / INFO
    timeframe,              // e.g. 1H, 4H, 1D
    score: typeof data.score === "number" ? data.score : null,
    price: typeof data.price === "number" ? data.price : null,
    message: (data.message || "").slice(0, 400),
    createdAt: nowIso,
    raw: data.raw ?? null,
  };

  // Son sinyali tut (ticker sayfası için)
  await kv.set(`tv:last:${symbol}`, item, { ex: 7 * 24 * 3600 });

  // Global liste (anasayfa için)
  const listKey = "tv:signals:v1";
  const existing = (await kv.get(listKey)) as any[] | null;
  const arr = Array.isArray(existing) ? existing : [];
  const merged = [item, ...arr].slice(0, 200); // son 200 sinyal
  await kv.set(listKey, merged, { ex: 7 * 24 * 3600 });

  return NextResponse.json({ ok: true, saved: true, item });
}