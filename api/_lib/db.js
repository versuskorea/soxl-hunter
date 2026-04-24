// =============================================
// Supabase DB Client Wrapper
// api/_lib/db.js
// =============================================
// 모든 DB 작업은 이 파일을 통해 수행
// service_role key 사용 (서버 사이드 전용)

const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  throw new Error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in environment');
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
  db: { schema: 'public' }
});

// ==================================================
// CONFIG - 시스템 설정
// ==================================================

async function getConfig() {
  const { data, error } = await supabase
    .from('config')
    .select('*')
    .eq('id', 1)
    .single();
  if (error) throw new Error(`getConfig failed: ${error.message}`);
  return data;
}

async function updateSeed(newSeed, updatedBy = 'system') {
  const { data, error } = await supabase
    .from('config')
    .update({
      seed: newSeed,
      last_updated_by: updatedBy
    })
    .eq('id', 1)
    .select()
    .single();
  if (error) throw new Error(`updateSeed failed: ${error.message}`);
  return data;
}

async function setTradingEnabled(enabled, reason = null, updatedBy = 'system') {
  const { data, error } = await supabase
    .from('config')
    .update({
      trading_enabled: enabled,
      emergency_stop_reason: reason,
      last_updated_by: updatedBy
    })
    .eq('id', 1)
    .select()
    .single();
  if (error) throw new Error(`setTradingEnabled failed: ${error.message}`);
  return data;
}

// ==================================================
// POSITIONS - 보유 티어
// ==================================================

async function getOpenPositions(symbol = 'SOXL') {
  const { data, error } = await supabase
    .from('positions')
    .select('*')
    .eq('symbol', symbol)
    .eq('status', 'open')
    .order('entry_date', { ascending: true });
  if (error) throw new Error(`getOpenPositions failed: ${error.message}`);
  return data || [];
}

async function getAllPositions(symbol = 'SOXL', limit = 100) {
  const { data, error } = await supabase
    .from('positions')
    .select('*')
    .eq('symbol', symbol)
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) throw new Error(`getAllPositions failed: ${error.message}`);
  return data || [];
}

async function createPosition({ symbol = 'SOXL', entry_price, shares, units, entry_date, zone }) {
  const { data, error } = await supabase
    .from('positions')
    .insert({
      symbol,
      entry_price,
      shares,
      units,
      entry_date,
      zone,
      status: 'open'
    })
    .select()
    .single();
  if (error) throw new Error(`createPosition failed: ${error.message}`);
  return data;
}

async function closePosition(positionId, { exit_price, exit_date }) {
  // 먼저 position 조회
  const { data: pos, error: fetchErr } = await supabase
    .from('positions')
    .select('*')
    .eq('id', positionId)
    .single();
  if (fetchErr) throw new Error(`closePosition fetch failed: ${fetchErr.message}`);
  if (!pos) throw new Error(`Position ${positionId} not found`);
  if (pos.status === 'closed') throw new Error(`Position ${positionId} already closed`);

  const realized_pnl = (exit_price - pos.entry_price) * pos.shares;
  const realized_pct = ((exit_price - pos.entry_price) / pos.entry_price) * 100;

  const { data, error } = await supabase
    .from('positions')
    .update({
      status: 'closed',
      exit_price,
      exit_date,
      realized_pnl: Math.round(realized_pnl * 100) / 100,
      realized_pct: Math.round(realized_pct * 100) / 100
    })
    .eq('id', positionId)
    .select()
    .single();
  if (error) throw new Error(`closePosition failed: ${error.message}`);
  return data;
}

// ==================================================
// ORDERS - 주문 이력
// ==================================================

async function createOrder({
  symbol = 'SOXL',
  action,
  order_type,
  shares,
  price,
  tier_label,
  position_id = null,
  reason = null
}) {
  const { data, error } = await supabase
    .from('orders')
    .insert({
      symbol,
      action,
      order_type,
      shares,
      price,
      tier_label,
      position_id,
      reason,
      status: 'pending'
    })
    .select()
    .single();
  if (error) throw new Error(`createOrder failed: ${error.message}`);
  return data;
}

async function updateOrderStatus(orderId, {
  status,
  hts_order_id = null,
  filled_price = null,
  filled_shares = null,
  error_message = null
}) {
  const update = { status };
  if (hts_order_id) update.hts_order_id = hts_order_id;
  if (filled_price !== null) update.filled_price = filled_price;
  if (filled_shares !== null) update.filled_shares = filled_shares;
  if (error_message) update.error_message = error_message;
  if (status === 'filled') update.filled_at = new Date().toISOString();

  const { data, error } = await supabase
    .from('orders')
    .update(update)
    .eq('id', orderId)
    .select()
    .single();
  if (error) throw new Error(`updateOrderStatus failed: ${error.message}`);
  return data;
}

async function getOrdersByDate(date, symbol = 'SOXL') {
  const startOfDay = `${date}T00:00:00`;
  const endOfDay = `${date}T23:59:59`;
  const { data, error } = await supabase
    .from('orders')
    .select('*')
    .eq('symbol', symbol)
    .gte('submitted_at', startOfDay)
    .lte('submitted_at', endOfDay)
    .order('submitted_at', { ascending: false });
  if (error) throw new Error(`getOrdersByDate failed: ${error.message}`);
  return data || [];
}

async function getRecentOrders(limit = 50, symbol = 'SOXL') {
  const { data, error } = await supabase
    .from('orders')
    .select('*')
    .eq('symbol', symbol)
    .order('submitted_at', { ascending: false })
    .limit(limit);
  if (error) throw new Error(`getRecentOrders failed: ${error.message}`);
  return data || [];
}

// ==================================================
// MARKET DATA - 시장 데이터 캐시
// ==================================================

async function getLatestMarketData(symbol = 'SOXL') {
  const { data, error } = await supabase
    .from('market_data')
    .select('*')
    .eq('symbol', symbol)
    .order('data_date', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(`getLatestMarketData failed: ${error.message}`);
  return data;
}

async function getMarketDataByDate(date, symbol = 'SOXL') {
  const { data, error } = await supabase
    .from('market_data')
    .select('*')
    .eq('symbol', symbol)
    .eq('data_date', date)
    .maybeSingle();
  if (error) throw new Error(`getMarketDataByDate failed: ${error.message}`);
  return data;
}

async function upsertMarketData({ symbol = 'SOXL', data_date, close_price, high_20, zone, drawdown_pct }) {
  const { data, error } = await supabase
    .from('market_data')
    .upsert({
      symbol,
      data_date,
      close_price,
      high_20,
      zone,
      drawdown_pct,
      fetched_at: new Date().toISOString()
    }, { onConflict: 'symbol,data_date' })
    .select()
    .single();
  if (error) throw new Error(`upsertMarketData failed: ${error.message}`);
  return data;
}

// ==================================================
// DAILY LOG - 일별 요약
// ==================================================

async function upsertDailyLog(logData) {
  const { data, error } = await supabase
    .from('daily_log')
    .upsert(logData, { onConflict: 'log_date' })
    .select()
    .single();
  if (error) throw new Error(`upsertDailyLog failed: ${error.message}`);
  return data;
}

async function getDailyLog(date) {
  const { data, error } = await supabase
    .from('daily_log')
    .select('*')
    .eq('log_date', date)
    .maybeSingle();
  if (error) throw new Error(`getDailyLog failed: ${error.message}`);
  return data;
}

// ==================================================
// SUMMARY - 대시보드용 통합 조회
// ==================================================

async function getTodaySummary() {
  const { data, error } = await supabase
    .from('v_today_summary')
    .select('*')
    .single();
  if (error) throw new Error(`getTodaySummary failed: ${error.message}`);
  return data;
}

// ==================================================
// EXPORTS
// ==================================================

module.exports = {
  supabase,
  // config
  getConfig,
  updateSeed,
  setTradingEnabled,
  // positions
  getOpenPositions,
  getAllPositions,
  createPosition,
  closePosition,
  // orders
  createOrder,
  updateOrderStatus,
  getOrdersByDate,
  getRecentOrders,
  // market data
  getLatestMarketData,
  getMarketDataByDate,
  upsertMarketData,
  // daily log
  upsertDailyLog,
  getDailyLog,
  // summary
  getTodaySummary
};
