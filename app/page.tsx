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

/* ================= PAGE ================= */
export default function HomePage() {
  const [data, setData] = useState<LeaderboardResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  const [minScore, setMinScore] = useState(50);
  const [limit, setLimit] = useState(30);
  const [q, setQ] = useState('');

  // ✅ Yeni: UI sort
  const [sortBy, setSortBy] = useState<'score' | 'newest'>('score');

  // ✅ Yeni: Üstte kaç tane kart gösterelim?
  const [topN, setTopN] = useState(10);

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
    return () => { alive = false; };
  }, [minScore, limit]);

  const filtered = useMemo(() => {
    const items = data?.items || [];
    const qq = q.trim().toLowerCase();

    const searched = !qq
      ? items
      : items.filter((it) => [it.symbol, it.headline, it.type].join(' ').toLowerCase().includes(qq));

    // ✅ UI sort: skor veya en yeni
    const sorted = [...searched].sort((a, b) => {
      if (sortBy === 'newest') {
        return new Date(b.publishedAt).getTime() - new Date(a.publishedAt).getTime();
      }
      // default score
      return b.score - a.score;
    });

    return sorted;
  }, [data, q, sortBy]);

  const topCards = filtered.slice(0, topN);

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

              <select
                value={sortBy}
                onChange={(e) => setSortBy(e.target.value as any)}
                className="px-3 py-2 rounded-xl bg-slate-900 border border-white/10"
                title="Sort"
              >
                <option value="score">Sort: Highest score</option>
                <option value="newest">Sort: Newest first</option>
              </select>

              <select
                value={minScore}
                onChange={(e) => setMinScore(+e.target.value)}
                className="px-3 py-2 rounded-xl bg-slate-900 border border-white/10"
              >
                {[40, 50, 60, 70, 80].map(v => (
                  <option key={v} value={v}>Score ≥ {v}</option>
                ))}
              </select>

              <select
                value={limit}
                onChange={(e) => setLimit(+e.target.value)}
                className="px-3 py-2 rounded-xl bg-slate-900 border border-white/10"
              >
                {[20, 30, 50, 100].map(v => (
                  <option key={v} value={v}>Top {v}</option>
                ))}
              </select>

              <select
                value={topN}
                onChange={(e) => setTopN(+e.target.value)}
                className="px-3 py-2 rounded-xl bg-slate-900 border border-white/10"
                title="Top cards"
              >
                {[3, 6, 10, 12].map(v => (
                  <option key={v} value={v}>Cards: {v}</option>
                ))}
              </select>
            </div>
          </div>

          {/* TOP CARDS */}
          {topCards.length > 0 && (
            <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4 px-5 pb-4">
              {topCards.map((it) => (
                <Link
                  key={`${it.symbol}-${it.publishedAt}`}
                  href={`/ticker/${it.symbol}`}
                  className="block rounded-2xl bg-emerald-500/10 border border-emerald-500/20 p-4 hover:bg-emerald-500/15 transition"
                >
                  <div className="flex items-center justify-between gap-2">
                    <div className="text-xs font-black text-emerald-300">TOP IMPACT</div>
                    <span className={`px-2 py-1 text-xs rounded-full border ${scoreBadge(it.score)}`}>
                      {it.score}
                    </span>
                  </div>

                  <div className="text-lg font-black mt-1">{it.symbol}</div>
                  <div className="text-sm text-slate-200 mt-1 line-clamp-3">{it.headline}</div>

                  <div className="mt-3 text-xs text-slate-400">
                    {new Date(it.publishedAt).toLocaleString()}
                  </div>

                  {it.url && (
                    <div className="mt-2 text-xs text-slate-300 underline underline-offset-4">
                      Source link available →
                    </div>
                  )}
                </Link>
              ))}
            </div>
          )}

          {/* TABLE */}
          <div className="px-5 pb-6">
            {loading && <div className="py-10 text-center text-slate-300">Loading…</div>}
            {!loading && err && <div className="py-6 text-red-300">{err}</div>}
            {!loading && !err && filtered.length === 0 && (
              <div className="py-10 text-center">
                <div className="text-lg font-black">No results</div>
                <div className="text-slate-400 mt-2">Try lowering the score or changing sort.</div>
              </div>
            )}

            {!loading && !err && filtered.length > 0 && (
              <table className="w-full text-sm">
                <thead className="text-slate-400 border-b border-white/10">
                  <tr>
                    <th className="text-left py-2">#</th>
                    <th className="text-left py-2">Ticker</th>
                    <th className="text-left py-2">Headline</th>
                    <th className="text-left py-2">Score</th>
                    <th className="text-left py-2">+1D</th>
                    <th className="text-left py-2">+5D</th>
                    <th className="text-left py-2">Published</th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((it, i) => (
                    <tr key={`${it.symbol}-${it.publishedAt}-${i}`} className="border-b border-white/5">
                      <td className="py-2">{i + 1}</td>
                      <td className="py-2">
                        <Link href={`/ticker/${it.symbol}`} className="text-emerald-300 font-black hover:underline">
                          {it.symbol}
                        </Link>
                      </td>
                      <td className="py-2">{it.headline}</td>
                      <td className="py-2">
                        <span className={`px-2 py-1 rounded-full border ${scoreBadge(it.score)}`}>{it.score}</span>
                      </td>
                      <td className="py-2">{fmtPct(it.ret1d)}</td>
                      <td className="py-2">{fmtPct(it.ret5d)}</td>
                      <td className="py-2 text-slate-400">{new Date(it.publishedAt).toLocaleString()}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>

          {/* FOOTER NOTE */}
          <div className="px-5 pb-5 text-xs text-slate-500">
            Tip: If you always see the same tickers, switch Sort to “Newest first” or lower Score.
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
