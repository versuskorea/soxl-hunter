// =============================================
// SOXL HUNTER - Pure Calculation Logic
// v8.html에서 추출 · Node.js + Browser 호환
// =============================================

// ---------- 상수 ----------
const TU = 20;        // Total Units
const UP = 2;         // 상승일 매수 유닛
const DN = 4;         // 하락일 매수 유닛
const TOP_TH = -10;   // Top/Mid 경계 (drawdown %)
const BOT_TH = -15;   // Mid/Bot 경계

const ZONES = {
  top: { tp: 0.025, fd: 7,  label: '천장', color: 'top' },
  mid: { tp: 0.005, fd: 7,  label: '중간', color: 'mid' },
  bot: { tp: 0.030, fd: 10, label: '바닥', color: 'bot' }
};

// ---------- 유틸 ----------

/**
 * 현재 구간 판정
 * @param {number} lastClose 어제 종가
 * @param {number} high20    20일 전고
 * @returns {'top'|'mid'|'bot'}
 */
function calculateZone(lastClose, high20) {
  if (!lastClose || !high20) return 'top';
  const dd = ((lastClose - high20) / high20) * 100;
  if (dd >= TOP_TH) return 'top';
  if (dd <= BOT_TH) return 'bot';
  return 'mid';
}

/**
 * drawdown 퍼센트 계산
 */
function calculateDrawdown(lastClose, high20) {
  if (!lastClose || !high20) return 0;
  return ((lastClose - high20) / high20) * 100;
}

/**
 * 영업일 경과일 계산 (주말 제외)
 */
function businessDaysBetween(startDate, endDate) {
  const start = new Date(startDate);
  const end = new Date(endDate);
  let days = 0;
  const cur = new Date(start);
  while (cur < end) {
    cur.setDate(cur.getDate() + 1);
    const dow = cur.getDay();
    if (dow !== 0 && dow !== 6) days++;
  }
  return days;
}

// ---------- 매수 주문 계산 ----------

/**
 * 오늘의 매수 LOC 주문 생성
 * @param {Object} params
 * @param {number} params.seed       - 시드 금액 ($)
 * @param {number} params.lastClose  - 어제 확정 종가
 * @param {number} params.high20     - 20일 전고
 * @param {number} params.currentUnits - 현재 투입된 유닛 수
 * @returns {Array} 매수 주문 배열
 */
function calculateBuyOrders({ seed, lastClose, high20, currentUnits }) {
  const remainingUnits = TU - currentUnits;

  // TU 꽉 찼으면 매수 없음
  if (remainingUnits <= 0) {
    return [];
  }

  if (!lastClose || lastClose <= 0) {
    return [];
  }

  const zone = calculateZone(lastClose, high20);
  const unitValue = seed / TU;

  // 가격 계산
  const loc1Price = Math.round(lastClose * 1.15 * 100) / 100;  // 전날×1.15
  const loc2Price = Math.round((lastClose - 0.01) * 100) / 100; // 전날-$0.01

  // 주수 계산
  const sharesUp = Math.floor((UP * unitValue) / lastClose);
  const sharesDn = Math.floor((DN * unitValue) / lastClose);
  const sharesDnExtra = sharesDn - sharesUp;

  const orders = [];

  // ① 무조건 매수 (상승일 시나리오 커버)
  if (sharesUp > 0) {
    orders.push({
      action: 'BUY',
      type: 'LOC',
      shares: sharesUp,
      price: loc1Price,
      tier_label: 'up_2u',
      condition: 'always',
      units: UP,
      zone_at_submit: zone,
      reason: `${UP}u · 전날×1.15 LOC (${ZONES[zone].label} 구간)`
    });
  }

  // ② 하락 추가 매수
  if (sharesDnExtra > 0) {
    orders.push({
      action: 'BUY',
      type: 'LOC',
      shares: sharesDnExtra,
      price: loc2Price,
      tier_label: 'dn_2u_extra',
      condition: 'down_day_only',
      units: DN - UP,
      zone_at_submit: zone,
      reason: `추가 ${DN - UP}u · 전날-$0.01 LOC (하락시)`
    });
  }

  return orders;
}

// ---------- 매도 주문 계산 ----------

/**
 * 각 티어별 매도 LOC 주문 생성
 * @param {Object} params
 * @param {Array}  params.positions - 오픈 포지션 배열
 * @param {string} params.today     - 오늘 날짜 (YYYY-MM-DD)
 * @returns {Object} { limitSells, forcedExits }
 */
function calculateSellOrders({ positions, today }) {
  const limitSells = [];
  const forcedExits = [];

  if (!positions || positions.length === 0) {
    return { limitSells, forcedExits };
  }

  positions.forEach((pos, idx) => {
    const zone = pos.zone;
    const zoneCfg = ZONES[zone];
    if (!zoneCfg) return;

    const daysElapsed = businessDaysBetween(pos.entry_date, today);
    const sellPrice = Math.round(pos.entry_price * (1 + zoneCfg.tp) * 100) / 100;
    const isForceExit = daysElapsed >= zoneCfg.fd;

    if (isForceExit) {
      // 강제 청산 - MOC 시장가 매도
      forcedExits.push({
        action: 'SELL',
        type: 'MOC',
        shares: pos.shares,
        price: null,
        tier_idx: idx,
        tier_label: `T${idx + 1}_force_exit`,
        position_id: pos.id,
        units: pos.units,
        zone: zone,
        days_elapsed: daysElapsed,
        reason: `T${idx + 1} 강제청산 (${zoneCfg.fd}일 초과 · ${zoneCfg.label})`
      });
    } else {
      // 정상 매도 LOC
      limitSells.push({
        action: 'SELL',
        type: 'LOC',
        shares: pos.shares,
        price: sellPrice,
        tier_idx: idx,
        tier_label: `T${idx + 1}_limit`,
        position_id: pos.id,
        units: pos.units,
        zone: zone,
        entry_price: pos.entry_price,
        days_elapsed: daysElapsed,
        days_remaining: zoneCfg.fd - daysElapsed,
        target_pct: zoneCfg.tp * 100,
        reason: `T${idx + 1} +${(zoneCfg.tp * 100).toFixed(1)}% LOC · D+${daysElapsed} (${zoneCfg.label})`
      });
    }
  });

  return { limitSells, forcedExits };
}

// ---------- 통합 계산 ----------

/**
 * 오늘의 모든 주문 생성 (매수 + 매도)
 * @param {Object} params
 * @param {number} params.seed
 * @param {number} params.lastClose
 * @param {number} params.high20
 * @param {Array}  params.positions  - DB에서 가져온 오픈 포지션
 * @param {string} params.today      - YYYY-MM-DD
 * @returns {Object} 전체 주문 계산 결과
 */
function calculateTodayOrders({ seed, lastClose, high20, positions, today }) {
  const currentUnits = positions.reduce((sum, p) => sum + (p.units || 0), 0);
  const zone = calculateZone(lastClose, high20);
  const drawdown = calculateDrawdown(lastClose, high20);

  const buyOrders = calculateBuyOrders({
    seed,
    lastClose,
    high20,
    currentUnits
  });

  const { limitSells, forcedExits } = calculateSellOrders({
    positions,
    today
  });

  // 총 매수 예상 금액 (validation 용)
  const totalBuyUsd = buyOrders.reduce(
    (sum, o) => sum + (o.shares * o.price),
    0
  );

  return {
    date: today,
    symbol: positions[0]?.symbol || 'SOXL',
    market_data: {
      last_close: lastClose,
      high_20: high20,
      zone: zone,
      zone_label: ZONES[zone].label,
      drawdown_pct: Math.round(drawdown * 100) / 100
    },
    buy_orders: buyOrders,
    sell_orders: limitSells,
    forced_exits: forcedExits,
    validation: {
      seed: seed,
      unit_value: seed / TU,
      current_units: currentUnits,
      max_units: TU,
      remaining_units: TU - currentUnits,
      can_buy: (TU - currentUnits) > 0,
      total_buy_usd: Math.round(totalBuyUsd * 100) / 100,
      open_positions_count: positions.length
    }
  };
}

// ---------- 내보내기 (Node.js & Browser 호환) ----------

const HunterLogic = {
  // 상수
  TU, UP, DN, TOP_TH, BOT_TH, ZONES,

  // 순수 함수
  calculateZone,
  calculateDrawdown,
  businessDaysBetween,
  calculateBuyOrders,
  calculateSellOrders,
  calculateTodayOrders
};

// CommonJS (Node.js, Vercel)
if (typeof module !== 'undefined' && module.exports) {
  module.exports = HunterLogic;
}

// Browser (window.HunterLogic)
if (typeof window !== 'undefined') {
  window.HunterLogic = HunterLogic;
}
