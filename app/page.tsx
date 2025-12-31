'use client';

import React, { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';

/* ================= TYPES ================= */
type LeaderboardItem = {
  symbol: string;
  headline: string;
  type?: string | null;
  publishedAt: string;
  score: number;
  pricedIn?: boolean | null;
  retPre5?: number | null;
  ret1d?: number | null;
  ret5d?: number | null;
  url?: string | null;
};

type LeaderboardResponse = {
  asOf: string;
  range?: { min: number; max: number };
  items: LeaderboardItem[];
};

/* ================= HELPERS ================= */
function fmtPct(x: number | null | undefined) {
  if (typeof x !== 'number') return '—';
  const v = x * 100;
  const sign = v > 0 ? '+' : '';
  return `${sign}${v.toFixed(2)}%`;
}

function scoreBadge(score: number) {
  if (score >= 80) return 'bg-emerald-500/10 text-emerald-300 border-emerald-500/20';
  if (score >= 65) return 'bg-amber-500/10 text-amber-300 border-amber-500/20';
  return 'bg-slate-500/10 text-slate-300 border-slate-500/20';
}

function pricedInBadge(v: boolean | null | undefined) {
  if (v === true) return { txt: '✅ Priced-in', cls: 'bg-slate-500/10 text-slate-300 border-slate-500/20' };
  if (v === false) return { txt: '🔥 Not priced', cls: 'bg-emerald-500/10 text-emerald-300 border-emerald-500/20' };
  return { txt: '—', cls: 'bg-slate-500/10 text-slate-300 border-slate-500/20' };
}

/* ================= PAGE ================= */
export default function HomePage() {
  const [data, setData] = useState<LeaderboardResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  const [minScore, setMinScore] = useState(50);
  const [limit, setLimit] = useState(30);
  const [q, setQ] = useState('');

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        setLoading(true);
        setErr(null);
        const res = await fetch(`/api/leaderboard?min=${minScore}&limit=${limit}`, { cache: 'no-store' });
        const json = await res.json();
        if (!res.ok) throw new Error(json?.error || 'API error');
        if (alive) setData(json);
      } catch (e: any) {
        if (alive) setErr(e?.message || 'Unknown error');
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, [minScore, limit]);

  const filtered = useMemo(() => {
    const items = data?.items || [];
    const qq = q.trim().toLowerCase();
    if (!qq) return items;
    return items.filter((it) =>
      [it.symbol, it.headline, it.type].join(' ').toLowerCase().includes(qq)
    );
  }, [data, q]);

  const top3 = filtered.slice(0, 3);

  /* ================= RENDER ================= */
  return (
    <div className="min-h-screen bg-slate-950 text-white">
      {/* HERO */}
      <section className="max-w-6xl mx-auto px-4 pt-10 pb-6">
        <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full text-[11px] font-black uppercase bg-white/5 border border-white/10">
          📈 Nasdaq-100 News Impact
        </div>

        <h1 className="text-4xl md:text-5xl font-black mt-4">
          How markets react to news — <span className="text-emerald-300">measured.</span>
        </h1>

        <p className="text-slate-300 max-w-2xl mt-3">
          We track Nasdaq news and rank events by real post-news price reactions.
        </p>

        {/* LIVE STATS */}
        <div className="mt-6 grid grid-cols-2 sm:grid-cols-4 gap-4">
          <Stat label="News events" value={data?.items.length ?? 0} />
          <Stat label="High impact (≥80)" value={(data?.items || []).filter(i => i.score >= 80).length} accent />
          <Stat
            label="Avg score"
            value={
              data?.items.length
                ? Math.round(data.items.reduce((a, b) => a + b.score, 0) / data.items.length)
                : '—'
            }
          />
          <Stat label="Tracked tickers" value="100" />
        </div>
      </section>

      {/* LEADERBOARD */}
      <section id="leaderboard" className="max-w-6xl mx-auto px-4 pb-16">
        <div className="rounded-3xl bg-white/5 border border-white/10 overflow-hidden">
          {/* CONTROLS */}
          <div className="p-5 flex flex-col md:flex-row gap-4 md:items-center md:justify-between">
            <div>
              <div className="text-xl font-black">Top News Impact</div>
              <div className="text-xs text-slate-400">
                {data?.asOf ? `As of ${new Date(data.asOf).toLocaleString()}` : 'Live'}
              </div>
            </div>

            <div className="flex flex-wrap gap-2">
              <input
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="Search ticker or keyword"
                className="px-4 py-2 rounded-xl bg-slate-900 border border-white/10"
              />
              <select value={minScore} onChange={(e) => setMinScore(+e.target.value)} className="px-3 py-2 rounded-xl bg-slate-900 border border-white/10">
                {[50, 60, 70, 80].map(v => <option key={v} value={v}>Score ≥ {v}</option>)}
              </select>
              <select value={limit} onChange={(e) => setLimit(+e.target.value)} className="px-3 py-2 rounded-xl bg-slate-900 border border-white/10">
                {[20, 30, 50, 100].map(v => <option key={v} value={v}>Top {v}</option>)}
              </select>
            </div>
          </div>

          {/* TOP 3 */}
          {top3.length > 0 && (
            <div className="grid sm:grid-cols-3 gap-4 px-5 pb-4">
              {top3.map(it => (
                <div key={it.symbol} className="rounded-2xl bg-emerald-500/10 border border-emerald-500/20 p-4">
                  <div className="text-xs font-black text-emerald-300">TOP IMPACT</div>
                  <div className="text-lg font-black">{it.symbol}</div>
                  <div className="text-sm text-slate-200 mt-1">{it.headline}</div>
                  <div className="mt-2 text-xs text-slate-300">Score: {it.score}</div>
                </div>
              ))}
            </div>
          )}

          {/* TABLE */}
          <div className="px-5 pb-6">
            {loading && <div className="py-10 text-center text-slate-300">Loading…</div>}
            {!loading && err && <div className="py-6 text-red-300">{err}</div>}
            {!loading && !err && filtered.length === 0 && (
              <div className="py-10 text-center">
                <div className="text-lg font-black">No high-impact news yet</div>
                <div className="text-slate-400 mt-2">Markets are calm. Try lowering the score.</div>
              </div>
            )}

            {!loading && !err && filtered.length > 0 && (
              <table className="w-full text-sm">
                <thead className="text-slate-400 border-b border-white/10">
                  <tr>
                    <th>#</th><th>Ticker</th><th>Headline</th><th>Score</th><th>+1D</th><th>+5D</th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((it, i) => {
                    const p = pricedInBadge(it.pricedIn);
                    return (
                      <tr key={i} className="border-b border-white/5">
                        <td>{i + 1}</td>
                        <td>
                          <Link href={`/ticker/${it.symbol}`} className="text-emerald-300 font-black hover:underline">
                            {it.symbol}
                          </Link>
                        </td>
                        <td>{it.headline}</td>
                        <td><span className={`px-2 py-1 rounded-full border ${scoreBadge(it.score)}`}>{it.score}</span></td>
                        <td>{fmtPct(it.ret1d)}</td>
                        <td>{fmtPct(it.ret5d)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </div>
        </div>
      </section>
    </div>
  );
}

/* ================= COMPONENTS ================= */
function Stat({ label, value, accent }: { label: string; value: any; accent?: boolean }) {
  return (
    <div className="rounded-2xl bg-white/5 border border-white/10 p-4">
      <div className="text-xs text-slate-400">{label}</div>
      <div className={`text-2xl font-black ${accent ? 'text-emerald-300' : ''}`}>{value}</div>
    </div>
  );
}
