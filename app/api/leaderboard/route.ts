import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const maxDuration = 60;

const FINNHUB_API_KEY = process.env.FINNHUB_API_KEY;

// 🔥 HAVUZ
const ALL_SYMBOLS = [
  "AAPL","MSFT","NVDA","AMZN","META","GOOGL","TSLA",
  "AMD","AVGO","INTC","QCOM","TXN","MU","NFLX","ADBE",
  "CRM","PLTR","COIN","MSTR","UBER","SHOP","PYPL",
];

const BATCH_SIZE = 15;         // her requestte kaç sembol taransın
const PER_SYMBOL = 2;          // her sembolden kaç haber alalım
const DELAY_MS = 120;          // rate limit koruma

const BULLISH = ["beat","record","jump","soar","surge","approve","launch","partnership","buyback","dividend","upgrade","growth","high","raises","strong"];
const BEARISH = ["miss","fail","drop","fall","plunge","sue","lawsuit","investigation","downgrade","cut","weak","loss","ban","warning","delay"];

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

  expectedImpact: number;   // NLP tahmini
  realizedImpact: number;   // fiyat tepkisi varsa gerçek
  score: number;            // listede sıralama: realized varsa realized, yoksa expected
  confidence: number;       // 0..100
  tooEarly: boolean;        // realized veri yok demek
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

// --- TIME HELPERS (KRİTİK) ---
// unix (sec) -> YYYY-MM-DD (UTC)
function dayKeyFromUnixSec(sec: number) {
  const d = new Date(sec * 1000);
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

// candles.t (sec) -> dayKey map
function buildDayIndex(tArr: number[]) {
  const map = new Map<string, number>();
  for (let i = 0; i < tArr.length; i++) {
    const k = dayKeyFromUnixSec(tArr[i]);
    // aynı güne birden çok entry olursa ilkini tut (genelde zaten 1)
    if (!map.has(k)) map.set(k, i);
  }
  return map;
}

function pct(x: number | null) {
  if (typeof x !== "number") return null;
  return x;
}

// --- REALIZED IMPACT (price) ---
function realizedFromReturns(ret5d: number | null, ret1d: number | null, retPre5: number | null) {
  const rUsed = ret5d ?? ret1d;
  if (rUsed == null) {
    return {
      realizedImpact: 50,
      pricedIn: null as boolean | null,
      tooEarly: true,
      confidence: 25,
    };
  }

  const base = clamp(Math.round(Math.abs(rUsed) * 1000), 0, 50);
  let pricedIn: boolean | null = null;

  if (typeof retPre5 === "number" && Math.abs(rUsed) > 0.005) {
    pricedIn = Math.abs(retPre5) > Math.abs(rUsed) * 0.9;
  }

  let pen = 0;
  if (pricedIn === true && typeof retPre5 === "number") {
    pen = clamp(Math.round((Math.abs(retPre5) - Math.abs(rUsed)) * 1200), 0, 25);
  }

  const realizedImpact = clamp(50 + base - pen, 40, 100);

  let conf = 40;
  if (ret1d != null) conf += 20;
  if (ret5d != null) conf += 35;
  if (pricedIn != null) conf += 5;

  return {
    realizedImpact,
    pricedIn,
    tooEarly: false,
    confidence: clamp(conf, 0, 100),
  };
}

// --- EXPECTED IMPACT (headline NLP) ---
function expectedFromHeadline(headline: string, retPre5: number | null) {
  const text = headline.toLowerCase();

  // küçük ağırlıklar: daha stabil
  let senti = 0;
  for (const w of BULLISH) if (text.includes(w)) senti += 6;
  for (const w of BEARISH) if (text.includes(w)) senti -= 6;
  senti = clamp(senti, -18, 18);

  let expected = 55 + senti; // 55 taban: “haber var” diye hafif yukarı
  let pricedIn = false;

  // priced-in tahmini: haber iyi + önceden güçlü yükseliş => puanı kır
  if (typeof retPre5 === "number") {
    if (senti > 6 && retPre5 > 0.05) { expected -= 18; pricedIn = true; }
    if (senti < -6 && retPre5 < -0.05) { expected += 10; pricedIn = true; }
    if (senti > 6 && retPre5 <= 0.02) { expected += 10; }
  }

  expected = clamp(expected, 35, 95);

  // NLP güveni: düşük başlayacak
  let conf = 30;
  if (Math.abs(senti) >= 12) conf += 10; // güçlü kelime sinyali

  // retPre5 varsa tahmin daha anlamlı
  if (typeof retPre5 === "number") conf += 15;

  return {
    expectedImpact: expected,
    pricedInGuess: pricedIn,
    confidenceGuess: clamp(conf, 0, 60),
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
  } catch {
    return null;
  }
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

    // dedupe (aynı sembolde aynı başlık aynı gün)
    const k = `${symbol}|${dayKeyFromUnixSec(n.datetime)}|${n.headline.trim().toLowerCase()}`;
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

    // Expected (headline) her zaman var
    const exp = expectedFromHeadline(n.headline, pct(retPre5));

    // Realized (price) varsa üstün gelecek
    const real = realizedFromReturns(pct(ret5d), pct(ret1d), pct(retPre5));

    const tooEarly = real.tooEarly;

    // score: realized varsa onu kullan, yoksa expected
    const score = tooEarly ? exp.expectedImpact : real.realizedImpact;

    // pricedIn: realized varsa onu, yoksa tahmini
    const pricedIn = tooEarly ? exp.pricedInGuess : real.pricedIn;

    // confidence: realized varsa yüksek, yoksa düşük
    const confidence = tooEarly
      ? exp.confidenceGuess
      : real.confidence;

    items.push({
      symbol,
      headline: n.headline,
      type: n.category ?? null,
      publishedAt: new Date(n.datetime * 1000).toISOString(),
      url: n.url ?? null,

      retPre5,
      ret1d,
      ret5d,

      pricedIn,
      expectedImpact: exp.expectedImpact,
      realizedImpact: real.realizedImpact,
      score,
      confidence,
      tooEarly,
    });

    if (items.length >= perSymbol) break;
  }

  return items;
}

export async function GET(req: Request) {
  try {
    if (!FINNHUB_API_KEY) {
      return NextResponse.json({ error: "FINNHUB_API_KEY missing", asOf: new Date().toISOString(), items: [] }, { status: 500 });
    }

    const { searchParams } = new URL(req.url);
    const min = clamp(parseInt(searchParams.get("min") || "30", 10), 0, 100);
    const limit = clamp(parseInt(searchParams.get("limit") || "50", 10), 1, 200);
    const perSymbol = clamp(parseInt(searchParams.get("perSymbol") || String(PER_SYMBOL), 10), 1, 5);

    // her requestte farklı semboller taransın (havuzdan)
    const symbols = shuffle(ALL_SYMBOLS).slice(0, BATCH_SIZE);

    const all: LeaderItem[] = [];
    const globalSeen = new Set<string>();

    for (const sym of symbols) {
      const items = await fetchSymbolItems(sym, perSymbol);

      for (const it of items) {
        // global dedupe (aynı başlık farklı sembolde de çıkabiliyor, ama burada sembol dahil kalsın)
        const gk = `${it.symbol}|${it.publishedAt.slice(0,10)}|${it.headline.trim().toLowerCase()}`;
        if (globalSeen.has(gk)) continue;
        globalSeen.add(gk);
        all.push(it);
      }

      await sleep(DELAY_MS);
    }

    const filtered = all
      .filter((x) => x.score >= min)
      .sort((a, b) => {
        // önce score, sonra confidence, sonra tarih
        if (b.score !== a.score) return b.score - a.score;
        if (b.confidence !== a.confidence) return b.confidence - a.confidence;
        return new Date(b.publishedAt).getTime() - new Date(a.publishedAt).getTime();
      })
      .slice(0, limit);

    return NextResponse.json({ asOf: new Date().toISOString(), items: filtered }, { status: 200 });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || "Unknown error", asOf: new Date().toISOString(), items: [] }, { status: 500 });
  }
}