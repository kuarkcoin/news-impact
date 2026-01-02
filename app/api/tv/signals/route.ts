import { NextResponse } from "next/server";
import { kv } from "@vercel/kv";

export const runtime = "edge";

export async function GET() {
  const items = ((await kv.get("tv:signals:v1")) as any[]) || [];
  return NextResponse.json({ asOf: new Date().toISOString(), items });
}