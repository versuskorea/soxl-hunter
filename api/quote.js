// api/quote.js - Vercel Serverless Function
// SOXL 전일 종가 + 20일 전고점 자동 조회
// ⭐ v8 수정: 항상 "확정된 전일 종가"만 사용! (장중 가격 X)
// ⭐ 고가도 종가 기준으로 계산!

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
    
    // ⭐⭐⭐ v8 핵심 수정 ⭐⭐⭐
    // 마지막 캔들이 오늘(장중)이면 제외!
    // 항상 "확정된 종가"만 사용!
    
    // 1. null 제외하고 유효한 (timestamp, close) 쌍만 추출
    const validData = [];
    for (let i = 0; i < timestamps.length; i++) {
      if (closes[i] !== null && closes[i] !== undefined) {
        validData.push({
          ts: timestamps[i],
          close: closes[i],
          date: new Date(timestamps[i] * 1000).toISOString().slice(0, 10)
        });
      }
    }
    
    // 2. 오늘 날짜 캔들 감지 및 제거 (장중이면 확정 X!)
    const todayUTC = new Date().toISOString().slice(0, 10);
    const marketState = meta.marketState; // REGULAR, PRE, POST, CLOSED
    
    // 장이 열려있거나 후장이면 오늘 캔들 제거
    // (장 마감 후 CLOSED 상태면 오늘 종가도 확정!)
    const isMarketOpen = marketState === 'REGULAR' || marketState === 'PRE';
    
    let confirmedData = validData;
    if (isMarketOpen && validData.length > 0) {
      const lastDate = validData[validData.length - 1].date;
      if (lastDate === todayUTC) {
        // 오늘 장중이면 제거!
        confirmedData = validData.slice(0, -1);
      }
    }
    
    if (confirmedData.length === 0) {
      throw new Error('No confirmed close data');
    }
    
    // 3. 확정된 마지막 종가 (어제 종가)
    const lastClose = confirmedData[confirmedData.length - 1].close;
    const lastDate = confirmedData[confirmedData.length - 1].date;
    
    // 4. ⭐ 20일 전고점도 "종가" 기준!
    // (intraday 고가가 아니라 확정 종가 중 최고!)
    const last20Closes = confirmedData.slice(-20).map(d => d.close);
    const high20 = Math.max(...last20Closes);
    
    // 낙폭
    const drawdown = ((lastClose - high20) / high20 * 100).toFixed(2);
    
    // 구간 판정
    let zone;
    if (drawdown >= -10) zone = 'top';
    else if (drawdown <= -15) zone = 'bot';
    else zone = 'mid';
    
    return res.status(200).json({
      symbol: 'SOXL',
      price: parseFloat(lastClose.toFixed(2)),
      high20: parseFloat(high20.toFixed(2)),
      drawdown: parseFloat(drawdown),
      zone: zone,
      lastDate: lastDate,
      marketState: marketState,
      marketOpen: isMarketOpen,
      dataPoints: confirmedData.length,
      note: '확정 종가만 사용 (장중 제외) · 고가도 종가 기준',
      timestamp: new Date().toISOString()
    });
    
  } catch (error) {
    return res.status(500).json({
      error: error.message,
      hint: '야후 API 호출 실패. 수동 입력 필요.'
    });
  }
}
