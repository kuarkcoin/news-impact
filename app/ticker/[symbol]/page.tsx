import Link from "next/link";

type Props = {
  params: { symbol: string };
};

export default function TickerPage({ params }: Props) {
  const symbol = decodeURIComponent(params.symbol).toUpperCase();

  return (
    <div className="min-h-screen bg-slate-950 text-white">
      <div className="max-w-4xl mx-auto px-4 py-10">
        {/* Header */}
        <div className="flex items-center gap-4 mb-6">
          <div className="text-3xl font-black text-emerald-300">{symbol}</div>
          <span className="px-3 py-1 rounded-full text-xs font-black bg-white/5 border border-white/10 text-slate-200">
            Nasdaq
          </span>
        </div>

        {/* Placeholder */}
        <div className="rounded-3xl bg-white/5 border border-white/10 p-6">
          <div className="text-lg font-black mb-2">Ticker details coming soon</div>
          <p className="text-slate-300 text-sm">
            This page will show news impact history, score timeline and price
            reactions for <span className="font-semibold">{symbol}</span>.
          </p>

          <div className="mt-6 flex gap-3">
            <Link
              href="/"
              className="inline-flex items-center px-4 py-2 rounded-xl bg-white/5 border border-white/10 hover:bg-white/10 transition"
            >
              ← Back to leaderboard
            </Link>

            <a
              href={`https://finance.yahoo.com/quote/${symbol}`}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center px-4 py-2 rounded-xl bg-emerald-400 text-slate-950 font-black hover:opacity-90 transition"
            >
              View on Yahoo Finance →
            </a>
          </div>
        </div>
      </div>
    </div>
  );
}
