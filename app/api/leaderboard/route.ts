import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const maxDuration = 60; // Vercel timeout önlemi

// Takip edilecek hisseler
const SYMBOLS = ["AAPL", "NVDA", "TSLA", "MSFT", "AMD", "AMZN", "META", "GOOGL"];

// API Anahtarı
const FINNHUB_API_KEY = process.env.FINNHUB_API_KEY;

// --- YARDIMCI MATEMATİK FONKSİYONLARI ---

const clamp = (n: number, a: number, b: number) => Math.max(a, Math.min(b, n));

function scoreFromRet(ret5d: number | null, ret1d: number | null, retPre5: number | null) {
  // Eğer veri yoksa (null), nötr puan dön
  if (ret1d === null && ret5d === null) return { score: 50, pricedIn: false };

  // Öncelik 5 günlük getiri, yoksa 1 günlük
  const r = ret5d ?? ret1d ?? 0;
  
  // Fiyatlanmış mı? (Haber öncesi hareket, haber sonrası hareketten büyük mü?)
  let pricedIn = false;
  if (typeof retPre5 === "number" && Math.abs(r) > 0.005) { // %0.5'ten büyük hareket varsa bak
    pricedIn = Math.abs(retPre5) > Math.abs(r) * 0.9;
  }

  // Baz Puan (0-50 arası ekle)
  const base = clamp(Math.round(Math.abs(r) * 1000), 0, 50);
  
  // Ceza Puanı (Eğer önceden fiyatlandıysa puan kır)
  let pen = 0;
  if (pricedIn && typeof retPre5 === "number") {
    pen = clamp(Math.round((Math.abs(retPre5) - Math.abs(r)) * 1200), 0, 25);
  }

  // Nihai Skor (50 taban puan + hareket puanı - ceza)
  return {
    score: clamp(50 + base - pen, 50, 100),
    pricedIn
  };
}

// --- VERİ ÇEKME FONKSİYONU ---

async function fetchStockData(symbol: string) {
  if (!FINNHUB_API_KEY) return null;

  const now = new Date();
  
  // --- KRİTİK AYAR: GEÇMİŞ VERİ MODU ---
  // Renkli skorları görebilmek için "Bugünü" değil, 10 gün öncesini baz alıyoruz.
  // Böylece haberden sonraki 5 günün fiyatı oluşmuş oluyor.
  
  const toDate = new Date(now.getTime() - 10 * 24 * 3600 * 1000); // 10 gün önceye kadar
  const fromDate = new Date(now.getTime() - 30 * 24 * 3600 * 1000); // 30 gün önceden başla

  // Mum (Candle) verisi için geniş aralık (Pre-5 ve Post-5 hesaplamak için)
  const toUnix = Math.floor(now.getTime() / 1000);
  const fromUnix = Math.floor(toUnix - 90 * 24 * 3600); 

  try {
    // 1. Haberleri Çek (Geçmiş tarih aralığıyla)
    const newsRes = await fetch(
      `https://finnhub.io/api/v1/company-news?symbol=${symbol}&from=${fromDate.toISOString().slice(0,10)}&to=${toDate.toISOString().slice(0,10)}&token=${FINNHUB_API_KEY}`,
      { next: { revalidate: 60 } } // 60 saniye cache
    );
    
    if (!newsRes.ok) return null;
    const newsData = await newsRes.json();
    
    // Haber yoksa veya dizi değilse çık
    if (!Array.isArray(newsData) || newsData.length === 0) return null;

    // En yeni haberi al (Bizim belirlediğimiz aralıktaki en yeni)
    const item = newsData[0]; 

    // 2. Fiyatları (Candles) Çek
    const candleRes = await fetch(
      `https://finnhub.io/api/v1/stock/candle?symbol=${symbol}&resolution=D&from=${fromUnix}&to=${toUnix}&token=${FINNHUB_API_KEY}`,
      { next: { revalidate: 60 } }
    );
    
    const candles = await candleRes.json();
    
    // Hesaplama Değişkenleri
    let ret1d = null;
    let ret5d = null;
    let retPre5 = null;

    if (candles.s === "ok" && candles.c && candles.t) {
       const tArr = candles.t; // Zaman damgaları
       const cArr = candles.c; // Kapanış fiyatları
       
       // Haberin yayınlandığı günü veya hemen sonrasını bul
       let idx = tArr.findIndex((t: number) => t >= item.datetime);
       
       // Eğer tarih bulunduysa ve fiyat dizisinin sınırları içindeyse
       if (idx !== -1 && idx < cArr.length) {
         const basePrice = cArr[idx]; // Haber günü fiyatı
         
         // +1 Günlük Getiri (Ertesi gün verisi var mı?)
         if (idx + 1 < cArr.length) {
            ret1d = (cArr[idx + 1] - basePrice) / basePrice;
         }
         
         // +5 Günlük Getiri (5 gün sonra veri var mı?)
         if (idx + 5 < cArr.length) {
            ret5d = (cArr[idx + 5] - basePrice) / basePrice;
         }
         
         // -5 Günlük Getiri (Haberden önceki hareket - Priced In kontrolü)
         if (idx - 5 >= 0) {
            retPre5 = (basePrice - cArr[idx - 5]) / cArr[idx - 5];
         }
       }
    }

    // Skoru Hesapla
    const { score, pricedIn } = scoreFromRet(ret5d, ret1d, retPre5);

    // Sonucu Döndür
    return {
      symbol,
      headline: item.headline,
      type: item.category,
      publishedAt: new Date(item.datetime * 1000).toISOString(),
      url: item.url,
      score,     // Artık 50-100 arası değişecek
      pricedIn,  // True/False
      ret1d,     // Örn: 0.02 (%2)
      ret5d,     // Örn: -0.05 (-%5)
      retPre5
    };

  } catch (e) {
    console.error(`Error processing ${symbol}:`, e);
    return null;
  }
}

// --- ANA API HANDLER (GET) ---

export async function GET() {
  try {
    if (!FINNHUB_API_KEY) {
        return NextResponse.json({ error: "API Key Missing" }, { status: 500 });
    }

    // Tüm hisseleri paralel olarak çek
    const promises = SYMBOLS.map(sym => fetchStockData(sym));
    const results = await Promise.all(promises);

    // Boş sonuçları temizle (null olanlar)
    const flatResults = results.filter(item => item !== null);

    // Skora göre sırala (En yüksek puan en üstte)
    flatResults.sort((a, b) => (b?.score || 0) - (a?.score || 0));

    return NextResponse.json({
      asOf: new Date().toISOString(),
      items: flatResults
    });

  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
