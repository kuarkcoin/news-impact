// app/api/cron/scan/route.ts
import { NextResponse } from "next/server";
import { kv } from "@vercel/kv";

export const runtime = "nodejs";
export const maxDuration = 60;

const FINNHUB_API_KEY = process.env.FINNHUB_API_KEY;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

// =========================
// CRON AUTH (VERCEL + OPTIONAL MANUAL)
// =========================
function isVercelCron(req: Request) {
  return req.headers.get("x-vercel-cron") === "1";
}
function hasValidSecret(req: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;

  const { searchParams } = new URL(req.url);
  if (searchParams.get("secret") === secret) return true;

  const authHeader = req.headers.get("authorization");
  if (authHeader === `Bearer ${secret}`) return true;

  return false;
}
function assertCronAuth(req: Request) {
  if (isVercelCron(req)) return true;
  return hasValidSecret(req);
}

// =========================
// SETTINGS (Finnhub Free-safe)
// =========================
const BATCH_SIZE = 6;                  // her çalışmada kaç sembol taransın
const PER_SYMBOL = 3;                  // sembol başı kaç haber alınsın (2 çok az kalıyor)
const MAX_POOL_ITEMS = 600;
const MAX_NEWS_AGE_DAYS = 10;
const CANDLE_LOOKBACK_DAYS = 260;
const CANDLE_CACHE_TTL_SEC = 6 * 60 * 60; // 6 saat
const BETWEEN_SYMBOL_SLEEP_MS = 180;   // rate-limit koruması

// Gemini limits
const GEMINI_MAX_PER_RUN = 5;
const GEMINI_ONLY_IF_SCORE_GTE = 78;
const GEMINI_CACHE_TTL_SEC = 7 * 24 * 3600;

// =========================
// NASDAQ UNIVERSE (sadece Nasdaq)
// =========================
const DEFAULT_UNIVERSE: string[] = [
  "AAPL","MSFT","NVDA","AMZN","META","GOOGL","TSLA","AMD","AVGO","INTC","QCOM","TXN","MU","NFLX","ADBE","CRM",
  "PLTR","COIN","MSTR","UBER","SHOP","PYPL","ASML","AMAT","LRCX","KLAC","SNPS","CDNS","NOW","INTU","CSCO","ORCL"
];

// =========================
// RELEVANCE (alakasız haberleri ele)
// =========================
const SYMBOL_ALIASES: Record<string, string[]> = {
  AAPL: ["apple", "iphone", "ipad", "mac", "ios", "app store", "tim cook"],
  MSFT: ["microsoft", "windows", "azure", "copilot", "satya"],
  NVDA: ["nvidia", "gpu", "cuda", "h100", "blackwell", "jensen"],
  AMZN: ["amazon", "aws", "prime"],
  META: ["meta", "facebook", "instagram", "whatsapp", "zuckerberg"],
  GOOGL: ["google", "alphabet", "youtube", "gemini"],
  TSLA: ["tesla", "elon", "fsd", "model 3", "model y", "cybertruck"],
  AMD: ["amd", "ryzen", "epyc", "lisa su"],
  AVGO: ["broadcom", "avgo", "vmware"],
  INTC: ["intel"],
  QCOM: ["qualcomm", "snapdragon"],
  TXN: ["texas instruments"],
  MU: ["micron"],
  NFLX: ["netflix"],
  ADBE: ["adobe"],
  CRM: ["salesforce"],
  PLTR: ["palantir"],
  COIN: ["coinbase"],
  MSTR: ["microstrategy"],
  UBER: ["uber"],
  SHOP: ["shopify"],
  PYPL: ["paypal"],
  ASML: ["asml"],
  AMAT: ["applied materials"],
  LRCX: ["lam research"],
  KLAC: ["kla"],
  SNPS: ["synopsys"],
  CDNS: ["cadence"],
  NOW: ["servicenow"],
  INTU: ["intuit", "turbotax", "quickbooks"],
  CSCO: ["cisco"],
  ORCL: ["oracle"],
};

function isRelevant(symbol: string, headline: string) {
  const t = (headline || "").toLowerCase();
  const aliases = SYMBOL_ALIASES[symbol] || [symbol.toLowerCase()];
  // En az bir alias geçmeli
  return aliases.some((a) => a && t.includes(a));
}

// =========================
// SIMPLE NLP
// =========================
const BULLISH_KEYWORDS = [
  "beat","record","jump","soar","surge","approve","launch","partnership","buyback","dividend","upgrade","growth",
  "raises","raise","strong","profit","wins","contract","guidance","earnings","eps","acquire","acquisition"
];
const BEARISH_KEYWORDS = [
  "miss","fail","drop","fall","plunge","sue","lawsuit","investigation","downgrade","cut","weak","loss","ban",
  "recall","resign","delay","lower","warning","sec","probe","antitrust"
];

type Dir = -1 | 0 | 1;

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

  expectedDir: Dir;
  realizedDir: Dir;
  rsi14: number | null;
  breakout20: boolean | null;
  bullTrap: boolean | null;
  volumeSpike: boolean | null;

  technicalContext: string | null;

  // UI sinyalleri
  signals: string[];
  signalsText: string;

  // Gemini yorumları
  aiSummary?: string | null;
  aiBullets?: string[] | null;
  aiSentiment?: "bullish" | "bearish" | "mixed" | "neutral" | null;
};

type CandleData = { t: number[]; c: number[]; v?: number[] };

const clamp = (n: number, a: number, b: number) => Math.max(a, Math.min(b, n));

// =========================
// BATCH cursor
// =========================
function pickBatch(universe: string[], cursor: number) {
  const batch: string[] = [];
  const u = universe.length ? universe : DEFAULT_UNIVERSE;

  for (let i = 0; i < BATCH_SIZE; i++) batch.push(u[(cursor + i) % u.length]);
  const nextCursor = (cursor + BATCH_SIZE) % u.length;

  return { batch, nextCursor };
}

// ✅ more robust than findIndex: last candle <= target
function findLastLE(times: number[], target: number) {
  let lo = 0, hi = times.length - 1, ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (times[mid] <= target) { ans = mid; lo = mid + 1; }
    else hi = mid - 1;
  }
  return ans;
}

async function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

// =========================
// FETCH with retry/backoff
// =========================
async function fetchWithRetry(url: string, maxRetries = 3) {
  let lastErr: any = null;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const res = await fetch(url, { cache: "no-store" });

      if (res.status === 429) {
        const wait = attempt === 0 ? 900 : attempt === 1 ? 1800 : 2800;
        await sleep(wait);
        lastErr = new Error("429");
        continue;
      }

      if (res.status >= 500) {
        const wait = attempt === 0 ? 600 : attempt === 1 ? 1200 : 2200;
        await sleep(wait);
        lastErr = new Error(`HTTP_${res.status}`);
        continue;
      }

      return res;
    } catch (e) {
      lastErr = e;
      const wait = attempt === 0 ? 600 : attempt === 1 ? 1200 : 2200;
      await sleep(wait);
    }
  }

  throw lastErr ?? new Error("fetch failed");
}

// =========================
// SCORING / DIRECTION
// =========================
function sentimentFromHeadline(headline: string) {
  const text = (headline || "").toLowerCase();
  let s = 0;

  for (const w of BULLISH_KEYWORDS) if (text.includes(w)) s += 12;
  for (const w of BEARISH_KEYWORDS) if (text.includes(w)) s -= 12;

  if (text.includes("but") || text.includes("despite") || text.includes("however")) {
    s = Math.round(s * 0.7);
  }
  if (text.includes("earnings") || text.includes("guidance") || text.includes("eps")) s += 10;

  return clamp(s, -30, 30);
}

function expectedDirectionFromHeadline(headline: string): Dir {
  const s = sentimentFromHeadline(headline);
  if (s >= 10) return 1;
  if (s <= -10) return -1;
  return 0;
}

function realizedDirection(ret1d: number | null, ret5d: number | null): Dir {
  const r = (ret5d ?? ret1d);
  if (typeof r !== "number") return 0;
  if (r > 0.01) return 1;
  if (r < -0.01) return -1;
  return 0;
}

function calcExpectedImpact(headline: string, retPre5: number | null) {
  const s = sentimentFromHeadline(headline);

  let exp = 64 + Math.round(s * 0.9);
  let pricedIn = false;

  // priced-in heuristics
  if (typeof retPre5 === "number") {
    if (s > 0 && retPre5 > 0.06) { exp -= 22; pricedIn = true; }
    if (s < 0 && retPre5 < -0.06) { exp += 8; pricedIn = true; }
    if (s > 0 && retPre5 <= 0.02) exp += 8;
  }

  return { expectedImpact: clamp(exp, 45, 95), pricedIn };
}

function calcRealizedImpact(ret1d: number | null, ret5d: number | null) {
  const rUsed = (ret5d ?? ret1d);
  if (typeof rUsed !== "number") return null;

  const base = clamp(Math.round(Math.abs(rUsed) * 1000), 0, 50);
  return clamp(50 + base, 50, 100);
}

function combineScore(expectedImpact: number, realizedImpact: number | null, pricedIn: boolean) {
  let score = realizedImpact === null
    ? expectedImpact
    : Math.round(realizedImpact * 0.7 + expectedImpact * 0.3);

  if (pricedIn) score -= 8;
  return clamp(score, 40, 100);
}

function calcConfidence(ret1d: number | null, ret5d: number | null, pricedIn: boolean) {
  let c = 30;
  if (ret1d !== null) c = 70;
  if (ret5d !== null) c = 90;
  if (pricedIn) c += 5;
  return clamp(c, 0, 100);
}

// =========================
// TECH HELPERS (RSI, breakout, vol)
// =========================
function smaAt(closes: number[], idx: number, period: number) {
  const start = idx - period + 1;
  if (start < 0) return null;
  let sum = 0;
  for (let i = start; i <= idx; i++) sum += closes[i];
  return sum / period;
}

function minAt(closes: number[], idx: number, lookback: number) {
  const start = Math.max(0, idx - lookback + 1);
  let m = Infinity;
  for (let i = start; i <= idx; i++) m = Math.min(m, closes[i]);
  return Number.isFinite(m) ? m : null;
}

function maxAt(closes: number[], idx: number, lookback: number) {
  const start = Math.max(0, idx - lookback + 1);
  let m = -Infinity;
  for (let i = start; i <= idx; i++) m = Math.max(m, closes[i]);
  return Number.isFinite(m) ? m : null;
}

function rsiAt(closes: number[], idx: number, period: number) {
  if (idx - period < 0) return null;
  let gains = 0;
  let losses = 0;
  for (let i = idx - period + 1; i <= idx; i++) {
    const ch = closes[i] - closes[i - 1];
    if (ch >= 0) gains += ch;
    else losses += -ch;
  }
  const avgGain = gains / period;
  const avgLoss = losses / period;
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - (100 / (1 + rs));
}

function volumeSpikeAt(vols: number[] | undefined, idx: number) {
  if (!vols?.length) return null;
  if (idx < 6 || idx >= vols.length) return null;
  const recent = vols.slice(idx - 6, idx);
  const avg = recent.reduce((a, b) => a + b, 0) / recent.length;
  const v = vols[idx];
  if (!avg || !Number.isFinite(avg) || !Number.isFinite(v)) return null;
  return v > avg * 2.2; // biraz daha hassas
}

function breakout20At(closes: number[], idx: number) {
  if (idx < 21) return null;
  const prevHigh = maxAt(closes, idx - 1, 20);
  if (prevHigh === null) return null;
  return closes[idx] > prevHigh * 1.002;
}

function technicalContextAt(closes: number[], idx: number) {
  if (!closes?.length || idx < 0 || idx >= closes.length) return null;

  const price = closes[idx];
  const ma50 = smaAt(closes, idx, 50);
  const ma200 = smaAt(closes, idx, 200);

  let trend = "🟨 Range";
  if (ma50 !== null && ma200 !== null) {
    if (price > ma50 && ma50 > ma200) trend = "📈 Uptrend";
    else if (price < ma50 && ma50 < ma200) trend = "📉 Downtrend";
  } else if (ma50 !== null) {
    trend = price >= ma50 ? "📈 Uptrend" : "📉 Downtrend";
  }

  const sup = minAt(closes, idx, 20);
  const res = maxAt(closes, idx, 20);

  const tags: string[] = [trend];

  if (sup !== null && (price - sup) / price <= 0.02) tags.push("🧲 Near support");
  else if (res !== null && (res - price) / price <= 0.02) tags.push("🧲 Near resistance");

  if (idx - 10 >= 0) {
    const r10 = (price - closes[idx - 10]) / closes[idx - 10];
    if (Math.abs(r10) >= 0.06) tags.push("🔥 Momentum");
  }

  return tags.join(" · ");
}

function buildSignals(it: {
  expectedDir: Dir;
  realizedDir: Dir;
  tooEarly: boolean;
  confidence: number;
  rsi14: number | null;
  breakout20: boolean | null;
  volumeSpike: boolean | null;
  bullTrap: boolean | null;
  pricedIn: boolean | null;
  ret1d: number | null;
  ret5d: number | null;
  technicalContext: string | null;
}) {
  const sig: string[] = [];

  // Direction
  sig.push(it.expectedDir === 1 ? "E▲ Bull" : it.expectedDir === -1 ? "E▼ Bear" : "E■ Flat");
  sig.push(it.realizedDir === 1 ? "R▲ Bull" : it.realizedDir === -1 ? "R▼ Bear" : "R■ Flat");

  if (it.tooEarly) sig.push("⚠️ Too early");
  sig.push(`Conf ${Math.round(it.confidence)}%`);

  if (typeof it.rsi14 === "number") {
    if (it.rsi14 >= 70) sig.push(`RSI ${it.rsi14.toFixed(0)} OB`);
    else if (it.rsi14 <= 30) sig.push(`RSI ${it.rsi14.toFixed(0)} OS`);
    else sig.push(`RSI ${it.rsi14.toFixed(0)}`);
  }
  if (it.breakout20 === true) sig.push("🚪 20D breakout");
  if (it.volumeSpike === true) sig.push("📊 Vol spike");
  if (it.bullTrap === true) sig.push("🪤 Bull trap");

  if (it.pricedIn === true) sig.push("🧾 Priced-in");
  if (it.technicalContext) sig.push(it.technicalContext);

  return sig.filter(Boolean);
}

// =========================
// GEMINI (cached) — only relevant items
// =========================
function aiCacheKey(it: { symbol: string; publishedAt: string; headline: string }) {
  const h = (it.headline || "").trim().toLowerCase().slice(0, 180);
  return `ai:v2:${it.symbol}:${it.publishedAt}:${h}`;
}

async function geminiComment(params: {
  symbol: string;
  headline: string;
  technicalContext: string | null;
  retPre5: number | null;
  ret1d: number | null;
  ret5d: number | null;
  score: number;
  pricedIn: boolean | null;
  confidence: number;
}) {
  if (!GEMINI_API_KEY) return null;

  const prompt = `
Sen bir finans haber-reaksiyon analisti asistanısın. Yatırım tavsiyesi verme.
Bu başlığın HİSSEYLE alakalı olup olmadığını kontrol et ve alaka yoksa "irrelevant" yaz.

Hisse: ${params.symbol}
Başlık: ${params.headline}

Teknik Context: ${params.technicalContext ?? "—"}
Pre-5d: ${params.retPre5 ?? "—"}
+1D: ${params.ret1d ?? "—"}
+5D: ${params.ret5d ?? "—"}
Score: ${params.score}
Confidence: ${params.confidence}%
Priced-in: ${params.pricedIn === true ? "yes" : params.pricedIn === false ? "no" : "unknown"}

FORMAT:
- relevance: relevant | irrelevant
- summary: Tek cümle (maks 18 kelime)
- sentiment: bullish | bearish | mixed | neutral
- bullets: 3 madde (10-14 kelime)
`;

  const url =
    "https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=" +
    encodeURIComponent(GEMINI_API_KEY);

  const body = {
    contents: [{ role: "user", parts: [{ text: prompt }] }],
    generationConfig: { temperature: 0.35, maxOutputTokens: 240 },
  };

  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!res.ok) return null;

  const json = await res.json();
  const text =
    json?.candidates?.[0]?.content?.parts?.map((p: any) => p?.text).filter(Boolean).join("\n") || "";

  const relMatch = text.match(/relevance:\s*(relevant|irrelevant)/i);
  const summaryMatch = text.match(/summary:\s*(.+)/i);
  const sentimentMatch = text.match(/sentiment:\s*(bullish|bearish|mixed|neutral)/i);

  const bullets = text
    .split("\n")
    .filter((l: string) => l.trim().startsWith("-") || l.trim().startsWith("•"))
    .map((l: string) => l.replace(/^[-•]\s*/, "").trim())
    .filter(Boolean);

  const relevance = (relMatch?.[1]?.toLowerCase() as any) || "relevant";
  if (relevance === "irrelevant") return { irrelevant: true };

  const aiSummary = summaryMatch?.[1]?.trim() || null;
  const aiSentiment = (sentimentMatch?.[1]?.toLowerCase() as any) || null;
  const aiBullets = bullets.length ? bullets.slice(0, 5) : null;

  if (!aiSummary && !aiBullets) return null;
  return { aiSummary, aiSentiment, aiBullets };
}

// =========================
// CANDLES (KV cached)
// =========================
async function getCandlesCached(symbol: string, fromUnix: number, toUnix: number): Promise<CandleData | null> {
  const key = `candles:D:${symbol}:lb=${CANDLE_LOOKBACK_DAYS}`;

  try {
    const cached = (await kv.get(key)) as CandleData | null;
    if (cached?.t?.length && cached?.c?.length) return cached;
  } catch {}

  const url =
    `https://finnhub.io/api/v1/stock/candle?symbol=${encodeURIComponent(symbol)}` +
    `&resolution=D&from=${fromUnix}&to=${toUnix}&token=${FINNHUB_API_KEY}`;

  const res = await fetchWithRetry(url);
  if (!res.ok) return null;

  const data = await res.json();
  if (data?.s !== "ok") return null;

  const payload: CandleData = {
    t: data.t as number[],
    c: data.c as number[],
    v: Array.isArray(data.v) ? (data.v as number[]) : undefined,
  };

  try { await kv.set(key, payload, { ex: CANDLE_CACHE_TTL_SEC }); } catch {}
  return payload;
}

// =========================
// PER-SYMBOL fetch (relevance + technicals)
// =========================
async function fetchSymbolItems(symbol: string): Promise<LeaderItem[]> {
  const now = new Date();
  const toUnix = Math.floor(now.getTime() / 1000);
  const fromUnix = Math.floor(toUnix - CANDLE_LOOKBACK_DAYS * 24 * 3600);

  const newsFrom = new Date(now.getTime() - MAX_NEWS_AGE_DAYS * 24 * 3600 * 1000).toISOString().slice(0, 10);
  const newsTo = now.toISOString().slice(0, 10);

  const newsUrl =
    `https://finnhub.io/api/v1/company-news?symbol=${encodeURIComponent(symbol)}` +
    `&from=${newsFrom}&to=${newsTo}&token=${FINNHUB_API_KEY}`;

  const newsRes = await fetchWithRetry(newsUrl);
  if (!newsRes.ok) {
    if (newsRes.status === 429) throw new Error("429");
    return [];
  }

  const news = await newsRes.json();
  if (!Array.isArray(news) || news.length === 0) return [];

  const candles = await getCandlesCached(symbol, fromUnix, toUnix);

  const items: LeaderItem[] = [];
  const seen = new Set<string>();

  for (const n of news) {
    if (!n?.headline || !n?.datetime) continue;

    // ✅ relevance filter (asıl fix)
    if (!isRelevant(symbol, String(n.headline))) continue;

    const ageDays = (Date.now() - Number(n.datetime) * 1000) / (1000 * 60 * 60 * 24);
    if (ageDays > MAX_NEWS_AGE_DAYS) continue;

    const key = `${symbol}|${n.datetime}|${String(n.headline).slice(0, 120)}`;
    if (seen.has(key)) continue;
    seen.add(key);

    let ret1d: number | null = null;
    let ret5d: number | null = null;
    let retPre5: number | null = null;

    let baseTech: string | null = null;
    let rsi14: number | null = null;
    let breakout20: boolean | null = null;
    let volumeSpike: boolean | null = null;

    if (candles?.t?.length && candles?.c?.length) {
      // ✅ robust candle index: last candle <= newsTime
      const idx = findLastLE(candles.t, Number(n.datetime));
      if (idx !== -1) {
        const base = candles.c[idx];

        // forward returns
        if (idx + 1 < candles.c.length) ret1d = (candles.c[idx + 1] - base) / base;
        if (idx + 5 < candles.c.length) ret5d = (candles.c[idx + 5] - base) / base;
        // pre returns
        if (idx - 5 >= 0) retPre5 = (base - candles.c[idx - 5]) / candles.c[idx - 5];

        baseTech = technicalContextAt(candles.c, idx);
        rsi14 = rsiAt(candles.c, idx, 14);
        breakout20 = breakout20At(candles.c, idx);
        volumeSpike = volumeSpikeAt(candles.v, idx);
      }
    }

    const exp = calcExpectedImpact(String(n.headline), retPre5);
    const realizedImpact = calcRealizedImpact(ret1d, ret5d);
    const score = combineScore(exp.expectedImpact, realizedImpact, exp.pricedIn);
    const confidence = calcConfidence(ret1d, ret5d, exp.pricedIn);
    const tooEarly = realizedImpact === null;

    const bullTrap =
      breakout20 === true &&
      ((typeof ret1d === "number" && ret1d < -0.03) || (typeof ret5d === "number" && ret5d < -0.05));

    const expectedDir = expectedDirectionFromHeadline(String(n.headline));
    const realizedDir = realizedDirection(ret1d, ret5d);

    const technicalContext = [
      baseTech || null,
      typeof rsi14 === "number" ? `RSI ${rsi14.toFixed(0)}` : null,
      breakout20 ? "20D breakout" : null,
      volumeSpike ? "Vol spike" : null,
      bullTrap ? "Bull trap risk" : null,
    ].filter(Boolean).join(" · ") || (baseTech ?? "General");

    const signals = buildSignals({
      expectedDir,
      realizedDir,
      tooEarly,
      confidence,
      rsi14,
      breakout20,
      volumeSpike,
      bullTrap,
      pricedIn: exp.pricedIn,
      ret1d,
      ret5d,
      technicalContext,
    });
    const signalsText = signals.join(" · ");

    items.push({
      symbol,
      headline: String(n.headline),
      type: n.category ?? null,
      publishedAt: new Date(Number(n.datetime) * 1000).toISOString(),
      url: n.url ?? null,

      retPre5,
      ret1d,
      ret5d,

      pricedIn: exp.pricedIn,
      expectedImpact: exp.expectedImpact,
      realizedImpact: realizedImpact ?? exp.expectedImpact,
      score,
      confidence,
      tooEarly,

      expectedDir,
      realizedDir,
      rsi14,
      breakout20,
      bullTrap,
      volumeSpike,

      technicalContext,

      signals,
      signalsText,

      aiSummary: null,
      aiBullets: null,
      aiSentiment: null,
    });

    if (items.length >= PER_SYMBOL) break;
  }

  return items;
}

// =========================
// MAIN
// =========================
export async function GET(req: Request) {
  if (!FINNHUB_API_KEY) {
    return NextResponse.json({ error: "No FINNHUB_API_KEY" }, { status: 500 });
  }
  if (!assertCronAuth(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const { searchParams } = new URL(req.url);

    if (searchParams.get("reset") === "1") {
      await kv.del("pool:v1");
      await kv.del("symbols:cursor");
      return NextResponse.json({ ok: true, reset: true }, { status: 200 });
    }

    const universe =
      ((await kv.get("symbols:universe")) as string[] | null) ?? DEFAULT_UNIVERSE;
    const cursor = ((await kv.get("symbols:cursor")) as number | null) ?? 0;

    const { batch, nextCursor } = pickBatch(universe, cursor);

    const newItems: LeaderItem[] = [];

    // sequential fetch + sleep
    for (const sym of batch) {
      try {
        const arr = await fetchSymbolItems(sym);
        newItems.push(...arr);
      } catch (e: any) {
        if (String(e?.message || "").includes("429")) throw e;
        console.error("symbol fetch error", sym, e);
      }
      await sleep(BETWEEN_SYMBOL_SLEEP_MS);
    }

    // Gemini: only on relevant + high score
    let aiUsed = 0;
    if (GEMINI_API_KEY) {
      const candidates = [...newItems]
        .filter((x) => (x.score ?? 0) >= GEMINI_ONLY_IF_SCORE_GTE)
        .sort((a, b) => (b.score ?? 0) - (a.score ?? 0));

      for (const it of candidates) {
        if (aiUsed >= GEMINI_MAX_PER_RUN) break;

        const k = aiCacheKey(it);

        try {
          const cached = (await kv.get(k)) as any;
          if (cached?.aiSummary || cached?.aiBullets || cached?.irrelevant) {
            if (cached?.irrelevant) continue;
            it.aiSummary = cached.aiSummary ?? null;
            it.aiBullets = cached.aiBullets ?? null;
            it.aiSentiment = cached.aiSentiment ?? null;
            continue;
          }
        } catch {}

        try {
          const out = await geminiComment({
            symbol: it.symbol,
            headline: it.headline,
            technicalContext: it.technicalContext,
            retPre5: it.retPre5,
            ret1d: it.ret1d,
            ret5d: it.ret5d,
            score: it.score,
            pricedIn: it.pricedIn,
            confidence: it.confidence,
          });

          if (out?.irrelevant) {
            try { await kv.set(k, { irrelevant: true }, { ex: GEMINI_CACHE_TTL_SEC }); } catch {}
            continue;
          }

          if (out) {
            it.aiSummary = out.aiSummary ?? null;
            it.aiBullets = out.aiBullets ?? null;
            it.aiSentiment = out.aiSentiment ?? null;
            try { await kv.set(k, out, { ex: GEMINI_CACHE_TTL_SEC }); } catch {}
            aiUsed++;
          }
        } catch {
          // gemini fail -> ignore
        }
      }
    }

    // merge pool
    const poolRaw = (await kv.get("pool:v1")) as { asOf: string; items: LeaderItem[] } | null;
    const oldItems = poolRaw?.items || [];

    const mergedAll = [...newItems, ...oldItems];
    const seen = new Set<string>();
    const merged: LeaderItem[] = [];

    for (const it of mergedAll) {
      const kk = `${it.symbol}|${it.publishedAt}|${it.headline.trim().toLowerCase()}`;
      if (seen.has(kk)) continue;
      seen.add(kk);
      merged.push(it);
      if (merged.length >= MAX_POOL_ITEMS) break;
    }

    const payload = { asOf: new Date().toISOString(), items: merged };
    await kv.set("pool:v1", payload);
    await kv.set("symbols:cursor", nextCursor);

    return NextResponse.json(
      {
        ok: true,
        scanned: batch,
        added: newItems.length,
        aiUsed,
        cursor,
        nextCursor,
        poolSize: merged.length,
      },
      { status: 200 }
    );
  } catch (e: any) {
    if (String(e?.message || "").includes("429")) {
      return NextResponse.json(
        { error: "Rate limit exceeded – please try again later" },
        { status: 429 }
      );
    }
    return NextResponse.json({ error: e?.message || "Unknown error" }, { status: 500 });
  }
}