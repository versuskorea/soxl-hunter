// =============================================
// /api/config
// GET   : 현재 설정 조회
// PATCH : 시드, 매매 중단 플래그 등 수정
// =============================================

const db = require('./_lib/db');

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

async function handleGet(req, res) {
  try {
    const config = await db.getConfig();
    return res.status(200).json({
      status: 'ok',
      config
    });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to fetch config', detail: err.message });
  }
}

async function handlePatch(req, res) {
  const body = req.body || {};
  const { seed, trading_enabled, emergency_stop_reason } = body;

  // 최소 하나는 변경해야 함
  if (seed === undefined && trading_enabled === undefined) {
    return res.status(400).json({
      error: 'No valid fields to update',
      allowed: ['seed', 'trading_enabled', 'emergency_stop_reason']
    });
  }

  try {
    const current = await db.getConfig();

    // ----- 시드 변경 -----
    if (seed !== undefined) {
      const seedNum = parseFloat(seed);
      if (isNaN(seedNum) || seedNum < 1000) {
        return res.status(400).json({
          error: 'Invalid seed',
          detail: 'Seed must be a number >= 1000'
        });
      }
      if (seedNum > 10000000) {
        return res.status(400).json({
          error: 'Seed too large',
          detail: 'Seed > $10M not allowed (sanity check)'
        });
      }

      // 큰 폭의 변경 경고 (2배 이상 or 1/2 이하)
      const changeRatio = seedNum / parseFloat(current.seed);
      const hugeChange = changeRatio > 2 || changeRatio < 0.5;

      await db.updateSeed(seedNum, 'hunter-ui');

      if (trading_enabled === undefined) {
        const updated = await db.getConfig();
        return res.status(200).json({
          status: 'ok',
          config: updated,
          note: hugeChange
            ? `Large change: $${current.seed} → $${seedNum} (${(changeRatio * 100).toFixed(0)}% of original)`
            : undefined
        });
      }
    }

    // ----- 매매 중단 토글 -----
    if (trading_enabled !== undefined) {
      const enabled = Boolean(trading_enabled);
      const reason = enabled ? null : (emergency_stop_reason || 'Manual pause');
      await db.setTradingEnabled(enabled, reason, 'hunter-ui');
    }

    const updated = await db.getConfig();
    return res.status(200).json({
      status: 'ok',
      config: updated
    });
  } catch (err) {
    console.error('PATCH config error:', err);
    return res.status(500).json({ error: 'Failed to update config', detail: err.message });
  }
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, PATCH, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  const auth = authenticate(req);
  if (!auth.ok) {
    return res.status(auth.status).json({ error: auth.error });
  }

  switch (req.method) {
    case 'GET':
      return handleGet(req, res);
    case 'PATCH':
      return handlePatch(req, res);
    default:
      return res.status(405).json({
        error: 'Method not allowed',
        allowed: ['GET', 'PATCH']
      });
  }
};
