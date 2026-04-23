// api/history.js - Yahoo Finance 일봉 히스토리 데이터 가져오기
// 사용법: GET /api/history?symbol=SOXL&start=2025-01-01&end=2026-04-23

export default async function handler(req, res) {
  const { symbol, start, end } = req.query;
  
  if (!symbol) {
    return res.status(400).json({ error: 'symbol 파라미터 필수' });
  }
  if (!start || !end) {
    return res.status(400).json({ error: 'start, end 파라미터 필수 (YYYY-MM-DD)' });
  }
  
  try {
    // 날짜 → Unix timestamp 변환
    const startTs = Math.floor(new Date(start).getTime() / 1000);
    const endTs = Math.floor(new Date(end).getTime() / 1000) + 86400; // 종료일 포함
    
    if (isNaN(startTs) || isNaN(endTs)) {
      return res.status(400).json({ error: '날짜 형식 오류 (YYYY-MM-DD 필요)' });
    }
    
    // Yahoo Finance API 호출
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?period1=${startTs}&period2=${endTs}&interval=1d&includePrePost=false&events=div%7Csplit`;
    
    const yahooRes = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'application/json'
      }
    });
    
    if (!yahooRes.ok) {
      return res.status(502).json({ error: `Yahoo API ${yahooRes.status}` });
    }
    
    const data = await yahooRes.json();
    
    // 에러 체크
    if (data?.chart?.error) {
      return res.status(502).json({ error: data.chart.error.description || '종목 없음' });
    }
    
    const result = data?.chart?.result?.[0];
    if (!result) {
      return res.status(404).json({ error: '데이터 없음' });
    }
    
    const timestamps = result.timestamp || [];
    const quote = result.indicators?.quote?.[0] || {};
    const opens = quote.open || [];
    const highs = quote.high || [];
    const lows = quote.low || [];
    const closes = quote.close || [];
    const volumes = quote.volume || [];
    
    // bars 배열 구성 (종가 null인 날짜는 제외)
    const bars = [];
    for (let i = 0; i < timestamps.length; i++) {
      if (closes[i] == null) continue; // 휴장일/데이터 없음
      const d = new Date(timestamps[i] * 1000);
      const dateStr = d.toISOString().slice(0, 10);
      bars.push({
        date: dateStr,
        open: opens[i],
        high: highs[i],
        low: lows[i],
        close: closes[i],
        volume: volumes[i] || 0
      });
    }
    
    if (bars.length === 0) {
      return res.status(404).json({ error: '범위 내 거래 데이터 없음' });
    }
    
    // 캐시 헤더 (Vercel edge cache 1시간)
    res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate=86400');
    
    return res.status(200).json({
      symbol: symbol.toUpperCase(),
      firstPrice: bars[0].close,
      lastPrice: bars[bars.length - 1].close,
      barCount: bars.length,
      bars: bars
    });
    
  } catch (err) {
    console.error('history.js error:', err);
    return res.status(500).json({ error: err.message || '서버 오류' });
  }
}
