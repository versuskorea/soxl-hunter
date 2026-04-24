// api/quote-full.js
// 종목 풀 정보 (시총, 52주 고저, PE, 배당 등)
// GET /api/quote-full?symbol=SOXL

export default async function handler(req, res) {
const { symbol } = req.query;

if (!symbol) {
return res.status(400).json({ error: ‘symbol parameter required’ });
}

const sym = symbol.toUpperCase().trim();

try {
// 야후 파이낸스 v7/finance/quote
const url = `https://query1.finance.yahoo.com/v7/finance/quote?symbols=${encodeURIComponent(sym)}`;

```
const response = await fetch(url, {
  headers: {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    'Accept': 'application/json',
  }
});

if (!response.ok) {
  return res.status(response.status).json({ 
    error: `Yahoo API error: ${response.status}`,
    symbol: sym 
  });
}

const data = await response.json();
const result = data?.quoteResponse?.result?.[0];

if (!result) {
  return res.status(404).json({ 
    error: 'Symbol not found',
    symbol: sym 
  });
}

// 필요한 필드만 추출
const quote = {
  symbol: result.symbol,
  longName: result.longName || result.shortName || sym,
  exchange: result.fullExchangeName || result.exchange || '',
  currency: result.currency || 'USD',
  
  // 가격
  price: result.regularMarketPrice,
  previousClose: result.regularMarketPreviousClose,
  change: result.regularMarketChange,
  changePercent: result.regularMarketChangePercent,
  open: result.regularMarketOpen,
  dayHigh: result.regularMarketDayHigh,
  dayLow: result.regularMarketDayLow,
  
  // 거래량
  volume: result.regularMarketVolume,
  avgVolume: result.averageDailyVolume3Month,
  
  // 시가총액
  marketCap: result.marketCap,
  sharesOutstanding: result.sharesOutstanding,
  
  // 52주
  high52: result.fiftyTwoWeekHigh,
  low52: result.fiftyTwoWeekLow,
  change52Pct: result.fiftyTwoWeekChangePercent,
  
  // 지표
  peRatio: result.trailingPE || null,
  forwardPE: result.forwardPE || null,
  eps: result.epsTrailingTwelveMonths || null,
  beta: result.beta || null,
  
  // 배당
  dividendYield: result.dividendYield || null,
  dividendRate: result.dividendRate || null,
  exDividendDate: result.exDividendDate || null,
  
  // 시간
  marketTime: result.regularMarketTime,
  marketState: result.marketState, // 'REGULAR', 'CLOSED', 'PRE', 'POST'
  
  // 장전/장후
  preMarketPrice: result.preMarketPrice || null,
  preMarketChangePercent: result.preMarketChangePercent || null,
  postMarketPrice: result.postMarketPrice || null,
  postMarketChangePercent: result.postMarketChangePercent || null,
};

// 캐시 30초
res.setHeader('Cache-Control', 's-maxage=30, stale-while-revalidate=60');
res.status(200).json(quote);
```

} catch (err) {
console.error(‘quote-full error:’, err);
res.status(500).json({
error: err.message,
symbol: sym
});
}
}