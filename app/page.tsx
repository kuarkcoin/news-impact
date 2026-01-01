'use client';

import React, { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';

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

expectedImpact: number; // 50..100
realizedImpact: number; // 50..100
score: number;          // 50..100
confidence: number;     // 0..100
tooEarly: boolean;      // true => ⚠️
technicalContext: string | null;
};

type ApiResp = { asOf: string; items: LeaderItem[] };

// ✅ Accuracy metrics type (from /api/metrics)
type Metrics = {
updatedAt: string;
totalMeasured: number;

directionAccuracy: number; // %
avgAbsError: number;       // pts
highScoreHitRate: number;  // %
};

function clamp(n: number, a: number, b: number) {
return Math.max(a, Math.min(b, n));
}

function fmtPct(x: number | null | undefined) {
if (typeof x !== 'number') return '—';
const v = x * 100;
const sign = v > 0 ? '+' : '';
return ${sign}${v.toFixed(2)}%;
}

function fmtDate(iso: string) {
try {
return new Date(iso).toLocaleString();
} catch {
return iso;
}
}

function badgeScore(score: number) {
if (score >= 85) return 'bg-emerald-500/10 text-emerald-300 border-emerald-500/25';
if (score >= 70) return 'bg-amber-500/10 text-amber-300 border-amber-500/25';
return 'bg-slate-500/10 text-slate-300 border-white/10';
}

function badgeType(t: string | null) {
const s = (t || 'General').toLowerCase();
if (s.includes('earn')) return 'bg-fuchsia-500/10 text-fuchsia-200 border-fuchsia-500/20';
if (s.includes('analyst')) return 'bg-sky-500/10 text-sky-200 border-sky-500/20';
if (s.includes('product')) return 'bg-violet-500/10 text-violet-200 border-violet-500/20';
return 'bg-white/5 text-slate-200 border-white/10';
}

function pricedInText(v: boolean | null | undefined) {
if (v === true) return { txt: '✅ Priced-in', cls: 'bg-white/5 text-slate-200 border-white/10' };
if (v === false) return { txt: '🔥 Not priced', cls: 'bg-emerald-500/10 text-emerald-200 border-emerald-500/20' };
return { txt: '—', cls: 'bg-white/5 text-slate-200 border-white/10' };
}

function ProgressBar({ value, className = '' }: { value: number; className?: string }) {
const clamped = clamp(value ?? 0, 0, 100);
return (
<div className={space-y-1 ${className}}>
<div className="flex items-center justify-between text-[11px] text-slate-300">
<span className="font-bold">Confidence</span>
<span className="font-black">{clamped}%</span>
</div>
<div className="h-2 rounded-full bg-white/10 overflow-hidden">
<div className="h-full bg-emerald-400 transition-all" style={{ width: ${clamped}% }} />
</div>
</div>
);
}

function Stat({ label, value, accent }: { label: string; value: any; accent?: boolean }) {
return (
<div className="rounded-2xl bg-white/5 border border-white/10 p-4">
<div className="text-xs text-slate-400">{label}</div>
<div className={text-2xl font-black ${accent ? 'text-emerald-300' : ''}}>{value}</div>
</div>
);
}

function MiniKpi({ label, value }: { label: string; value: number }) {
return (
<div className="rounded-2xl bg-white/5 border border-white/10 p-3">
<div className="text-[11px] text-slate-400">{label}</div>
<div className="text-xl font-black text-white/90">{value}</div>
</div>
);
}

export default function HomePage() {
const [data, setData] = useState<ApiResp | null>(null);
const [loading, setLoading] = useState(true);
const [err, setErr] = useState<string | null>(null);

// ✅ Accuracy dashboard data
const [metrics, setMetrics] = useState<Metrics | null>(null);

const [q, setQ] = useState('');
const [minScore, setMinScore] = useState(50);
const [sortBy, setSortBy] = useState<'score' | 'newest' | 'confidence'>('score');

// ✅ Fetch leaderboard (refresh yok)
useEffect(() => {
const controller = new AbortController();

(async () => {  
  try {  
    setLoading(true);  
    setErr(null);  

    const res = await fetch(`/api/leaderboard?min=${minScore}&limit=50`, {  
      cache: 'no-store',  
      signal: controller.signal,  
    });  

    if (!res.ok) {  
      const t = await res.text().catch(() => '');  
      throw new Error(t || `API failed (${res.status})`);  
    }  

    const json = (await res.json()) as ApiResp;  
    setData(json);  
  } catch (e: any) {  
    if (e?.name !== 'AbortError') setErr(e?.message || 'Bilinmeyen hata');  
  } finally {  
    setLoading(false);  
  }  
})();  

return () => controller.abort();

}, [minScore]);

// ✅ Fetch metrics once
useEffect(() => {
const controller = new AbortController();

(async () => {  
  try {  
    const res = await fetch('/api/metrics', { cache: 'no-store', signal: controller.signal });  
    if (!res.ok) return;  
    const json = (await res.json()) as Metrics;  
    setMetrics(json);  
  } catch (e: any) {  
    if (e?.name !== 'AbortError') {  
      // sessiz geç: metrics gelmezse UI bozulmasın  
    }  
  }  
})();  

return () => controller.abort();

}, []);

const items = useMemo(() => {
const list = data?.items || [];
const qq = q.trim().toLowerCase();

const searched = !qq  
  ? list  
  : list.filter((it) => {  
      const blob = `${it.symbol} ${it.headline} ${it.type || ''}`.toLowerCase();  
      return blob.includes(qq);  
    });  

const sorted = [...searched].sort((a, b) => {  
  if (sortBy === 'newest') return new Date(b.publishedAt).getTime() - new Date(a.publishedAt).getTime();  
  if (sortBy === 'confidence') return (b.confidence ?? 0) - (a.confidence ?? 0);  
  return (b.score ?? 0) - (a.score ?? 0);  
});  

return sorted;

}, [data, q, sortBy]);

const top1 = items.slice(0, 1);
const top3 = items.slice(0, 3);

const stats = useMemo(() => {
const list = data?.items || [];
const avgScore = list.length ? Math.round(list.reduce((a, x) => a + (x.score ?? 0), 0) / list.length) : 0;
const hi = list.filter((x) => (x.score ?? 0) >= 80).length;
const early = list.filter((x) => x.tooEarly).length;
return { total: list.length, avgScore, hi, early };
}, [data]);

return (
<div className="min-h-screen bg-slate-950 text-white">
{/* HERO */}
<section className="max-w-6xl mx-auto px-4 pt-10 pb-6">
<div className="flex flex-col gap-4">
<div className="inline-flex items-center gap-2 w-fit px-3 py-1 rounded-full text-[11px] font-black uppercase tracking-wider bg-white/5 border border-white/10 text-slate-200">
📈 NewsImpact • Nasdaq watchlist • cron + kv
</div>

<h1 className="text-3xl sm:text-4xl md:text-5xl font-black leading-tight">  
        News → Price Reaction <span className="text-emerald-300">measured</span>  
      </h1>  

      <p className="text-slate-300 max-w-2xl">  
        Each headline gets: <b>Expected</b> vs <b>Realized</b> impact, a <b>Confidence</b> score, and a warning if it’s <b>too early</b>.  
      </p>  

      {/* ✅ Accuracy Dashboard (NEW) */}  
      <div className="rounded-3xl bg-white/5 border border-white/10 p-4">  
        <div className="flex items-center justify-between gap-3">  
          <div className="font-black">Accuracy dashboard</div>  
          <div className="text-[11px] text-slate-400">  
            {metrics?.updatedAt ? `Updated ${fmtDate(metrics.updatedAt)}` : '—'}  
          </div>  
        </div>  

        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 pt-3">  
          <Stat label="Measured items" value={metrics ? metrics.totalMeasured : '—'} />  
          <Stat label="Direction accuracy" value={metrics ? `${metrics.directionAccuracy}%` : '—'} accent />  
          <Stat label="Avg error" value={metrics ? `${metrics.avgAbsError} pts` : '—'} />  
          <Stat label="High-score hit" value={metrics ? `${metrics.highScoreHitRate}%` : '—'} />  
        </div>  

        <div className="text-[11px] text-slate-400 mt-2">  
          Based on items with realized reactions (+1D / +5D). Metrics improve as more items get measured.  
        </div>  
      </div>  

      {/* existing stats */}  
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 pt-2">  
        <Stat label="Items" value={stats.total} />  
        <Stat label="Avg score" value={stats.total ? stats.avgScore : '—'} accent />  
        <Stat label="High impact (≥80)" value={stats.hi} />  
        <Stat label="Too early" value={stats.early} />  
      </div>  

      <div className="flex flex-col sm:flex-row gap-3 pt-2">  
        <a  
          href="#leaderboard"  
          className="inline-flex items-center justify-center px-6 py-3 rounded-2xl bg-emerald-400 text-slate-950 font-black hover:opacity-95 transition"  
        >  
          View leaderboard →  
        </a>  
        <Link  
          href="/methodology"  
          className="inline-flex items-center justify-center px-6 py-3 rounded-2xl bg-white/5 border border-white/10 text-white font-bold hover:bg-white/10 transition"  
        >  
          How it works  
        </Link>  
      </div>  
    </div>  
  </section>  

  {/* TOP CARDS */}  
  <section className="max-w-6xl mx-auto px-4 pb-4">  
    {top1.length > 0 && (  
      <div className="grid gap-4 sm:hidden">  
        <TopCard it={top1[0]} />  
      </div>  
    )}  

    {top3.length > 0 && (  
      <div className="hidden sm:grid md:grid-cols-3 gap-4">  
        {top3.map((it) => (  
          <TopCard key={`${it.symbol}-${it.publishedAt}`} it={it} />  
        ))}  
      </div>  
    )}  
  </section>  

  {/* LEADERBOARD */}  
  <section id="leaderboard" className="max-w-6xl mx-auto px-4 pb-16">  
    <div className="rounded-3xl bg-white/5 border border-white/10 shadow-xl overflow-hidden">  
      {/* controls */}  
      <div className="p-5 md:p-6 flex flex-col gap-4 md:flex-row md:items-center md:justify-between">  
        <div className="flex items-start gap-3">  
          <div>  
            <div className="text-xl font-black">Leaderboard</div>  
            <div className="text-xs text-slate-300 mt-1">  
              {data?.asOf ? `Last updated ${fmtDate(data.asOf)} (auto)` : 'Live'}  
            </div>  
          </div>  
        </div>  

        <div className="flex flex-col sm:flex-row gap-2 sm:items-center">  
          <input  
            value={q}  
            onChange={(e) => setQ(e.target.value)}  
            placeholder="Search: AAPL, earnings, AI..."  
            className="w-full sm:w-72 px-4 py-2 rounded-2xl bg-slate-900/70 border border-white/10 text-sm outline-none focus:border-emerald-400/40"  
          />  

          <select  
            value={sortBy}  
            onChange={(e) => setSortBy(e.target.value as any)}  
            className="px-3 py-2 rounded-2xl bg-slate-900/70 border border-white/10 text-sm outline-none"  
          >  
            <option value="score">Sort: Score</option>  
            <option value="confidence">Sort: Confidence</option>  
            <option value="newest">Sort: Newest</option>  
          </select>  

          <select  
            value={minScore}  
            onChange={(e) => setMinScore(parseInt(e.target.value, 10))}  
            className="px-3 py-2 rounded-2xl bg-slate-900/70 border border-white/10 text-sm outline-none"  
          >  
            <option value="50">Score ≥ 50</option>  
            <option value="60">Score ≥ 60</option>  
            <option value="70">Score ≥ 70</option>  
            <option value="80">Score ≥ 80</option>  
          </select>  
        </div>  
      </div>  

      {/* content */}  
      <div className="px-5 md:px-6 pb-6">  
        {loading && (  
          <div className="py-10 text-center text-slate-300">  
            <div className="inline-block w-10 h-10 border-4 border-white/10 border-t-emerald-400 rounded-full animate-spin" />  
            <div className="mt-4 text-sm font-semibold">Loading…</div>  
          </div>  
        )}  

        {!loading && err && (  
          <div className="py-8 rounded-2xl bg-red-500/10 border border-red-500/20 text-red-200 px-4">  
            <div className="font-black">API error</div>  
            <div className="text-sm mt-1">{err}</div>  
          </div>  
        )}  

        {!loading && !err && items.length === 0 && (  
          <div className="py-10 text-center text-slate-300">  
            No items. (Cron henüz çalışmamış olabilir)  
          </div>  
        )}  

        {!loading && !err && items.length > 0 && (  
          <div className="overflow-x-auto">  
            <table className="w-full text-sm">  
              <thead className="text-slate-300">  
                <tr className="border-b border-white/10">  
                  <th className="text-left py-3 pr-3">#</th>  
                  <th className="text-left py-3 pr-3">Ticker</th>  
                  <th className="text-left py-3 pr-3">Headline</th>  
                  <th className="text-left py-3 pr-3">Score</th>  
                  <th className="text-left py-3 pr-3">Expected</th>  
                  <th className="text-left py-3 pr-3">Realized</th>  
                  <th className="text-left py-3 pr-3">Conf</th>   
                  <th className="text-left py-3 pr-3">Tech</th>  
                  <th className="text-left py-3 pr-3">⚠️</th>  
                  <th className="text-left py-3 pr-3">+1D</th>  
                  <th className="text-left py-3 pr-3">+5D</th>  
                </tr>  
              </thead>  

              <tbody>  
                {items.map((it, idx) => (  
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
                        {fmtDate(it.publishedAt)}  
                        {it.url ? (  
                          <>  
                            {' '}·{' '}  
                            <a href={it.url} target="_blank" rel="noreferrer" className="text-slate-300 hover:underline">  
                              source  
                            </a>  
                          </>  
                        ) : null}  
                      </div>  
                    </td>  

                    <td className="py-4 pr-3">  
                      <span className={`inline-flex items-center px-2.5 py-1 rounded-full text-[11px] font-black border ${badgeScore(it.score)}`}>  
                        {it.score}  
                      </span>  
                    </td>  

                    <td className="py-4 pr-3 text-slate-200">{it.expectedImpact}</td>  
                    <td className="py-4 pr-3 text-slate-200">{it.realizedImpact}</td>  

                    <td className="py-4 pr-3">  
                      <div className="w-28">  
                        <ProgressBar value={it.confidence ?? 0} />  
                      </div>  
                    </td>  
                    <td className="py-4 pr-3 text-slate-200 min-w-[220px]">

{it.technicalContext ?? "—"}

</td>  <td className="py-4 pr-3">  
                      {it.tooEarly ? (  
                        <span className="text-[11px] font-black px-2 py-1 rounded-full bg-amber-500/10 border border-amber-500/25 text-amber-200">  
                          ⚠️  
                        </span>  
                      ) : (  
                        <span className="text-slate-600">—</span>  
                      )}  
                    </td>  

                    <td className="py-4 pr-3 text-slate-200">{fmtPct(it.ret1d)}</td>  
                    <td className="py-4 pr-3 text-slate-200">{fmtPct(it.ret5d)}</td>  
                  </tr>  
                ))}  
              </tbody>  
            </table>  
          </div>  
        )}  

        <div className="mt-6 rounded-2xl bg-slate-900/50 border border-white/10 p-4 text-slate-200">  
          <div className="font-black">Interpretation</div>  
          <div className="text-sm text-slate-300 mt-1">  
            <b>Expected</b> is text+priced-in estimate. <b>Realized</b> is actual move strength (when +1D/+5D available).  
            <b>Confidence</b> rises when +1D and +5D exist; “⚠️” means it’s too early to judge.  
          </div>  
        </div>  
      </div>  
    </div>  

    <div className="text-[11px] text-slate-400 mt-6">  
      Disclaimer: Not financial advice. Informational scoring based on historical price reactions.  
    </div>  
  </section>  
</div>

);
}

function TopCard({ it }: { it: LeaderItem }) {
const p = pricedInText(it.pricedIn);
return (
<a
href={it.url || '#'}
target={it.url ? '_blank' : undefined}
rel="noreferrer"
className="group rounded-3xl bg-white/5 border border-white/10 p-5 hover:bg-white/7 transition shadow-xl block"
>
<div className="flex items-center justify-between gap-2">
<span className={inline-flex items-center px-2.5 py-1 rounded-full text-[11px] font-black border ${badgeScore(it.score)}}>
Score {it.score}
</span>
<span className={inline-flex items-center px-2.5 py-1 rounded-full text-[11px] font-black border ${badgeType(it.type)}}>
{it.type || 'General'}
</span>
</div>

<div className="mt-3 flex items-center justify-between">  
    <div className="text-2xl font-black text-emerald-300">{it.symbol}</div>  
    {it.tooEarly ? (  
      <span className="text-[11px] font-black px-2 py-1 rounded-full bg-amber-500/10 border border-amber-500/25 text-amber-200">  
        ⚠️ Too early to price  
      </span>  
    ) : null}  
  </div>  

  <div className="mt-2 text-sm text-white/90 line-clamp-3">{it.headline}</div>  

  <div className="mt-4 grid grid-cols-2 gap-3">  
    <MiniKpi label="Expected" value={it.expectedImpact} />  
    <MiniKpi label="Realized" value={it.realizedImpact} />  
  </div>  

  <div className="mt-4">  
    <ProgressBar value={it.confidence ?? 0} />  
  </div>  

  <div className="mt-4 flex flex-wrap items-center gap-2 text-[11px]">  
    <span className={`inline-flex items-center px-2.5 py-1 rounded-full border ${p.cls}`}>  
      {p.txt}  
    </span>  
    <span className="inline-flex items-center px-2.5 py-1 rounded-full border bg-white/5 border-white/10 text-slate-200">  
      +1D {fmtPct(it.ret1d)}  
    </span>  
    <span className="inline-flex items-center px-2.5 py-1 rounded-full border bg-white/5 border-white/10 text-slate-200">  
      +5D {fmtPct(it.ret5d)}  
    </span>  
  </div>  

  <div className="mt-4 text-[11px] text-slate-400">  
    {fmtDate(it.publishedAt)}  
    <span className="opacity-60"> • </span>  
    <span className="underline underline-offset-4 group-hover:opacity-100 opacity-80">  
      open source →  
    </span>  
  </div>  
</a>

);
} 