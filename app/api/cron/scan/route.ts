import { NextResponse } from "next/server";
import { kv } from "@vercel/kv";

// ... (Buraya yukarıdaki fetchSymbolItems, fetchCandles vb. tüm yardımcı fonksiyonları koyun) ...

function assertCronAuth(req: Request) {
  const secret = process.env.CRON_SECRET;
  const { searchParams } = new URL(req.url);
  const authHeader = req.headers.get("authorization");
  return searchParams.get("secret") === secret || authHeader === `Bearer ${secret}`;
}

export async function GET(req: Request) {
  if (!assertCronAuth(req)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  try {
    // 1. Evreni ve Cursor'ı al
    const universe = (await kv.get("symbols:universe")) as string[] || DEFAULT_UNIVERSE;
    const cursor = (await kv.get("symbols:cursor") as number) || 0;

    // 2. Batch'i tara
    const { batch, nextCursor } = pickBatch(universe, cursor);
    const newItems = [];
    for (const sym of batch) {
      const items = await fetchSymbolItems(sym);
      newItems.push(...items);
    }

    // 3. Pool'u güncelle
    const poolRaw = await kv.get("pool:v1") as any;
    const merged = [...newItems, ...(poolRaw?.items || [])].slice(0, 600);
    
    await kv.set("pool:v1", { asOf: new Date().toISOString(), items: merged });
    await kv.set("symbols:cursor", nextCursor);

    return NextResponse.json({ ok: true, added: newItems.length });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
