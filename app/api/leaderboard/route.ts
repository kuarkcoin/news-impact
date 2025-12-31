import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const maxDuration = 60;

const FINNHUB_API_KEY = process.env.FINNHUB_API_KEY;

// 🔥 HAVUZ: Nasdaq-100'ün en popülerleri
const ALL_SYMBOLS = [
  "AAPL","MSFT","NVDA","AMZN","META","GOOGL","TSLA",
  "AMD","AVGO","INTC","QCOM","TXN","MU","NFLX","ADBE",
  "CRM","PLTR","COIN","MSTR","UBER","SHOP","PYPL","TSM",
  "ASML","LRCX","AMAT","PANW","CRWD","SNOW","DDOG","ZS"
];

const BATCH_SIZE = 15;         // Tek seferde taranacak hisse sayısı
const PER_SYMBOL = 2;          // Her hisseden en yeni 2 haber
const DELAY_MS = 150;          // Biraz daha güvenli delay

// --- GELİŞTİRİLMİŞ KELİME HAVUZU ---
const BULLISH = [
  "beat", "record", "jump", "soar", "surge", "approve", "launch", "partnership", 
  "buyback", "dividend", "upgrade", "growth", "high", "raises", "strong", 
  "acquisition", "merger", "outperform", "bull", "breakout", "rally", "gain",
  "positive", "success", "won", "contract", "deal"
];

const BEARISH = [
  "miss", "fail", "drop", "fall", "plunge", "sue", "lawsuit", "investigation", 
  "downgrade", "cut", "weak", "loss", "ban", "warning", "delay", "halt",
  "bear", "sell", "underperform", "crash", "correction", "risk", "debt", 
  "layoff", "fired", "probe", "reject"
];

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

const clamp = (n: number, a: number, b: number) => Math.max(a, Math.min(b, n));

function shuffle<T>(arr: T[]) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

async function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

function dayKeyFromUnixSec(sec: number) {
  const d = new Date(sec * 1000);
  return d.toISOString().slice(0, 10); // YYYY-MM-DD (Daha hızlı yöntem)
}

function buildDayIndex(tArr: number[]) {
  const map = new Map<string, number>();
  for (let i = 0; i < tArr.length; i++) {
    const k = dayKeyFromUnixSec(tArr[i]);
    if (!map.has(k)) map.set(k, i);
  }
  return map;
}

function pct(x: number | null) {
  return typeof x === "number" ? x : null;
}

// --- 1. REALIZED SCORE (Fiyat Tepkisi Varsa) ---
function realizedFromReturns(ret5d: number | null, ret1d: number | null, retPre5: number | null) {
  const rUsed = ret5d ?? ret1d;
  
  if (rUsed == null) {
    return { realizedImpact: 50, pricedIn: null, tooEarly: true, confidence: 0 };
  }

  const base = clamp(Math.round(Math.abs(rUsed) * 1000), 0, 50);
  let pricedIn: boolean | null = null;

  if (typeof retPre5 === "number" && Math.abs(rUsed) > 0.005) {
    // Haber yönünde önceden hareket olmuşsa (Insider/Rumor)
    pricedIn = Math.abs(retPre5) > Math.abs(rUsed) * 0.9;
  }

  let pen = 0;
  if (pricedIn && typeof retPre5 === "number") {
    pen = clamp(Math.round((Math.abs(retPre5) - Math.abs(rUsed)) * 1200), 0, 25);
  }

  const realizedImpact = clamp(50 + base - pen, 40, 100);

  let conf = 50; // Başlangıç güveni
  if (ret1d != null) conf += 20;
  if (ret5d != null) conf += 30; // 5 günlük veri varsa güven tamdır

  return {
    realizedImpact,
    pricedIn,
    tooEarly: false,
    confidence: clamp(conf, 0, 100),
  };
}

// --- 2. EXPECTED SCORE (Tahmin/NLP) ---
function expectedFromHeadline(headline: string, retPre5: number | null) {
  const text = headline.toLowerCase();

  let senti = 0;
  for (const w of BULLISH) if (text.includes(w)) senti += 6;
  for (const w of BEARISH) if (text.includes(w)) senti -= 6;
  senti = clamp(senti, -20, 20);

  let expected = 55 + senti; 
  let pricedIn = false;

  // PRICED-IN TAHMİNİ (Logic Check)
  if (typeof retPre5 === "number") {
    // İyi haber ama hisse zaten %5 primli -> Satış yiyebilir
    if (senti > 5 && retPre5 > 0.05) { 
      expected -= 20; 
      pricedIn = true; 
    }
    // Kötü haber ama hisse zaten %5 çakılmış -> Tepki alımı gelebilir
    if (senti < -5 && retPre5 < -0.05) { 
      expected += 15; 
      pricedIn = true; 
    }
  }

  // Güven Hesabı (NLP olduğu için max güven 70 civarı olmalı)
  let conf = 30;
  if (Math.abs(senti) >= 12) conf += 20; // Güçlü kelimeler varsa güven artar
  if (typeof retPre5 === "number") conf += 15; // Geçmiş trendi biliyorsak güven artar

  return {
    expectedImpact: clamp(expected, 35, 95),
    pricedInGuess: pricedIn,
    confidenceGuess: clamp(conf, 0, 75),
  };
}

async function fetchCandles(symbol: string, fromUnix: number, toUnix: number) {
  try {
    const url = `https://finnhub.io/api/v1/stock/candle?symbol=${encodeURIComponent(symbol)}&resolution=D&from=${fromUnix}&to=${toUnix}&token=${FINNHUB_API_KEY}`;
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) return null;
    const data = await res.json();
    if (data?.s !== "ok") return null;
    return { t: data.t as number[], c: data.c as number[] };
  } catch { return null; }
}

async function fetchSymbolItems(symbol: string, perSymbol: number): Promise<LeaderItem[]> {
  const now = new Date();
  const fromDate = new Date(now.getTime() - 30 * 24 * 3600 * 1000);
  const toUnix = Math.floor(now.getTime() / 1000);
  const fromUnix = Math.floor(toUnix - 140 * 24 * 3600);

  const items: LeaderItem[] = [];

  const newsRes = await fetch(
    `https://finnhub.io/api/v1/company-news?symbol=${symbol}&from=${fromDate.toISOString().slice(0,10)}&to=${now.toISOString().slice(0,10)}&token=${FINNHUB_API_KEY}`,
    { cache: "no-store" }
  );
  if (!newsRes.ok) return items;
  
  const news = await newsRes.json();
  if (!Array.isArray(news) || news.length === 0) return items;

  const candles = await fetchCandles(symbol, fromUnix, toUnix);
  const dayIdx = candles ? buildDayIndex(candles.t) : null;
  const seen = new Set<string>();

  for (const n of news) {
    if (!n?.headline || !n?.datetime) continue;
    
    const k = `${symbol}|${n.datetime}|${n.headline.trim().slice(0, 20)}`;
    if (seen.has(k)) continue;
    seen.add(k);

    let ret1d: number | null = null;
    let ret5d: number | null = null;
    let retPre5: number | null = null;

    if (candles && dayIdx) {
      const dk = dayKeyFromUnixSec(n.datetime);
      const idx = dayIdx.get(dk);

      if (typeof idx === "number") {
        const base = candles.c[idx];
        if (idx + 1 < candles.c.length) ret1d = (candles.c[idx + 1] - base) / base;
        if (idx + 5 < candles.c.length) ret5d = (candles.c[idx + 5] - base) / base;
        if (idx - 5 >= 0) retPre5 = (base - candles.c[idx - 5]) / candles.c[idx - 5];
      }
    }

    const exp = expectedFromHeadline(n.headline, pct(retPre5));
    const real = realizedFromReturns(pct(ret5d), pct(ret1d), pct(retPre5));

    const tooEarly = real.tooEarly;

    items.push({
      symbol,
      headline: n.headline,
      type: n.category ?? null,
      publishedAt: new Date(n.datetime * 1000).toISOString(),
      url: n.url ?? null,
      retPre5, ret1d, ret5d,
      
      pricedIn: tooEarly ? exp.pricedInGuess : real.pricedIn,
      expectedImpact: exp.expectedImpact,
      realizedImpact: real.realizedImpact,
      score: tooEarly ? exp.expectedImpact : real.realizedImpact,
      confidence: tooEarly ? exp.confidenceGuess : real.confidence,
      tooEarly,
    });

    if (items.length >= perSymbol) break;
  }
  return items;
}

export async function GET(req: Request) {
  try {
    if (!FINNHUB_API_KEY) return NextResponse.json({ error: "Missing API Key", items: [] }, { status: 500 });

    const { searchParams } = new URL(req.url);
    const min = clamp(parseInt(searchParams.get("min") || "30", 10), 0, 100);
    const limit = clamp(parseInt(searchParams.get("limit") || "50", 10), 1, 200);
    const perSymbol = clamp(parseInt(searchParams.get("perSymbol") || String(PER_SYMBOL), 10), 1, 5);

    const symbols = shuffle(ALL_SYMBOLS).slice(0, BATCH_SIZE);
    const all: LeaderItem[] = [];
    const globalSeen = new Set<string>();

    for (const sym of symbols) {
      try { // Hata koruması: Bir hisse patlarsa diğerleri devam etsin
        const items = await fetchSymbolItems(sym, perSymbol);
        for (const it of items) {
          const gk = `${it.symbol}|${it.publishedAt}|${it.headline.trim().toLowerCase()}`;
          if (globalSeen.has(gk)) continue;
          globalSeen.add(gk);
          all.push(it);
        }
      } catch (err) {
        console.error(`Error fetching ${sym}:`, err);
      }
      await sleep(DELAY_MS);
    }

    const filtered = all
      .filter((x) => x.score >= min)
      .sort((a, b) => b.score - a.score) // En yüksek puan en üste
      .slice(0, limit);

    return NextResponse.json({ asOf: new Date().toISOString(), items: filtered }, { status: 200 });
  } catch (e: any) {
    return NextResponse.json({ error: e.message, items: [] }, { status: 500 });
  }
}
