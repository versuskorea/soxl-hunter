// =============================================
// GET /api/quote-history?symbol=POET&from=2023-01-01
// 야후 파이낸스에서 기간별 OHLC 데이터 조회 (서버 프록시)
// =============================================
// 사용 예:
//   /api/quote-history?symbol=POET&from=2023-01-01
//   /api/quote-history?symbol=SOXL&from=2020-01-01&to=2026-04-24

module.exports = async (req, res) => {
res.setHeader(‘Access-Control-Allow-Origin’, ‘*’);
res.setHeader(‘Access-Control-Allow-Methods’, ‘GET, OPTIONS’);
res.setHeader(‘Access-Control-Allow-Headers’, ‘Content-Type’);

if (req.method === ‘OPTIONS’) {
return res.status(200).end();
}

if (req.method !== ‘GET’) {
return res.status(405).json({ error: ‘Method not allowed’ });
}

try {
const symbol = (req.query?.symbol || ‘POET’).toUpperCase();
const fromDate = req.query?.from || ‘2023-01-01’;
const toDate = req.query?.to || null;
const interval = req.query?.interval || ‘1d’;

```
// 날짜 검증
if (!/^\d{4}-\d{2}-\d{2}$/.test(fromDate)) {
  return res.status(400).json({ error: 'Invalid from date (YYYY-MM-DD required)' });
}
if (toDate && !/^\d{4}-\d{2}-\d{2}$/.test(toDate)) {
  return res.status(400).json({ error: 'Invalid to date (YYYY-MM-DD required)' });
}

// Unix timestamp 변환
const period1 = Math.floor(new Date(fromDate + 'T00:00:00Z').getTime() / 1000);
const period2 = toDate
  ? Math.floor(new Date(toDate + 'T23:59:59Z').getTime() / 1000)
  : Math.floor(Date.now() / 1000);

if (isNaN(period1) || isNaN(period2)) {
  return res.status(400).json({ error: 'Invalid date format' });
}

// 야후 파이낸스 API 호출
const yahooUrl = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?period1=${period1}&period2=${period2}&interval=${interval}&events=history&includeAdjustedClose=true`;

const yahooRes = await fetch(yahooUrl, {
  headers: {
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Accept': 'application/json',
    'Accept-Language': 'en-US,en;q=0.9'
  }
});

if (!yahooRes.ok) {
  return res.status(502).json({
    error: 'Yahoo API error',
    status: yahooRes.status,
    statusText: yahooRes.statusText
  });
}

const yahooData = await yahooRes.json();
const result = yahooData.chart?.result?.[0];

if (!result) {
  return res.status(404).json({
    error: 'No data returned',
    symbol,
    yahooError: yahooData.chart?.error
  });
}

const timestamps = result.timestamp || [];
const quote = result.indicators?.quote?.[0];
const adjClose = result.indicators?.adjclose?.[0]?.adjclose;

if (!quote || timestamps.length === 0) {
  return res.status(404).json({ error: 'No OHLC data in response' });
}

// OHLC 배열 조립 (null 값 제외)
const bars = [];
for (let i = 0; i < timestamps.length; i++) {
  const close = quote.close[i];
  if (close == null) continue;

  bars.push({
    date: new Date(timestamps[i] * 1000).toISOString().slice(0, 10),
    open: quote.open[i] != null ? Math.round(quote.open[i] * 10000) / 10000 : close,
    high: quote.high[i] != null ? Math.round(quote.high[i] * 10000) / 10000 : close,
    low: quote.low[i] != null ? Math.round(quote.low[i] * 10000) / 10000 : close,
    close: Math.round(close * 10000) / 10000,
    adjClose: adjClose && adjClose[i] != null ? Math.round(adjClose[i] * 10000) / 10000 : Math.round(close * 10000) / 10000,
    volume: quote.volume[i] || 0
  });
}

// 응답 (Vercel Edge 캐시 힌트)
res.setHeader('Cache-Control', 'public, s-maxage=1800, stale-while-revalidate=3600');

return res.status(200).json({
  symbol,
  from: fromDate,
  to: bars.length > 0 ? bars[bars.length - 1].date : fromDate,
  interval,
  count: bars.length,
  currency: result.meta?.currency || 'USD',
  exchange: result.meta?.exchangeName || null,
  bars
});
```

} catch (err) {
console.error(‘quote-history error:’, err);
return res.status(500).json({
error: ‘Internal server error’,
detail: err.message
});
}
};