// app/api/leaderboard/route.ts
import { NextResponse } from "next/server";
import { PrismaClient } from "@prisma/client";

const globalForPrisma = global as unknown as { prisma: PrismaClient };
const prisma = globalForPrisma.prisma || new PrismaClient();
if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = prisma;

export const runtime = "nodejs";
// Veritabanından okuduğumuz için cache'i tamamen kapatmayalım ama kısa tutalım (örn: 30sn)
export const revalidate = 30; 

export async function GET(req: Request) {
  try {
    const { searchParams } = new URL(req.url);
    const limit = Number(searchParams.get("limit") ?? 30);
    const minScore = Number(searchParams.get("min") ?? 50);

    // Veritabanından veriyi çek
    // Score tablosuyla ilişkilendirerek (include: score)
    const dbItems = await prisma.newsEvent.findMany({
      where: {
        score: {
          score: { gte: minScore } // Min puana göre filtrele
        }
      },
      take: limit,
      orderBy: {
        score: { score: 'desc' } // En yüksek puana göre sırala
      },
      include: {
        score: true // İlişkili puan detaylarını da getir
      }
    });

    // Frontend'in beklediği formata dönüştür (Mapping)
    const items = dbItems.map((item) => ({
      symbol: item.tickerSymbol,
      headline: item.headline,
      type: item.type,
      publishedAt: item.publishedAt.toISOString(),
      url: item.url,
      
      // İlişkili tablodan verileri al
      score: item.score?.score ?? 50,
      pricedIn: item.score?.pricedIn ?? false,
      ret1d: item.score?.ret1d ?? null,
      ret5d: item.score?.ret5d ?? null,
      retPre5: item.score?.retPre5 ?? null,
    }));

    return NextResponse.json({
      asOf: new Date().toISOString(),
      items
    }, { status: 200 });

  } catch (e: any) {
    return NextResponse.json(
      { error: e?.message || "Database error" },
      { status: 500 }
    );
  }
}
