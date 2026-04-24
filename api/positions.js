// =============================================
// /api/positions
// GET    : 포지션 조회 (기본 open만, ?all=true면 전체)
// POST   : 신규 매수 기록 (새 티어 생성)
// PATCH  : 기존 포지션 청산 (매도 체결 기록)
// =============================================

const db = require('./_lib/db');

const VALID_ZONES = ['top', 'mid', 'bot'];
const VALID_UNITS = [2, 4];

// ==================================================
// 유틸리티
// ==================================================

function authenticate(req) {
  const authHeader = req.headers.authorization || '';
  const token = authHeader.replace(/^Bearer\s+/i, '');
  const expectedSecret = process.env.HUNTER_API_SECRET;
  if (!expectedSecret) {
    return { ok: false, status: 500, error: 'HUNTER_API_SECRET not configured' };
  }
  if (token !== expectedSecret) {
    return { ok: false, status: 401, error: 'Unauthorized' };
  }
  return { ok: true };
}

function isValidDate(str) {
  return /^\d{4}-\d{2}-\d{2}$/.test(str) && !isNaN(Date.parse(str));
}

function sanityCheckPrice(price, referencePrice, maxDeviationPct = 30) {
  if (!referencePrice) return true; // 참조가 없으면 스킵
  const dev = Math.abs((price - referencePrice) / referencePrice) * 100;
  return dev <= maxDeviationPct;
}

// ==================================================
// HANDLERS
// ==================================================

async function handleGet(req, res) {
  const symbol = (req.query?.symbol || 'SOXL').toUpperCase();
  const includeAll = req.query?.all === 'true';

  try {
    const positions = includeAll
      ? await db.getAllPositions(symbol, 200)
      : await db.getOpenPositions(symbol);

    // 추가 정보 계산
    const enriched = positions.map(p => {
      const today = new Date().toISOString().slice(0, 10);
      const entryDate = new Date(p.entry_date);
      const now = new Date(today);
      const daysElapsed = Math.max(0, Math.floor((now - entryDate) / 86400000));

      const zoneConfig = {
        top: { tp: 0.025, fd: 7 },
        mid: { tp: 0.005, fd: 7 },
        bot: { tp: 0.030, fd: 10 }
      }[p.zone] || { tp: 0, fd: 0 };

      return {
        ...p,
        days_elapsed: daysElapsed,
        target_sell_price: Math.round(p.entry_price * (1 + zoneConfig.tp) * 100) / 100,
        force_exit_day: zoneConfig.fd,
        should_force_exit: p.status === 'open' && daysElapsed >= zoneConfig.fd
      };
    });

    const openPositions = enriched.filter(p => p.status === 'open');
    const closedPositions = enriched.filter(p => p.status === 'closed');

    return res.status(200).json({
      status: 'ok',
      symbol,
      summary: {
        open_count: openPositions.length,
        closed_count: closedPositions.length,
        total_units: openPositions.reduce((s, p) => s + (p.units || 0), 0),
        total_shares: openPositions.reduce((s, p) => s + (p.shares || 0), 0),
        total_realized_pnl: closedPositions.reduce((s, p) => s + (Number(p.realized_pnl) || 0), 0)
      },
      positions: enriched
    });
  } catch (err) {
    console.error('GET positions error:', err);
    return res.status(500).json({ error: 'Failed to fetch positions', detail: err.message });
  }
}

async function handlePost(req, res) {
  const body = req.body || {};
  const {
    symbol = 'SOXL',
    entry_price,
    shares,
    units,
    entry_date,
    zone,
    hts_order_id = null,
    reason = null
  } = body;

  // ----- 1. 필수 필드 검증 -----
  const missing = [];
  if (!entry_price) missing.push('entry_price');
  if (!shares) missing.push('shares');
  if (units === undefined) missing.push('units');
  if (!entry_date) missing.push('entry_date');
  if (!zone) missing.push('zone');

  if (missing.length > 0) {
    return res.status(400).json({
      error: 'Missing required fields',
      missing
    });
  }

  // ----- 2. 값 검증 -----
  const entryPriceNum = parseFloat(entry_price);
  const sharesNum = parseInt(shares);
  const unitsNum = parseInt(units);

  if (isNaN(entryPriceNum) || entryPriceNum <= 0) {
    return res.status(400).json({ error: 'Invalid entry_price' });
  }
  if (isNaN(sharesNum) || sharesNum <= 0) {
    return res.status(400).json({ error: 'Invalid shares' });
  }
  if (!VALID_UNITS.includes(unitsNum)) {
    return res.status(400).json({ error: `Invalid units (must be ${VALID_UNITS.join(' or ')})` });
  }
  if (!VALID_ZONES.includes(zone)) {
    return res.status(400).json({ error: `Invalid zone (must be one of ${VALID_ZONES.join(', ')})` });
  }
  if (!isValidDate(entry_date)) {
    return res.status(400).json({ error: 'Invalid entry_date (YYYY-MM-DD required)' });
  }

  try {
    // ----- 3. 중복 주문 체크 -----
    if (hts_order_id) {
      const recent = await db.getRecentOrders(100, symbol);
      const duplicate = recent.find(o => o.hts_order_id === hts_order_id);
      if (duplicate) {
        return res.status(409).json({
          error: 'Duplicate order',
          detail: `hts_order_id "${hts_order_id}" already recorded`,
          existing_order_id: duplicate.id
        });
      }
    }

    // ----- 4. 유닛 오버플로우 체크 -----
    const openPositions = await db.getOpenPositions(symbol);
    const currentUnits = openPositions.reduce((s, p) => s + (p.units || 0), 0);
    const newTotalUnits = currentUnits + unitsNum;
    const MAX_UNITS = 20;

    if (newTotalUnits > MAX_UNITS) {
      return res.status(409).json({
        error: 'Units overflow',
        detail: `Current ${currentUnits}u + new ${unitsNum}u = ${newTotalUnits}u would exceed TU(${MAX_UNITS})`
      });
    }

    // ----- 5. 가격 sanity check -----
    const latestMarket = await db.getLatestMarketData(symbol);
    if (latestMarket && latestMarket.close_price) {
      if (!sanityCheckPrice(entryPriceNum, latestMarket.close_price, 30)) {
        return res.status(400).json({
          error: 'Entry price sanity check failed',
          detail: `Entry $${entryPriceNum} deviates >30% from recent close $${latestMarket.close_price}`,
          recent_close: latestMarket.close_price
        });
      }
    }

    // ----- 6. 포지션 생성 -----
    const position = await db.createPosition({
      symbol,
      entry_price: entryPriceNum,
      shares: sharesNum,
      units: unitsNum,
      entry_date,
      zone
    });

    // ----- 7. 주문 이력 기록 (감사 추적) -----
    if (hts_order_id || reason) {
      await db.createOrder({
        symbol,
        action: 'BUY',
        order_type: 'LOC',
        shares: sharesNum,
        price: entryPriceNum,
        tier_label: `T${openPositions.length + 1}_${zone}`,
        position_id: position.id,
        reason
      }).then(order => {
        if (hts_order_id) {
          return db.updateOrderStatus(order.id, {
            status: 'filled',
            hts_order_id,
            filled_price: entryPriceNum,
            filled_shares: sharesNum
          });
        }
      }).catch(err => {
        console.warn('Order audit record failed (non-fatal):', err.message);
      });
    }

    return res.status(201).json({
      status: 'ok',
      position,
      summary: {
        new_total_units: newTotalUnits,
        remaining_units: MAX_UNITS - newTotalUnits,
        tier_number: openPositions.length + 1
      }
    });
  } catch (err) {
    console.error('POST positions error:', err);
    return res.status(500).json({ error: 'Failed to create position', detail: err.message });
  }
}

async function handlePatch(req, res) {
  const body = req.body || {};
  const {
    position_id,
    exit_price,
    exit_date,
    hts_order_id = null,
    reason = null,
    force_exit = false
  } = body;

  // ----- 1. 필수 필드 검증 -----
  if (!position_id) {
    return res.status(400).json({ error: 'Missing position_id' });
  }
  if (!exit_price) {
    return res.status(400).json({ error: 'Missing exit_price' });
  }
  if (!exit_date) {
    return res.status(400).json({ error: 'Missing exit_date' });
  }

  const exitPriceNum = parseFloat(exit_price);
  const positionIdNum = parseInt(position_id);

  if (isNaN(exitPriceNum) || exitPriceNum <= 0) {
    return res.status(400).json({ error: 'Invalid exit_price' });
  }
  if (isNaN(positionIdNum)) {
    return res.status(400).json({ error: 'Invalid position_id' });
  }
  if (!isValidDate(exit_date)) {
    return res.status(400).json({ error: 'Invalid exit_date (YYYY-MM-DD required)' });
  }

  try {
    // ----- 2. 중복 청산 주문 체크 -----
    if (hts_order_id) {
      const recent = await db.getRecentOrders(100);
      const duplicate = recent.find(o => o.hts_order_id === hts_order_id);
      if (duplicate) {
        return res.status(409).json({
          error: 'Duplicate order',
          detail: `hts_order_id "${hts_order_id}" already recorded`,
          existing_order_id: duplicate.id
        });
      }
    }

    // ----- 3. 포지션 청산 (db.closePosition이 상태/중복 검증 포함) -----
    const closedPosition = await db.closePosition(positionIdNum, {
      exit_price: exitPriceNum,
      exit_date
    });

    // ----- 4. 주문 이력 기록 -----
    if (hts_order_id || reason) {
      await db.createOrder({
        symbol: closedPosition.symbol,
        action: 'SELL',
        order_type: force_exit ? 'MOC' : 'LOC',
        shares: closedPosition.shares,
        price: exitPriceNum,
        tier_label: `T${positionIdNum}_exit`,
        position_id: closedPosition.id,
        reason: reason || (force_exit ? 'Force exit (time limit)' : 'Limit sell filled')
      }).then(order => {
        if (hts_order_id) {
          return db.updateOrderStatus(order.id, {
            status: 'filled',
            hts_order_id,
            filled_price: exitPriceNum,
            filled_shares: closedPosition.shares
          });
        }
      }).catch(err => {
        console.warn('Order audit record failed (non-fatal):', err.message);
      });
    }

    return res.status(200).json({
      status: 'ok',
      position: closedPosition,
      summary: {
        pnl_pct: closedPosition.realized_pct,
        pnl_usd: closedPosition.realized_pnl,
        holding_days: Math.floor((new Date(exit_date) - new Date(closedPosition.entry_date)) / 86400000)
      }
    });
  } catch (err) {
    console.error('PATCH positions error:', err);

    // 특정 에러는 더 친절한 상태코드로
    if (err.message.includes('not found')) {
      return res.status(404).json({ error: 'Position not found', detail: err.message });
    }
    if (err.message.includes('already closed')) {
      return res.status(409).json({ error: 'Position already closed', detail: err.message });
    }

    return res.status(500).json({ error: 'Failed to close position', detail: err.message });
  }
}

// ==================================================
// MAIN
// ==================================================

module.exports = async (req, res) => {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  // 인증
  const auth = authenticate(req);
  if (!auth.ok) {
    return res.status(auth.status).json({ error: auth.error });
  }

  // 메서드별 라우팅
  switch (req.method) {
    case 'GET':
      return handleGet(req, res);
    case 'POST':
      return handlePost(req, res);
    case 'PATCH':
      return handlePatch(req, res);
    default:
      return res.status(405).json({
        error: 'Method not allowed',
        allowed: ['GET', 'POST', 'PATCH']
      });
  }
};
