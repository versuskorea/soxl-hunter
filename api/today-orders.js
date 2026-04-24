// =============================================
// POST /api/today-orders
// Python이 매매 시작 전 호출하는 메인 엔드포인트
// =============================================
// 흐름:
//  1. Bearer Token 인증
//  2. 시장 데이터 조회 (quote.js 내부 호출)
//  3. DB에서 config, open positions 로드
//  4. hunter.js로 오늘의 주문 계산
//  5. 검증 후 JSON 응답

const hunter = require('./_lib/hunter');
const db = require('./_lib/db');

// 야후 파이낸스 quote 조회 (기존 quote.js 로직 재사용 or 직접 호출)
async function fetchMarketData(symbol = 'SOXL') {
  // Production 도메인 직접 호출 (Vercel Preview Protection 회피)
  const base = 'https://soxl-hunter.vercel.app';
  const url = `${base}/api/quote?symbol=${symbol}`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`fetchMarketData failed: ${res.status} ${res.statusText}`);
  }
  const data = await res.json();
  if (data.error) {
    throw new Error(`fetchMarketData error: ${data.error}`);
  }
  return data; // { price, high20, lastDate, marketState, ... }
}

// 미국 증시 영업일 여부 (간단 버전 - 주말만 체크)
// TODO: 추후 미국 공휴일 달력 추가
function isUSTradingDay(date = new Date()) {
  const dow = date.getUTCDay();
  return dow !== 0 && dow !== 6;
}

module.exports = async (req, res) => {
  // CORS 헤더 (Python requests는 필요 없지만, 테스트 편의)
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST' && req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // ----- 1. 인증 -----
  const authHeader = req.headers.authorization || '';
  const token = authHeader.replace(/^Bearer\s+/i, '');
  const expectedSecret = process.env.HUNTER_API_SECRET;

  if (!expectedSecret) {
    return res.status(500).json({ error: 'HUNTER_API_SECRET not configured on server' });
  }
  if (token !== expectedSecret) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    const symbol = (req.query?.symbol || req.body?.symbol || 'SOXL').toUpperCase();
    const dryRun = req.query?.dry_run === 'true' || req.body?.dry_run === true;

    // ----- 2. 설정 & 오픈 포지션 로드 -----
    const config = await db.getConfig();
    const positions = await db.getOpenPositions(symbol);

    // 매매 중단 플래그 체크
    if (!config.trading_enabled) {
      return res.status(200).json({
        status: 'trading_disabled',
        reason: config.emergency_stop_reason || 'Trading is currently disabled',
        date: new Date().toISOString().slice(0, 10),
        symbol,
        buy_orders: [],
        sell_orders: [],
        forced_exits: []
      });
    }

    // ----- 3. 시장 데이터 조회 -----
    let marketData;
    try {
      marketData = await fetchMarketData(symbol);
    } catch (err) {
      return res.status(502).json({
        error: 'Failed to fetch market data',
        detail: err.message
      });
    }

    const lastClose = parseFloat(marketData.price);
    const high20 = parseFloat(marketData.high20);
    const lastDate = marketData.lastDate;

    if (!lastClose || !high20) {
      return res.status(502).json({
        error: 'Invalid market data received',
        received: marketData
      });
    }

    // 시장 데이터 DB 캐시
    const zone = hunter.calculateZone(lastClose, high20);
    const drawdown = hunter.calculateDrawdown(lastClose, high20);

    await db.upsertMarketData({
      symbol,
      data_date: lastDate,
      close_price: lastClose,
      high_20: high20,
      zone,
      drawdown_pct: Math.round(drawdown * 100) / 100
    }).catch(err => {
      console.warn('Market data cache failed (non-fatal):', err.message);
    });

    // ----- 4. 주문 계산 -----
    const today = new Date().toISOString().slice(0, 10);

    const result = hunter.calculateTodayOrders({
      seed: parseFloat(config.seed),
      lastClose,
      high20,
      positions,
      today
    });

    // ----- 5. 응답 조립 -----
    const response = {
      status: 'ok',
      date: today,
      symbol,
      market_data: {
        last_close: lastClose,
        high_20: high20,
        zone,
        zone_label: hunter.ZONES[zone].label,
        drawdown_pct: result.market_data.drawdown_pct,
        last_data_date: lastDate,
        market_state: marketData.marketState || 'unknown'
      },
      buy_orders: result.buy_orders,
      sell_orders: result.sell_orders,
      forced_exits: result.forced_exits,
      validation: result.validation,
      positions: positions.map(p => ({
        id: p.id,
        entry_price: p.entry_price,
        shares: p.shares,
        units: p.units,
        entry_date: p.entry_date,
        zone: p.zone
      })),
      config: {
        trading_enabled: config.trading_enabled,
        symbol: config.symbol
      },
      meta: {
        is_trading_day: isUSTradingDay(),
        dry_run: dryRun,
        generated_at: new Date().toISOString()
      }
    };

    return res.status(200).json(response);

  } catch (err) {
    console.error('today-orders error:', err);
    return res.status(500).json({
      error: 'Internal server error',
      detail: err.message
    });
  }
};
