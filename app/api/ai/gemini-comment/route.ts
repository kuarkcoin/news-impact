// app/api/ai/gemini-comment/route.ts
import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const maxDuration = 30;

type Body = {
  symbol: string;
  headline: string;
  type?: string | null;
  technicalContext?: string | null;
  expectedImpact?: number | null;
  score?: number | null;
};

function safeStr(x: any, max = 500) {
  const s = String(x ?? "").replace(/\s+/g, " ").trim();
  return s.length > max ? s.slice(0, max) + "…" : s;
}

export async function POST(req: Request) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) {
    return NextResponse.json({ error: "Missing GEMINI_API_KEY" }, { status: 500 });
  }

  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const symbol = safeStr(body.symbol, 20);
  const headline = safeStr(body.headline, 260);
  const type = safeStr(body.type ?? "General", 40);
  const tech = safeStr(body.technicalContext ?? "", 260);
  const expectedImpact = typeof body.expectedImpact === "number" ? body.expectedImpact : null;
  const score = typeof body.score === "number" ? body.score : null;

  if (!symbol || !headline) {
    return NextResponse.json({ error: "symbol & headline required" }, { status: 400 });
  }

  // Gemini REST (x-goog-api-key header ile)
  // Docs: https://ai.google.dev/gemini-api/docs  (REST örneği)
  const model = "gemini-2.5-flash";
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;

  const prompt = `
Sen finans haberlerini yorumlayan bir analistsin ama "yatırım tavsiyesi" vermezsin.
Bana aşağıdaki haber için Türkçe 5 adet kısa yorum üret:

Kurallar:
- Her yorum 1-2 cümle olsun.
- Jargon az, net ve okunur olsun.
- 1. yorum: "katalizör" (haber neyi tetikliyor?)
- 2. yorum: "priced-in riski" (fiyatlamış olabilir mi?)
- 3. yorum: "teknik bağlam" (trend/RSI/breakout/support gibi)
- 4. yorum: "risk" (olumsuz senaryo)
- 5. yorum: "takip edilecek metrik" (earnings, guidance, margin, user growth vs.)
- Kesin emir verme: "al/sat" gibi direktif yok.
- Sonda tek satır uyarı ekle: "Not: Yatırım tavsiyesi değildir."

Veri:
Sembol: ${symbol}
Başlık: ${headline}
Kategori: ${type}
Teknik Context: ${tech || "—"}
ExpectedImpact: ${expectedImpact ?? "—"}
Score: ${score ?? "—"}

Çıktı formatı:
JSON ONLY:
{"comments":["...","...","...","...","..."]}
`.trim();

  try {
    const r = await fetch(url, {
      method: "POST",
      headers: {
        "x-goog-api-key": key,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        contents: [
          { parts: [{ text: prompt }] }
        ],
        generationConfig: {
          temperature: 0.7,
          maxOutputTokens: 400,
        },
      }),
    });

    if (!r.ok) {
      const t = await r.text().catch(() => "");
      return NextResponse.json(
        { error: `Gemini error (${r.status})`, detail: t.slice(0, 800) },
        { status: 502 }
      );
    }

    const data = await r.json();

    // Gemini response -> text çek
    const text =
      data?.candidates?.[0]?.content?.parts?.map((p: any) => p?.text).filter(Boolean).join("\n") ?? "";

    // JSON parse dene
    let parsed: any = null;
    try {
      parsed = JSON.parse(text);
    } catch {
      // bazen model JSON dışında döner; basit kurtarma
      const m = text.match(/\{[\s\S]*\}/);
      if (m) {
        try { parsed = JSON.parse(m[0]); } catch {}
      }
    }

    const comments: string[] =
      Array.isArray(parsed?.comments) ? parsed.comments.map((s: any) => safeStr(s, 220)) : [];

    if (comments.length !== 5) {
      // fallback: tek texti satırlara böl
      const lines = text.split("\n").map((x: string) => x.trim()).filter(Boolean);
      const guess = lines.filter((x: string) => x.length >= 10).slice(0, 5).map((x: string) => safeStr(x, 220));
      return NextResponse.json({ comments: guess, raw: safeStr(text, 900) }, { status: 200 });
    }

    return NextResponse.json({ comments }, { status: 200 });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || "Gemini request failed" }, { status: 500 });
  }
}
