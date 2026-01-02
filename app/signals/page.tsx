'use client';

import React, { useEffect, useMemo, useState } from "react";

type TvSignal = {
  symbol: string;
  exchange?: string;
  time?: string;
  price?: number | null;
  signal?: string; // "AL" | "SAT"
  score?: number | null;
  tf?: string;
};

type ApiResp = { asOf: string; items: TvSignal[] };

function fmtPrice(x: number | null | undefined) {
  if (typeof x !== "number") return "—";
  return x.toFixed(2);
}

function fmtTime(s: string | undefined) {
  if (!s) return "—";
  // TradingView {{time}} bazen "2026-01-02T..." gibi gelir, bazen farklı.
  // Güvenli: parse edilemezse olduğu gibi bas.
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return s;
  return d.toLocaleString();
}

export default function SignalsPage() {
  const [data, setData] = useState<ApiResp | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  const [q, setQ] = useState("");
  const [only, setOnly] = useState<"ALL" | "AL" | "SAT">("ALL");
  const [limit, setLimit] = useState(50);

  async function load() {
    const controller = new AbortController();
    try {
      setLoading(true);
      setErr(null);

      const res = await fetch("/api/tv/signals", {
        cache: "no-store",
        signal: controller.signal,
      });

      const json = (await res.json()) as ApiResp;
      if (!res.ok) throw new Error((json as any)?.error || "API error");
      setData(json);
    } catch (e: any) {
      if (e?.name !== "AbortError") setErr(e?.message || "Unknown error");
    } finally {
      setLoading(false);
    }
    return () => controller.abort();
  }

  useEffect(() => {
    let cleanup: any;
    (async () => (cleanup = await load()))();
    return () => cleanup?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const filtered = useMemo(() => {
    const items = data?.items || [];
    const qq = q.trim().toLowerCase();

    let arr = items;

    if (only !== "ALL") {
      arr = arr.filter((x) => (x.signal || "").toUpperCase() === only);
    }
    if (qq) {
      arr = arr.filter((x) =>
        `${x.symbol} ${x.exchange || ""} ${x.signal || ""} ${x.tf || ""}`
          .toLowerCase()
          .includes(qq)
      );
    }
    return arr.slice(0, limit);
  }, [data, q, only, limit]);

  return (
    <div className="min-h-screen bg-slate-950 text-white">
      <div className="max-w-6xl mx-auto px-4 py-10">
        {/* HEADER */}
        <div className="flex items-start justify-between gap-4">
          <div>
            <h1 className="text-3xl font-black">TradingView Sinyalleri</h1>
            <div className="text-sm text-slate-400 mt-1">
              {data?.asOf ? `As of ${new Date(data.asOf).toLocaleString()}` : "—"}
            </div>
          </div>

          <button
            onClick={load}
            className="shrink-0 inline-flex items-center gap-2 px-4 py-2 rounded-xl bg-white/5 border border-white/10 hover:bg-white/10"
            title="Yenile"
          >
            🔄 <span className="font-black text-sm">Yenile</span>
          </button>
        </div>

        {/* CONTROLS */}
        <div className="mt-6 flex flex-wrap gap-2 items-center">
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Ara: AAPL / NVDA / AL / SAT"
            className="px-4 py-2 rounded-xl bg-slate-900 border border-white/10 w-full sm:w-72"
          />

          <select
            value={only}
            onChange={(e) => setOnly(e.target.value as any)}
            className="px-3 py-2 rounded-xl bg-slate-900 border border-white/10"
          >
            <option value="ALL">Hepsi</option>
            <option value="AL">Sadece AL</option>
            <option value="SAT">Sadece SAT</option>
          </select>

          <select
            value={limit}
            onChange={(e) => setLimit(parseInt(e.target.value, 10))}
            className="px-3 py-2 rounded-xl bg-slate-900 border border-white/10"
          >
            {[20, 50, 100, 200].map((v) => (
              <option key={v} value={v}>
                İlk {v}
              </option>
            ))}
          </select>
        </div>

        {/* BODY */}
        <div className="mt-6 rounded-3xl bg-white/5 border border-white/10 overflow-hidden">
          {loading && <div className="p-10 text-center text-slate-300">Loading…</div>}
          {!loading && err && <div className="p-6 text-red-300">{err}</div>}

          {!loading && !err && filtered.length === 0 && (
            <div className="p-10 text-center">
              <div className="text-xl font-black">Sinyal yok</div>
              <div className="text-slate-400 mt-2">
                TradingView alert tetiklenmemiş olabilir veya secret uyuşmuyor.
              </div>
            </div>
          )}

          {!loading && !err && filtered.length > 0 && (
            <div className="overflow-x-auto">
              <table className="min-w-[900px] w-full text-sm">
                <thead className="text-slate-400 border-b border-white/10">
                  <tr>
                    <th className="text-left py-3 px-4">#</th>
                    <th className="text-left py-3 px-4">Symbol</th>
                    <th className="text-left py-3 px-4">Signal</th>
                    <th className="text-left py-3 px-4">TF</th>
                    <th className="text-left py-3 px-4">Price</th>
                    <th className="text-left py-3 px-4">Score</th>
                    <th className="text-left py-3 px-4">Time</th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((it, idx) => (
                    <tr key={`${it.symbol}-${it.time}-${idx}`} className="border-b border-white/5">
                      <td className="py-3 px-4 text-slate-400">{idx + 1}</td>
                      <td className="py-3 px-4 font-black">{it.symbol}</td>
                      <td className="py-3 px-4">
                        <span
                          className={`px-2 py-1 rounded-full border ${
                            (it.signal || "").toUpperCase() === "AL"
                              ? "bg-emerald-500/10 text-emerald-300 border-emerald-500/20"
                              : "bg-rose-500/10 text-rose-300 border-rose-500/20"
                          }`}
                        >
                          {(it.signal || "—").toUpperCase()}
                        </span>
                      </td>
                      <td className="py-3 px-4">{it.tf || "—"}</td>
                      <td className="py-3 px-4">{fmtPrice(it.price)}</td>
                      <td className="py-3 px-4">{typeof it.score === "number" ? it.score : "—"}</td>
                      <td className="py-3 px-4 text-slate-300">{fmtTime(it.time)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <div className="p-4 text-xs text-slate-500">
            Not: Bu sayfa sadece TradingView webhook ile gelen sinyalleri gösterir.
          </div>
        </div>
      </div>
    </div>
  );
}