// api/quote.js - Vercel Serverless Function
// SOXL 전일 종가 + 20일 전고점 자동 조회
// ⭐ 백테와 일치: 항상 "확정된 종가" 사용!

export default async function handler(req, res) {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }
  
  try {
    // Yahoo Finance에서 2개월 일봉
    const url = 'https://query1.finance.yahoo.com/v8/finance/chart/SOXL?range=2mo&interval=1d';
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15'
      }
    });
    
    if (!response.ok) {
      throw new Error('Yahoo fetch failed: ' + response.status);
    }
    
    const data = await response.json();
    
    if (!data.chart || !data.chart.result || !data.chart.result[0]) {
      throw new Error('Invalid data format');
    }
    
    const result = data.chart.result[0];
    const meta = result.meta;
    const timestamps = result.timestamp;
    const quotes = result.indicators.quote[0];
    const closes = quotes.close;
    
    // ⭐ 백테 호환: "확정된 마지막 종가"만 사용!
    // 장중 가격이 아니라, 완료된 일봉의 종가!
    const validCloses = closes.filter(c => c !== null);
    const lastClose = validCloses[validCloses.length - 1];
    
    // 20일 전고점
    const last20 = validCloses.slice(-20);
    const high20 = Math.max(...last20);
    
    // 낙폭
    const drawdown = ((lastClose - high20) / high20 * 100).toFixed(2);
    
    // 구간 판정
    let zone;
    if (drawdown >= -10) zone = 'top';
    else if (drawdown <= -15) zone = 'bot';
    else zone = 'mid';
    
    const lastTs = timestamps[timestamps.length - 1];
    const lastDate = new Date(lastTs * 1000).toISOString().slice(0, 10);
    
    return res.status(200).json({
      symbol: 'SOXL',
      price: parseFloat(lastClose.toFixed(2)),
      high20: parseFloat(high20.toFixed(2)),
      drawdown: parseFloat(drawdown),
      zone: zone,
      lastDate: lastDate,
      marketState: meta.marketState,
      note: '확정 종가 기준 (백테 호환)',
      timestamp: new Date().toISOString()
    });
    
  } catch (error) {
    return res.status(500).json({
      error: error.message,
      hint: '야후 API 호출 실패. 수동 입력 필요.'
    });
  }
}
