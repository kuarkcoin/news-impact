'use client';

import React, { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';

type LeaderboardItem = {
  symbol: string;
  headline: string;
  type?: string | null;
  publishedAt: string; // ISO
  score: number; // 50..100
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

        const res = await fetch(`/api/leaderboard?min=${minScore}&limit=${limit}`, {
          cache: 'no-store',
        });

        const json = (await res.json().catch(() => ({}))) as any;
        if (!res.ok) throw new Error(json?.error || `API error: ${res.status}`);

        if (alive) setData(json as LeaderboardResponse);
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
    return items.filter((it) => {
      const a = it.symbol?.toLowerCase() || '';
      const b = it.headline?.toLowerCase() || '';
      const c = (it.type || '')?.toLowerCase() || '';
      return a.includes(qq) || b.includes(qq) || c.includes(qq);
    });
  }, [data, q]);

  return (
    <div className="min-h-screen bg-slate-950 text-white">
      {/* HERO */}
      <section className="w-full max-w-6xl mx-auto px-4 pt-10 pb-6">
        <div className="flex flex-col gap-4">
          <div className="inline-flex items-center gap-2 w-fit px-3 py-1 rounded-full text-[11px] font-black uppercase tracking-wider bg-white/5 border border-white/10 text-slate-200">
            📈 Nasdaq-100 News Impact • Data-driven
          </div>

          <h1 className="text-3xl sm:text-4xl md:text-5xl font-black leading-tight">
            See how markets react to news — <span className="text-emerald-300">in real data.</span>
          </h1>

          <p className="text-slate-300 max-w-2xl">
            We scan Nasdaq-100 news and rank events by a simple 50–100 impact score.
            If a move was already priced in, the score drops.
          </p>

          <div className="flex flex-col sm:flex-row gap-3 pt-2">
            <a
              href="#leaderboard"
              className="inline-flex items-center justify-center px-6 py-3 rounded-2xl bg-emerald-400 text-slate-950 font-black hover:opacity-95 transition"
            >
              View Today’s Top Impact →
            </a>

            <Link
              href="/methodology"
              className="inline-flex items-center justify-center px-6 py-3 rounded-2xl bg-white/5 border border-white/10 text-white font-bold hover:bg-white/10 transition"
            >
              How scoring works
            </Link>
          </div>
        </div>
      </section>

      {/* CONTROLS */}
      <section id="leaderboard" className="w-full max-w-6xl mx-auto px-4 pb-16">
        <div className="rounded-3xl bg-white/5 border border-white/10 shadow-xl overflow-hidden">
          <div className="p-5 md:p-6 flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
            <div>
              <div className="text-xl font-black">Top News Impact</div>
              <div className="text-xs text-slate-300 mt-1">
                {data?.asOf ? `As of ${new Date(data.asOf).toLocaleString()}` : 'Live ranking'}
              </div>
            </div>

            <div className="flex flex-col sm:flex-row gap-3 sm:items-center">
              <input
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="Search: AAPL, earnings, upgrade..."
                className="w-full sm:w-72 px-4 py-2 rounded-2xl bg-slate-900/70 border border-white/10 text-sm outline-none focus:border-emerald-400/40"
              />

              <div className="flex gap-2">
                <select
                  value={minScore}
                  onChange={(e) => setMinScore(Number(e.target.value))}
                  className="px-3 py-2 rounded-2xl bg-slate-900/70 border border-white/10 text-sm outline-none"
                >
                  <option value={50}>Score ≥ 50</option>
                  <option value={60}>Score ≥ 60</option>
                  <option value={70}>Score ≥ 70</option>
                  <option value={80}>Score ≥ 80</option>
                </select>

                <select
                  value={limit}
                  onChange={(e) => setLimit(Number(e.target.value))}
                  className="px-3 py-2 rounded-2xl bg-slate-900/70 border border-white/10 text-sm outline-none"
                >
                  <option value={20}>Top 20</option>
                  <option value={30}>Top 30</option>
                  <option value={50}>Top 50</option>
                  <option value={100}>Top 100</option>
                </select>
              </div>
            </div>
          </div>

          {/* TABLE */}
          <div className="px-5 md:px-6 pb-6">
            {loading && (
              <div className="py-10 text-center text-slate-300">
                <div className="inline-block w-10 h-10 border-4 border-white/10 border-t-emerald-400 rounded-full animate-spin" />
                <div className="mt-4 text-sm font-semibold">Loading leaderboard…</div>
              </div>
            )}

            {!loading && err && (
              <div className="py-8 rounded-2xl bg-red-500/10 border border-red-500/20 text-red-200 px-4">
                <div className="font-black">API error</div>
                <div className="text-sm mt-1">{err}</div>
              </div>
            )}

            {!loading && !err && filtered.length === 0 && (
              <div className="py-10 text-center text-slate-300">
                No items found. Try lowering the score filter.
              </div>
            )}

            {!loading && !err && filtered.length > 0 && (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="text-slate-300">
                    <tr className="border-b border-white/10">
                      <th className="text-left py-3 pr-3">#</th>
                      <th className="text-left py-3 pr-3">Ticker</th>
                      <th className="text-left py-3 pr-3">Headline</th>
                      <th className="text-left py-3 pr-3">Type</th>
                      <th className="text-left py-3 pr-3">Score</th>
                      <th className="text-left py-3 pr-3">Priced-in</th>
                      <th className="text-left py-3 pr-3">+1D</th>
                      <th className="text-left py-3 pr-3">+5D</th>
                    </tr>
                  </thead>

                  <tbody>
                    {filtered.map((it, idx) => {
                      const p = pricedInBadge(it.pricedIn ?? null);
                      return (
                        <tr key={`${it.symbol}-${it.publishedAt}-${idx}`} className="border-b border-white/5">
                          <td className="py-4 pr-3 text-slate-400">{idx + 1}</td>

                          <td className="py-4 pr-3">
                            <Link
                              href={`/ticker/${encodeURIComponent(it.symbol)}`}
                              className="font-black text-emerald-300 hover:underline"
                            >
                              {it.symbol}
                            </Link>
                          </td>

                          <td className="py-4 pr-3 min-w-[360px]">
                            <div className="font-semibold text-white/90">{it.headline}</div>
                            <div className="text-[11px] text-slate-400 mt-1">
                              {new Date(it.publishedAt).toLocaleString()}
                              {it.url ? (
                                <>
                                  {' '}
                                  ·{' '}
                                  <a
                                    href={it.url}
                                    target="_blank"
                                    rel="noreferrer"
                                    className="text-slate-300 hover:underline"
                                  >
                                    source
                                  </a>
                                </>
                              ) : null}
                            </div>
                          </td>

                          <td className="py-4 pr-3">
                            <span className="inline-flex items-center px-2 py-1 rounded-full text-[11px] font-black bg-white/5 border border-white/10 text-slate-200">
                              {it.type || 'General'}
                            </span>
                          </td>

                          <td className="py-4 pr-3">
                            <span
                              className={`inline-flex items-center px-2.5 py-1 rounded-full text-[11px] font-black border ${scoreBadge(
                                it.score
                              )}`}
                            >
                              {it.score}
                            </span>
                          </td>

                          <td className="py-4 pr-3">
                            <span className={`inline-flex items-center px-2.5 py-1 rounded-full text-[11px] font-black border ${p.cls}`}>
                              {p.txt}
                            </span>
                          </td>

                          <td className="py-4 pr-3 text-slate-200">{fmtPct(it.ret1d)}</td>
                          <td className="py-4 pr-3 text-slate-200">{fmtPct(it.ret5d)}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}

            {/* Method box */}
            <div className="mt-6 rounded-2xl bg-slate-900/50 border border-white/10 p-4 text-slate-200">
              <div className="font-black">How is the score calculated?</div>
              <div className="text-sm text-slate-300 mt-1">
                We measure post-news returns (+1D/+5D), compare against similar historical events, and reduce the score if
                price moved strongly <em>before</em> the news (priced-in penalty).
              </div>
            </div>
          </div>
        </div>

        <div className="text-[11px] text-slate-400 mt-6">
          Disclaimer: This is not financial advice. Scores are informational and based on historical price reactions.
        </div>
      </section>
    </div>
  );
}
