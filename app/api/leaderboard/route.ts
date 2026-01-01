import { NextResponse } from "next/server";
import { kv } from "@vercel/kv";

export const runtime = "edge"; // Okuma işlemi için çok hızlıdır

export async function GET() {
  try {
    // Cron'un yazdığı pool:v1 verisini direkt oku
    const data = await kv.get("pool:v1");
    
    if (!data) {
      return NextResponse.json({ asOf: new Date().toISOString(), items: [] });
    }

    return NextResponse.json(data);
  } catch (e: any) {
    return NextResponse.json({ error: "Veri okunamadı" }, { status: 500 });
  }
}
