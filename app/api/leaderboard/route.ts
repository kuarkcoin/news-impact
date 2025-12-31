import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const maxDuration = 60;

// Hisseler
const SYMBOLS = ["AAPL", "NVDA", "TSLA", "MSFT", "AMD", "AMZN", "META", "GOOGL"];
const FINNHUB_API_KEY = process.env.FINNHUB_API_KEY;

// --- DEMO VERİ (Acil Durum Çekici) ---
// Eğer API limitine takılırsan veya haber bulamazsan bu devreye girer.
const DEMO_ITEMS = [
  {
    symbol: "DEMO-AAPL",
    headline: "Apple Unveils New AI Strategy (Fallback Data)",
    type: "Technology",
    publishedAt: new Date().toISOString(),
    url: "#",
    retPre5: 0.02,
    ret1d: 0.03,
    ret5d: 0.05,
    pricedIn: false,
    score: 85, 
    expectedImpact: 85,
    realizedImpact: 85,
    confidence: 80,
    tooEarly: false
  },
  {
    symbol: "DEMO-NVDA",
    headline: "Chip Demand Skyrockets in Q4 (Fallback Data)",
    type: "Earnings",
    publishedAt: new Date().toISOString(),
    url: "#",
    retPre5: -0.01,
    ret1d: 0.06,
    ret5d: 0.12,
    pricedIn: false,
    score: 92,
    expectedImpact: 92,
    realizedImpact: 92,
    confidence: 90,
    tooEarly: false
  }
];

// --- MATEMATİK & TİPLER ---

const clamp = (n: number, a: number, b: number) => Math.max(a, Math.min(b, n));

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
};

function scoreFromReturns(ret5d: number | null, ret1d: number | null, retPre5: number | null) {
  // Eğer hiç veri yoksa (haber bugün çıktıysa ve piyasa kapalıysa)
  if (ret1d === null && ret5d === null) {
    return {
      expectedImpact: 50, realizedImpact: 50, pricedIn: null, confidence: 0, tooEarly: true, score: 50
    };
  }

  // Veri varsa kullan (5D yoksa 1D kullan)
  const rUsed = ret5d ?? ret1d ?? 0;
  
  const realizedBase = clamp(Math.round(Math.abs(rUsed) * 1000), 0, 50);
  const realizedImpact = clamp(50 + realizedBase, 50, 100);

  let pricedIn: boolean | null = null;
  if (typeof retPre5 === "number" && Math.abs(rUsed) > 0.005) {
    pricedIn = Math.abs(retPre5) > Math.abs(rUsed) * 0.9;
  }

  let pen = 0;
  if (pricedIn === true && typeof retPre5 === "number") {
    pen = clamp(Math.round((Math.abs(retPre5) - Math.abs(rUsed)) * 1200), 0, 25);
  }

  const expectedImpact = clamp(50 + realizedBase - pen, 50, 100);

  let conf = 20; // Başlangıç güveni
  if (ret1d !== null) conf += 20;
  if (ret5d !== null) conf += 40; // 5 günlük veri varsa güven artar
  if (typeof retPre5 === "number") conf += 10;
  
  return {
    expectedImpact,
    realizedImpact,
    pricedIn,
    confidence: clamp(conf, 0, 100),
    tooEarly: false,
    score: expectedImpact
  };
}

// --- VERİ ÇEKME ---

async function fetchCandles(symbol: string, fromUnix: number, toUnix: number) {
  try {
    const url = `https://finnhub.io/api/v1/stock/candle?symbol=${encodeURIComponent(
      symbol
    )}&resolution=D&from=${fromUnix}&to=${toUnix}&token=${FINNHUB_API_KEY}`;
    
    // Cache süresini uzattık (3 saat), API limitini korumak için
    const res = await fetch(url, { next: { revalidate: 10800 } }); 
    if (!res.ok) return null;
    const data = await res.json();
    if (data?.s !== "ok" || !Array.isArray(data?.t) || !Array.isArray(data?.c)) return null;
    return { t: data.t as number[], c: data.c as number[] };
  } catch { return null; }
}

async function fetchSymbolItems(symbol: string): Promise<LeaderItem[]> {
  if (!FINNHUB_API_KEY) return [];

  const now = new Date();
  // BUGÜNE KADAR olan haberleri al (Filtreyi gevşettik)
  const toDate = now; 
  // 30 gün geriye git
  const fromDate = new Date(now.getTime() - 30 * 24 * 3600 * 1000);

  const toUnix = Math.floor(now.getTime() / 1000);
  const fromUnix = Math.floor(toUnix - 120 * 24 * 3600);

  try {
    // 1) News
    const newsRes = await fetch(
      `https://finnhub.io/api/v1/company-news?symbol=${symbol}&from=${fromDate.toISOString().slice(0,10)}&to=${toDate.toISOString().slice(0,10)}&token=${FINNHUB_API_KEY}`,
      { next: { revalidate: 300 } } // 5dk cache
    );
    if (!newsRes.ok) return [];
    const news = await newsRes.json();
    if (!Array.isArray(news) || news.length === 0) return [];

    // 2) Candles
    const candles = await fetchCandles(symbol, fromUnix, toUnix);
    if (!candles) return []; // Candle yoksa hesaplayamayız

    const items: LeaderItem[] = [];
    const seen = new Set<string>();

    // En yeni 3 haberi al
    for (const n of news.slice(0, 3)) {
      if (!n.headline || !n.datetime) continue;
      
      const key = `${symbol}-${n.datetime}`;
      if (seen.has(key)) continue;
      seen.add(key);

      const idx = candles.t.findIndex((t: number) => t >= n.datetime);
      if (idx === -1) continue;

      const base = candles.c[idx];
      // Güvenli erişim
      const ret1d = (idx + 1 < candles.c.length) ? (candles.c[idx + 1] - base) / base : null;
      const ret5d = (idx + 5 < candles.c.length) ? (candles.c[idx + 5] - base) / base : null;
      const retPre5 = (idx - 5 >= 0) ? (base - candles.c[idx - 5]) / candles.c[idx - 5] : null;

      const scores = scoreFromReturns(ret5d, ret1d, retPre5);

      items.push({
        symbol,
        headline: n.headline,
        type: n.category,
        publishedAt: new Date(n.datetime * 1000).toISOString(),
        url: n.url,
        retPre5, ret1d, ret5d,
        ...scores
      });
    }
    return items;
  } catch (e) {
    console.error(e);
    return [];
  }
}

export async function GET(req: Request) {
  try {
    // API KEY YOKSA DİREKT DEMO DÖN
    if (!FINNHUB_API_KEY) {
      return NextResponse.json({ asOf: new Date().toISOString(), items: DEMO_ITEMS });
    }

    const { searchParams } = new URL(req.url);
    const min = Number(searchParams.get("min") ?? 0); // Varsayılan filtreyi 0 yaptık ki her şeyi görelim

    // Paralel Çekim
    const all = await Promise.all(SYMBOLS.map(s => fetchSymbolItems(s)));
    const flat = all.flat();

    // EĞER API BOŞ DÖNERSE DEMO VERİ GÖSTER (Kurtarıcı)
    if (flat.length === 0) {
      console.log("API boş döndü, Demo veri gösteriliyor.");
      return NextResponse.json({
        asOf: new Date().toISOString(),
        items: DEMO_ITEMS
      });
    }

    // Sırala ve Filtrele
    const items = flat
      .filter(x => x.score >= min)
      .sort((a, b) => b.score - a.score);

    return NextResponse.json({
      asOf: new Date().toISOString(),
      items
    });

  } catch (e) {
    // HATA DURUMUNDA DA DEMO GÖSTER
    return NextResponse.json({ asOf: new Date().toISOString(), items: DEMO_ITEMS });
  }
}
