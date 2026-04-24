// api/quote-full.js - 종목 풀 정보
// history.js와 동일한 v8/finance/chart 엔드포인트 사용
// 사용법: GET /api/quote-full?symbol=SOXL

export default async function handler(req, res) {
const { symbol } = req.query;

if (!symbol) {
return res.status(400).json({ error: ‘symbol 파라미터 필수’ });
}

const sym = symbol.toUpperCase().trim();

try {
const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?range=5d&interval=1d&includePrePost=false`;

```
const yahooRes = await fetch(url, {
  headers: {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Accept': 'application/json'
  }
});

if (!yahooRes.ok) {
  return res.status(502).json({ error: `Yahoo API ${yahooRes.status}`, symbol: sym });
}

const data = await yahooRes.json();

if (data?.chart?.error) {
  return res.status(502).json({ error: data.chart.error.description || '종목 없음', symbol: sym });
}

const result = data?.chart?.result?.[0];
if (!result) {
  return res.status(404).json({ error: '데이터 없음', symbol: sym });
}

const meta = result.meta || {};
const quote = result.indicators?.quote?.[0] || {};
const closes = quote.close || [];
const volumes = quote.volume || [];
const highs = quote.high || [];
const lows = quote.low || [];
const opens = quote.open || [];

let lastIdx = closes.length - 1;
while (lastIdx >= 0 && closes[lastIdx] == null) lastIdx--;
let prevIdx = lastIdx - 1;
while (prevIdx >= 0 && closes[prevIdx] == null) prevIdx--;

const price = meta.regularMarketPrice ?? (lastIdx >= 0 ? closes[lastIdx] : null);
const previousClose = meta.chartPreviousClose ?? meta.previousClose ?? (prevIdx >= 0 ? closes[prevIdx] : null);
const change = price != null && previousClose != null ? price - previousClose : 0;
const changePercent = price != null && previousClose != null && previousClose > 0
  ? (change / previousClose) * 100
  : 0;

const dayHigh = meta.regularMarketDayHigh ?? (lastIdx >= 0 ? highs[lastIdx] : null);
const dayLow = meta.regularMarketDayLow ?? (lastIdx >= 0 ? lows[lastIdx] : null);
const open = lastIdx >= 0 ? opens[lastIdx] : null;
const volume = meta.regularMarketVolume ?? (lastIdx >= 0 ? volumes[lastIdx] : 0);

const response = {
  symbol: meta.symbol || sym,
  longName: meta.longName || meta.shortName || sym,
  exchange: meta.fullExchangeName || meta.exchangeName || '',
  currency: meta.currency || 'USD',
  price: price,
  previousClose: previousClose,
  change: change,
  changePercent: changePercent,
  open: open,
  dayHigh: dayHigh,
  dayLow: dayLow,
  volume: volume,
  avgVolume: null,
  marketCap: null,
  sharesOutstanding: null,
  high52: meta.fiftyTwoWeekHigh || null,
  low52: meta.fiftyTwoWeekLow || null,
  change52Pct: null,
  peRatio: null,
  forwardPE: null,
  eps: null,
  beta: null,
  dividendYield: null,
  dividendRate: null,
  exDividendDate: null,
  marketTime: meta.regularMarketTime || null,
  marketState: meta.marketState || 'REGULAR',
  preMarketPrice: null,
  preMarketChangePercent: null,
  postMarketPrice: null,
  postMarketChangePercent: null,
};

res.setHeader('Cache-Control', 's-maxage=30, stale-while-revalidate=60');
return res.status(200).json(response);
```

} catch (err) {
console.error(‘quote-full error:’, err);
return res.status(500).json({ error: err.message || ‘Internal error’, symbol: sym });
}
}