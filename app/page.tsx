'use client';

import React, { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';

type LeaderboardItem = {
  symbol: string;
  headline: string;
  type?: string | null;
  publishedAt: string; // ISO
  score: number; // 0..100 or 50..100

  pricedIn?: boolean | null;
  retPre5?: number | null;
  ret1d?: number | null;
  ret5d?: number | null;
  url?: string | null;

  // from scan pool
  expectedImpact?: number;
  realizedImpact?: number;
  confidence?: number;
  tooEarly?: boolean;
  technicalContext?: string | null;

  rsi14?: number | null;
  breakout20?: boolean | null;
  volumeSpike?: boolean | null;
  bullTrap?: boolean | null;

  expectedDir?: -1 | 0 | 1;
  realizedDir?: -1 | 0 | 1;

  aiSummary?: string | null;
  aiBullets?: string[] | null;
  aiSentiment?: 'bullish' | 'bearish' | 'mixed' | 'neutral' | null;

  // ✅ leaderboard route ekledi (UI için)
  signals?: string[] | null;
  signalsText?: string | null;
};

type LeaderboardResponse = {
  asOf: string;
  range?: { min: number; max: number };
  items: LeaderboardItem[];
};

function clampInt(n: number, a: number, b: number) {
  return Math.max(a, Math.min(b, n));
}

function fmtDate(iso: string) {
  try {
    const d = new Date(iso);
    return d.toLocaleString();
  } catch {
    return iso;
  }
}

function fmtPct(x: number | null | undefined) {
  if (typeof x !== 'number' || Number.isNaN(x)) return '—';
  const v = x * 100;
  const sign = v > 0 ? '+' : '';
  return `${sign}${v.toFixed(2)}%`;
}

function pctColor(x: number | null | undefined) {
  if (typeof x !== 'number') return 'text-slate-300';
  if (x > 0.001) return 'text-emerald-300';
  if (x < -0.001) return 'text-rose-300';
  return 'text-slate-300';
}

function scoreTone(score: number) {
  if (score >= 85)
    return {
      pill: 'bg-emerald-400/15 text-emerald-200 border-emerald-400/25',
      ring: 'ring-emerald-400/30',
    };
  if (score >= 70)
    return {
      pill: 'bg-cyan-400/15 text-cyan-200 border-cyan-400/25',
      ring: 'ring-cyan-400/30',
    };
  if (score >= 60)
    return {
      pill: 'bg-amber-400/15 text-amber-200 border-amber-400/25',
      ring: 'ring-amber-400/30',
    };
  return {
    pill: 'bg-slate-400/10 text-slate-200 border-white/10',
    ring: 'ring-white/10',
  };
}

function pricedInUI(v: boolean | null | undefined) {
  if (v === false)
    return {
      txt: '🔥 Not priced-in',
      cls: 'bg-emerald-400/15 text-emerald-200 border-emerald-400/25',
    };
  if (v === true)
    return {
      txt: '⚠️ Mostly priced-in',
      cls: 'bg-amber-400/15 text-amber-200 border-amber-400/25',
    };
  return { txt: '— Unclear', cls: 'bg-white/5 text-slate-200 border-white/10' };
}

function impactLabel(score: number) {
  if (score >= 85) return 'TOP IMPACT';
  if (score >= 70) return 'HIGH IMPACT';
  if (score >= 60) return 'MED IMPACT';
  return 'LOW IMPACT';
}

function impactBarWidth(score: number) {
  // 50..100 -> 0..100 gibi
  const w = (score - 50) * 2;
  return clampInt(w, 0, 100);
}

function MiniBar({
  label,
  value,
  dimIfNull = false,
}: {
  label: string;
  value: number | null | undefined;
  dimIfNull?: boolean;
}) {
  if (typeof value !== 'number') {
    return (
      <div className={`space-y-1 ${dimIfNull ? 'opacity-60' : ''}`}>
        <div className="flex items-center justify-between text-[11px] text-slate-400">
          <span className="font-bold">{label}</span>
          <span className="font-black">—</span>
        </div>
        <div className="h-2 rounded-full bg-white/10 overflow-hidden">
          <div className="h-full w-0" />
        </div>
      </div>
    );
  }

  const clamped = clampInt(Math.round(value), 0, 100);
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between text-[11px] text-slate-300">
        <span className="font-bold">{label}</span>
        <span className="font-black">{clamped}%</span>
      </div>
      <div className="h-2 rounded-full bg-white/10 overflow-hidden">
        <div
          className="h-full bg-emerald-400/80 transition-all"
          style={{ width: `${clamped}%` }}
        />
      </div>
    </div>
  );
}

function ConfidenceBar({ value }: { value: number | null | undefined }) {
  const v = typeof value === 'number' ? clampInt(Math.round(value), 0, 100) : 0;
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between text-[11px] text-slate-300">
        <span className="font-bold">Confidence</span>
        <span className="font-black">{v}%</span>
      </div>
      <div className="h-2 rounded-full bg-white/10 overflow-hidden">
        <div className="h-full bg-cyan-400/80 transition-all" style={{ width: `${v}%` }} />
      </div>
    </div>
  );
}

function SkeletonCard() {
  return (
    <div className="rounded-3xl bg-white/5 border border-white/10 p-5 animate-pulse">
      <div className="flex items-start justify-between gap-4">
        <div className="h-5 w-24 bg-white/10 rounded-lg" />
        <div className="h-8 w-12 bg-white/10 rounded-2xl" />
      </div>
      <div className="mt-4 h-8 w-20 bg-white/10 rounded-xl" />
      <div className="mt-3 h-4 w-full bg-white/10 rounded-lg" />
      <div className="mt-2 h-4 w-4/5 bg-white/10 rounded-lg" />
      <div className="mt-5 h-2 w-full bg-white/10 rounded-full" />
      <div className="mt-4 flex gap-2">
        <div className="h-7 w-24 bg-white/10 rounded-full" />
        <div className="h-7 w-24 bg-white/10 rounded-full" />
      </div>
    </div>
  );
}

type SortKey = 'score' | 'newest' | 'ret5d';

export default function HomePage() {
  const [data, setData] = useState<LeaderboardResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  const [minScore, setMinScore] = useState(50);
  const [limit, setLimit] = useState(30);
  const [q, setQ] = useState('');
  const [sort, setSort] = useState<SortKey>('score');
  const [view, setView] = useState<'grid' | 'list'>('grid');
  const [perPage, setPerPage] = useState(10);

  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    const controller = new AbortController();

    (async () => {
      try {
        setLoading(true);
        setErr(null);

        const res = await fetch(
          `/api/leaderboard?min=${minScore}&limit=${limit}&sort=${sort}&q=${encodeURIComponent(q)}`,
          { cache: 'no-store', signal: controller.signal }
        );

        const json = (await res.json().catch(() => ({}))) as any;
        if (!res.ok) throw new Error(json?.error || `API error: ${res.status}`);

        setData(json as LeaderboardResponse);
      } catch (e: any) {
        if (e?.name !== 'AbortError') setErr(e?.message || 'Unknown error');
      } finally {
        setLoading(false);
      }
    })();

    return () => controller.abort();
  }, [minScore, limit, sort, q, reloadKey]);

  const items = useMemo(() => data?.items || [], [data]);

  const stats = useMemo(() => {
    const n = items.length;
    const top = items[0]?.score ?? null;
    const avg = n ? items.reduce((a, b) => a + (b.score || 0), 0) / n : null;
    const priced = n ? items.filter((x) => x.pricedIn === true).length : 0;
    return { n, top, avg, priced };
  }, [items]);

  const filtered = useMemo(() => {
    const qq = q.trim().toLowerCase();
    let arr = items;

    if (qq) {
      arr = arr.filter((it) => {
        const a = (it.symbol || '').toLowerCase();
        const b = (it.headline || '').toLowerCase();
        const c = (it.type || '').toLowerCase();
        const d = (it.signalsText || '').toLowerCase();
        const e = (it.technicalContext || '').toLowerCase();
        return a.includes(qq) || b.includes(qq) || c.includes(qq) || d.includes(qq) || e.includes(qq);
      });
    }

    arr = [...arr].sort((a, b) => {
      if (sort === 'newest') return new Date(b.publishedAt).getTime() - new Date(a.publishedAt).getTime();
      if (sort === 'ret5d') {
        const aa = typeof a.ret5d === 'number' ? a.ret5d : -999;
        const bb = typeof b.ret5d === 'number' ? b.ret5d : -999;
        return bb - aa;
      }
      return (b.score || 0) - (a.score || 0);
    });

    return arr;
  }, [items, q, sort]);

  const paged = useMemo(() => filtered.slice(0, perPage), [filtered, perPage]);

  return (
    <div className="min-h-screen bg-slate-950 text-white">
      {/* Background glow */}
      <div className="pointer-events-none fixed inset-0 overflow-hidden">
        <div className="absolute -top-24 left-1/2 -translate-x-1/2 w-[900px] h-[900px] rounded-full bg-emerald-400/10 blur-[120px]" />
        <div className="absolute top-[30%] -left-40 w-[500px] h-[500px] rounded-full bg-cyan-400/10 blur-[120px]" />
        <div className="absolute bottom-[-120px] right-[-120px] w-[520px] h-[520px] rounded-full bg-indigo-400/10 blur-[120px]" />
      </div>

      <div className="relative">
        {/* Top bar */}
        <header className="w-full max-w-6xl mx-auto px-4 pt-6">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <div className="w-10 h-10 rounded-2xl bg-white/5 border border-white/10 flex items-center justify-center font-black">
                NI
              </div>
              <div>
                <div className="font-black leading-tight">NewsImpact</div>
                <div className="text-[11px] text-slate-400 leading-tight">
                  Nasdaq news reaction ranking
                </div>
              </div>
            </div>

            <div className="flex items-center gap-2">
              <Link
                href="/methodology"
                className="hidden sm:inline-flex items-center px-3 py-2 rounded-2xl bg-white/5 border border-white/10 text-sm font-semibold hover:bg-white/10 transition"
              >
                Methodology
              </Link>
              <a
                href="#leaderboard"
                className="inline-flex items-center px-3 py-2 rounded-2xl bg-emerald-400 text-slate-950 text-sm font-black hover:opacity-95 transition"
              >
                View Ranking →
              </a>
            </div>
          </div>
        </header>

        {/* Hero */}
        <section className="w-full max-w-6xl mx-auto px-4 pt-10 pb-8">
          <div className="grid md:grid-cols-12 gap-6 items-start">
            <div className="md:col-span-7">
              <div className="inline-flex items-center gap-2 w-fit px-3 py-1 rounded-full text-[11px] font-black uppercase tracking-wider bg-white/5 border border-white/10 text-slate-200">
                📈 Nasdaq-100 News Impact • Data-driven
              </div>

              <h1 className="mt-4 text-3xl sm:text-4xl md:text-5xl font-black leading-tight">
                Rank news by <span className="text-emerald-300">real market reaction</span>.
              </h1>

              <p className="mt-4 text-slate-300 max-w-2xl">
                We scan news events and score impact from <b>50–100</b> using post-news returns (+1D / +5D) and a
                <b> priced-in penalty</b>. It’s a fast way to spot what’s truly moving the tape.
              </p>

              <div className="mt-5 flex flex-wrap gap-2 text-xs">
                <span className="px-3 py-1.5 rounded-full bg-white/5 border border-white/10 text-slate-200">
                  ⚡ Updated frequently
                </span>
                <span className="px-3 py-1.5 rounded-full bg-white/5 border border-white/10 text-slate-200">
                  🧠 Priced-in detection
                </span>
                <span className="px-3 py-1.5 rounded-full bg-white/5 border border-white/10 text-slate-200">
                  📊 +1D / +5D returns
                </span>
              </div>
            </div>

            {/* Stat card */}
            <div className="md:col-span-5">
              <div className="rounded-3xl bg-white/5 border border-white/10 shadow-xl p-5">
                <div className="flex items-center justify-between">
                  <div className="font-black">Today Snapshot</div>
                  <div className="text-[11px] text-slate-400">
                    {data?.asOf ? fmtDate(data.asOf) : '—'}
                  </div>
                </div>

                {/* ✅ mobilde daha az yer kaplasın */}
                <div className="mt-4 grid grid-cols-2 sm:grid-cols-3 gap-3">
                  <div className="rounded-2xl bg-slate-900/40 border border-white/10 p-3">
                    <div className="text-[11px] text-slate-400">Events</div>
                    <div className="mt-1 text-xl font-black">{stats.n || '—'}</div>
                  </div>
                  <div className="rounded-2xl bg-slate-900/40 border border-white/10 p-3">
                    <div className="text-[11px] text-slate-400">Top score</div>
                    <div className="mt-1 text-xl font-black">
                      {typeof stats.top === 'number' ? stats.top : '—'}
                    </div>
                  </div>
                  <div className="hidden sm:block rounded-2xl bg-slate-900/40 border border-white/10 p-3">
                    <div className="text-[11px] text-slate-400">Priced-in</div>
                    <div className="mt-1 text-xl font-black">{stats.n ? `${stats.priced}` : '—'}</div>
                  </div>
                </div>

                <div className="mt-4 text-xs text-slate-400">
                  Tip: Filter by <b>Score ≥ 70</b> to find higher-impact news.
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* Controls + Board */}
        <section id="leaderboard" className="w-full max-w-6xl mx-auto px-4 pb-16">
          <div className="rounded-3xl bg-white/5 border border-white/10 shadow-xl overflow-hidden">
            {/* Control header */}
            <div className="p-5 md:p-6 flex flex-col gap-4 md:flex-row md:items-center md:justify-between border-b border-white/10">
              <div>
                <div className="text-xl font-black">Top News Impact</div>
                <div className="text-xs text-slate-400 mt-1">
                  {data?.asOf ? `As of ${fmtDate(data.asOf)}` : 'Live ranking'}
                </div>
              </div>

              <div className="flex flex-col sm:flex-row gap-3 sm:items-center">
                <div className="relative">
                  <input
                    value={q}
                    onChange={(e) => setQ(e.target.value)}
                    placeholder="Search ticker or keyword…"
                    className="w-full sm:w-72 px-4 py-2.5 rounded-2xl bg-slate-900/70 border border-white/10 text-sm outline-none focus:border-emerald-400/40"
                  />
                  <div className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-500 text-xs">
                    ⌘K
                  </div>
                </div>

                <div className="flex flex-wrap gap-2">
                  <select
                    value={sort}
                    onChange={(e) => setSort(e.target.value as SortKey)}
                    className="px-3 py-2.5 rounded-2xl bg-slate-900/70 border border-white/10 text-sm outline-none"
                  >
                    <option value="score">Sort: Highest score</option>
                    <option value="newest">Sort: Newest</option>
                    <option value="ret5d">Sort: Best +5D</option>
                  </select>

                  <select
                    value={minScore}
                    onChange={(e) => setMinScore(parseInt(e.target.value, 10))}
                    className="px-3 py-2.5 rounded-2xl bg-slate-900/70 border border-white/10 text-sm outline-none"
                  >
                    <option value={50}>Score ≥ 50</option>
                    <option value={60}>Score ≥ 60</option>
                    <option value={70}>Score ≥ 70</option>
                    <option value={80}>Score ≥ 80</option>
                  </select>

                  <select
                    value={limit}
                    onChange={(e) => setLimit(parseInt(e.target.value, 10))}
                    className="px-3 py-2.5 rounded-2xl bg-slate-900/70 border border-white/10 text-sm outline-none"
                  >
                    <option value={20}>Top 20</option>
                    <option value={30}>Top 30</option>
                    <option value={50}>Top 50</option>
                    <option value={100}>Top 100</option>
                  </select>

                  <select
                    value={perPage}
                    onChange={(e) => setPerPage(parseInt(e.target.value, 10))}
                    className="px-3 py-2.5 rounded-2xl bg-slate-900/70 border border-white/10 text-sm outline-none"
                  >
                    <option value={10}>Cards: 10</option>
                    <option value={20}>Cards: 20</option>
                    <option value={30}>Cards: 30</option>
                    <option value={50}>Cards: 50</option>
                  </select>

                  <button
                    onClick={() => setReloadKey((k) => k + 1)}
                    className="px-3 py-2.5 rounded-2xl bg-slate-900/70 border border-white/10 text-sm font-black hover:bg-white/5"
                    title="Refresh"
                  >
                    ⟳ Refresh
                  </button>

                  <div className="flex rounded-2xl overflow-hidden border border-white/10 bg-slate-900/70">
                    <button
                      onClick={() => setView('grid')}
                      className={`px-3 py-2.5 text-sm font-black ${
                        view === 'grid' ? 'bg-white/10' : 'hover:bg-white/5'
                      }`}
                    >
                      Grid
                    </button>
                    <button
                      onClick={() => setView('list')}
                      className={`px-3 py-2.5 text-sm font-black ${
                        view === 'list' ? 'bg-white/10' : 'hover:bg-white/5'
                      }`}
                    >
                      List
                    </button>
                  </div>
                </div>
              </div>
            </div>

            {/* Content */}
            <div className="p-5 md:p-6">
              {loading && (
                <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">
                  {Array.from({ length: 6 }).map((_, i) => (
                    <SkeletonCard key={i} />
                  ))}
                </div>
              )}

              {!loading && err && (
                <div className="rounded-2xl bg-rose-500/10 border border-rose-500/20 text-rose-200 p-4">
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
                <>
                  {view === 'grid' ? (
                    <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">
                      {paged.map((it, idx) => {
                        const tone = scoreTone(it.score);
                        const pi = pricedInUI(it.pricedIn ?? null);
                        const isTop = idx === 0 && sort === 'score' && !q;

                        const signalLine = it.signalsText || it.technicalContext || null;

                        return (
                          <div
                            key={`${it.symbol}-${it.publishedAt}-${idx}`}
                            className={`group rounded-3xl bg-white/5 border border-white/10 shadow-xl p-5 transition transform hover:-translate-y-0.5 hover:bg-white/[0.07] hover:border-emerald-400/25 ring-1 ${tone.ring}`}
                          >
                            <div className="flex items-start justify-between gap-4">
                              <div className="flex flex-col">
                                <div className="text-[11px] font-black tracking-wider text-emerald-200/90">
                                  {isTop ? '🏆 TOP IMPACT' : impactLabel(it.score)}
                                </div>
                                <Link
                                  href={`/ticker/${encodeURIComponent(it.symbol)}`}
                                  className="mt-1 text-2xl font-black text-white group-hover:text-emerald-200 transition"
                                >
                                  {it.symbol}
                                </Link>
                              </div>

                              <div
                                className={`inline-flex items-center px-3 py-1.5 rounded-2xl border text-sm font-black ${tone.pill}`}
                              >
                                {it.score}
                              </div>
                            </div>

                            <div className="mt-3 text-slate-200/90 font-semibold leading-snug line-clamp-3">
                              {it.headline}
                            </div>

                            <div className="mt-2 text-[11px] text-slate-400">
                              {fmtDate(it.publishedAt)}
                              {it.type ? <span className="mx-2">•</span> : null}
                              {it.type ? (
                                <span className="inline-flex items-center px-2 py-0.5 rounded-full bg-white/5 border border-white/10 text-slate-200">
                                  {it.type}
                                </span>
                              ) : null}
                            </div>

                            {/* expected vs realized + confidence */}
                            <div className="mt-4 space-y-3">
                              <MiniBar
                                label="Expected impact"
                                value={typeof it.expectedImpact === 'number' ? it.expectedImpact : it.score}
                              />
                              <MiniBar
                                label="Realized impact"
                                value={typeof it.realizedImpact === 'number' ? it.realizedImpact : null}
                                dimIfNull
                              />

                              {/* ✅ ProgressBar yerine */}
                              <ConfidenceBar value={typeof it.confidence === 'number' ? it.confidence : null} />
                            </div>

                            {/* badges */}
                            <div className="mt-4 flex flex-wrap gap-2">
                              <span
                                className={`inline-flex items-center px-2.5 py-1 rounded-full text-[11px] font-black border ${pi.cls}`}
                              >
                                {pi.txt}
                              </span>

                              {it.tooEarly ? (
                                <span className="inline-flex items-center px-2.5 py-1 rounded-full text-[11px] font-black border bg-amber-500/10 text-amber-200 border-amber-500/20">
                                  ⚠️ Too early to price
                                </span>
                              ) : null}

                              {signalLine ? (
                                <span className="inline-flex items-center px-2.5 py-1 rounded-full text-[11px] font-black border bg-white/5 text-slate-200 border-white/10">
                                  📊 Signals
                                </span>
                              ) : null}
                            </div>

                            {signalLine ? (
                              <div className="mt-3 text-[12px] leading-snug text-slate-300/90">
                                {signalLine}
                              </div>
                            ) : (
                              <div className="mt-3 text-[12px] text-slate-500">
                                No technical signals (yet)
                              </div>
                            )}

                            {/* returns */}
                            <div className="mt-4 flex flex-wrap gap-2">
                              <span
                                className={`px-2.5 py-1 rounded-full text-xs bg-slate-900/60 border border-white/10 ${pctColor(
                                  it.ret1d
                                )}`}
                              >
                                +1D {fmtPct(it.ret1d)}
                              </span>
                              <span
                                className={`px-2.5 py-1 rounded-full text-xs bg-slate-900/60 border border-white/10 ${pctColor(
                                  it.ret5d
                                )}`}
                              >
                                +5D {fmtPct(it.ret5d)}
                              </span>
                              {typeof it.retPre5 === 'number' ? (
                                <span
                                  className={`px-2.5 py-1 rounded-full text-xs bg-slate-900/60 border border-white/10 ${pctColor(
                                    it.retPre5
                                  )}`}
                                >
                                  Pre-5 {fmtPct(it.retPre5)}
                                </span>
                              ) : null}
                            </div>

                            {/* actions */}
                            <div className="mt-5 flex items-center justify-between">
                              <Link
                                href={`/ticker/${encodeURIComponent(it.symbol)}`}
                                className="text-sm font-black text-emerald-200 hover:underline"
                              >
                                Open ticker →
                              </Link>

                              {it.url ? (
                                <a
                                  href={it.url}
                                  target="_blank"
                                  rel="noreferrer"
                                  className="text-sm font-bold text-slate-300 hover:text-white hover:underline"
                                >
                                  Source ↗
                                </a>
                              ) : (
                                <span className="text-sm text-slate-500">No source</span>
                              )}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  ) : (
                    <div className="rounded-2xl border border-white/10 overflow-hidden">
                      <div className="grid grid-cols-12 gap-2 px-4 py-3 text-[11px] font-black text-slate-300 bg-white/5">
                        <div className="col-span-2">Ticker</div>
                        <div className="col-span-5">Headline</div>
                        <div className="col-span-1 text-right">Score</div>
                        <div className="col-span-1 text-right">Conf</div>
                        <div className="col-span-1 text-right">Exp</div>
                        <div className="col-span-1 text-right">Real</div>
                        <div className="col-span-1 text-right">+1D</div>
                        <div className="col-span-1 text-right">+5D</div>
                      </div>

                      {paged.map((it, idx) => {
                        const tone = scoreTone(it.score);
                        const signalLine = it.signalsText || it.technicalContext || '';
                        return (
                          <div
                            key={`${it.symbol}-${it.publishedAt}-${idx}`}
                            className="grid grid-cols-12 gap-2 px-4 py-4 border-t border-white/5 hover:bg-white/[0.04] transition"
                          >
                            <div className="col-span-2">
                              <Link
                                href={`/ticker/${encodeURIComponent(it.symbol)}`}
                                className="font-black text-emerald-200 hover:underline"
                              >
                                {it.symbol}
                              </Link>
                              <div className="text-[11px] text-slate-400 mt-1">{fmtDate(it.publishedAt)}</div>
                            </div>

                            <div className="col-span-5">
                              <div className="font-semibold text-slate-100">{it.headline}</div>
                              <div className="mt-1 flex flex-wrap gap-2 items-center text-[11px] text-slate-400">
                                {it.type ? (
                                  <span className="px-2 py-0.5 rounded-full bg-white/5 border border-white/10 text-slate-200">
                                    {it.type}
                                  </span>
                                ) : null}
                                <span className={`px-2 py-0.5 rounded-full border ${pricedInUI(it.pricedIn ?? null).cls}`}>
                                  {pricedInUI(it.pricedIn ?? null).txt}
                                </span>
                                {it.tooEarly ? (
                                  <span className="px-2 py-0.5 rounded-full bg-amber-500/10 border border-amber-500/25 text-amber-200">
                                    ⚠️ Too early
                                  </span>
                                ) : null}
                                {it.url ? (
                                  <a
                                    href={it.url}
                                    target="_blank"
                                    rel="noreferrer"
                                    className="px-2 py-0.5 rounded-full bg-white/5 border border-white/10 text-slate-200 hover:underline"
                                  >
                                    Source ↗
                                  </a>
                                ) : null}
                                {signalLine ? (
                                  <span className="px-2 py-0.5 rounded-full bg-white/5 border border-white/10 text-slate-200">
                                    📊 {signalLine}
                                  </span>
                                ) : null}
                              </div>
                            </div>

                            <div className="col-span-1 text-right">
                              <span className={`inline-flex items-center px-2.5 py-1 rounded-full text-[11px] font-black border ${tone.pill}`}>
                                {it.score}
                              </span>
                            </div>

                            <div className="col-span-1 text-right">
                              <span className="text-[11px] font-black text-slate-200">
                                {typeof it.confidence === 'number' ? `${it.confidence}%` : '—'}
                              </span>
                            </div>

                            <div className="col-span-1 text-right text-slate-200 font-black">
                              {typeof it.expectedImpact === 'number' ? it.expectedImpact : '—'}
                            </div>

                            <div className="col-span-1 text-right text-slate-200 font-black">
                              {typeof it.realizedImpact === 'number' ? it.realizedImpact : '—'}
                            </div>

                            <div className={`col-span-1 text-right font-bold ${pctColor(it.ret1d)}`}>
                              {fmtPct(it.ret1d)}
                            </div>
                            <div className={`col-span-1 text-right font-bold ${pctColor(it.ret5d)}`}>
                              {fmtPct(it.ret5d)}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}

                  {/* footer note */}
                  <div className="mt-6 rounded-2xl bg-slate-900/40 border border-white/10 p-4">
                    <div className="font-black">How is the score calculated?</div>
                    <div className="text-sm text-slate-300 mt-1">
                      We use post-news returns (+1D/+5D) and reduce the score if price moved strongly <em>before</em> the news (priced-in penalty).
                      This is an informational ranking — not financial advice.
                    </div>
                  </div>

                  <div className="mt-6 text-[11px] text-slate-400">
                    Showing <b>{paged.length}</b> of <b>{filtered.length}</b> filtered items.
                  </div>
                </>
              )}
            </div>
          </div>

          <div className="text-[11px] text-slate-500 mt-6">
            Disclaimer: Not financial advice. Scores are informational and based on historical reactions.
          </div>
        </section>
      </div>
    </div>
  );
}