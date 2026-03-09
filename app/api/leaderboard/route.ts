type IndicatorScore = {
  name: string;
  score: number;
};

type LeaderItem = {
  symbol: string;
  assetType: "stock" | "etf";

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

  technicalContext?: string | null;

  expectedDir?: -1 | 0 | 1;
  realizedDir?: -1 | 0 | 1;
  rsi14?: number | null;
  breakout20?: boolean | null;
  bullTrap?: boolean | null;
  volumeSpike?: boolean | null;

  aiSummary?: string | null;
  aiBullets?: string[] | null;
  aiSentiment?: "bullish" | "bearish" | "mixed" | "neutral" | null;

  signals?: string[];
  signalsText?: string;

  fundamentalScore: number;   // 0..50
  technicalScore: number;     // 0..50
  totalScore: number;         // 0..100

  newsScore: number;          // 0..20
  qualityScore: number;       // 0..15
  valuationScore: number;     // 0..15

  topBuyIndicators: IndicatorScore[];
  topSellIndicators: IndicatorScore[];

  sector?: string | null;
};
