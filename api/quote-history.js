// =============================================
// GET /api/quote-history?symbol=POET&from=2023-01-01
// 야후 파이낸스에서 기간별 OHLC 조회 (서버 프록시, CORS 우회)
// =============================================
// v2: https 모듈 사용으로 Node 버전 무관하게 작동
// =============================================

const https = require(‘https’);

function httpsGetJson(url) {
return new Promise((resolve, reject) => {
const options = {
headers: {
‘User-Agent’: ‘Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36’,
‘Accept’: ‘application/json, text/plain, */*’,
‘Accept-Language’: ‘en-US,en;q=0.9’
}
};

```
const req = https.get(url, options, (res) => {
  let data = '';
  res.on('data', chunk => data += chunk);
  res.on('end', () => {
    if (res.statusCode >= 200 && res.statusCode < 300) {
      try {
        resolve({ status: res.statusCode, data: JSON.parse(data) });
      } catch (err) {
        reject(new Error(`JSON parse failed: ${err.message}`));
      }
    } else {
      resolve({ status: res.statusCode, data: null, raw: data.slice(0, 500) });
    }
  });
});

req.on('error', reject);
req.setTimeout(15000, () => {
  req.destroy(new Error('Request timeout (15s)'));
});
```

});
}

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
const symbol = String(req.query?.symbol || ‘POET’).toUpperCase().trim();
const fromDate = String(req.query?.from || ‘2023-01-01’).trim();
const toDate = req.query?.to ? String(req.query.to).trim() : null;

```
if (!/^[A-Z0-9.\-]{1,10}$/.test(symbol)) {
  return res.status(400).json({ error: 'Invalid symbol', symbol });
}

if (!/^\d{4}-\d{2}-\d{2}$/.test(fromDate)) {
  return res.status(400).json({ error: 'Invalid from date (YYYY-MM-DD)', fromDate });
}
if (toDate && !/^\d{4}-\d{2}-\d{2}$/.test(toDate)) {
  return res.status(400).json({ error: 'Invalid to date (YYYY-MM-DD)', toDate });
}

const fromTime = new Date(fromDate + 'T00:00:00Z').getTime();
if (isNaN(fromTime)) {
  return res.status(400).json({ error: 'Invalid from timestamp', fromDate });
}
const period1 = Math.floor(fromTime / 1000);

let period2;
if (toDate) {
  const toTime = new Date(toDate + 'T23:59:59Z').getTime();
  if (isNaN(toTime)) {
    return res.status(400).json({ error: 'Invalid to timestamp', toDate });
  }
  period2 = Math.floor(toTime / 1000);
} else {
  period2 = Math.floor(Date.now() / 1000);
}

if (period1 >= period2) {
  return res.status(400).json({ error: 'from must be before to' });
}

const yahooUrl = `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?period1=${period1}&period2=${period2}&interval=1d&events=history&includeAdjustedClose=true`;

const { status, data: yahooData, raw } = await httpsGetJson(yahooUrl);

if (status !== 200 || !yahooData) {
  return res.status(502).json({
    error: 'Yahoo API error',
    status,
    preview: raw ? raw.slice(0, 200) : null
  });
}

const chart = yahooData.chart;
if (!chart) {
  return res.status(502).json({ error: 'No chart in Yahoo response' });
}

if (chart.error) {
  return res.status(404).json({
    error: 'Yahoo returned error',
    yahooError: chart.error
  });
}

const result = chart.result && chart.result[0];
if (!result) {
  return res.status(404).json({ error: 'No result data' });
}

const timestamps = result.timestamp || [];
const indicators = result.indicators || {};
const quote = indicators.quote && indicators.quote[0];
const adjClose = indicators.adjclose && indicators.adjclose[0] && indicators.adjclose[0].adjclose;

if (!quote || timestamps.length === 0) {
  return res.status(404).json({ error: 'No OHLC data', symbol });
}

const bars = [];
for (let i = 0; i < timestamps.length; i++) {
  const close = quote.close ? quote.close[i] : null;
  if (close == null) continue;

  const round4 = (v) => v == null ? null : Math.round(v * 10000) / 10000;

  bars.push({
    date: new Date(timestamps[i] * 1000).toISOString().slice(0, 10),
    open: round4(quote.open && quote.open[i]) || round4(close),
    high: round4(quote.high && quote.high[i]) || round4(close),
    low: round4(quote.low && quote.low[i]) || round4(close),
    close: round4(close),
    adjClose: round4(adjClose && adjClose[i]) || round4(close),
    volume: (quote.volume && quote.volume[i]) || 0
  });
}

res.setHeader('Cache-Control', 'public, s-maxage=1800, stale-while-revalidate=3600');

return res.status(200).json({
  symbol,
  from: fromDate,
  to: bars.length > 0 ? bars[bars.length - 1].date : fromDate,
  count: bars.length,
  currency: (result.meta && result.meta.currency) || 'USD',
  exchange: (result.meta && result.meta.exchangeName) || null,
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