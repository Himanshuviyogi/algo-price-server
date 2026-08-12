/**
 * riskManager.js
 * ───────────────
 * Pre-order risk checks. Every placeOrder() call must pass all checks here
 * before touching Angel One.
 *
 * Risk config is read from Firestore `app_config/algo_risk` and cached for
 * CACHE_TTL_MS (5 minutes) to avoid a Firestore read on every order.
 *
 * Firestore document shape — app_config/algo_risk:
 * {
 *   daily_loss_limit:       number,   // max rupee loss per user per day (e.g. 5000)
 *   max_open_positions:     number,   // max simultaneous open positions per user (e.g. 5)
 *   max_order_value:        number,   // max rupee value of a single order (e.g. 100000)
 *   position_sizing_percent: number,  // % of capital per trade — informational, not enforced here
 * }
 *
 * If the document is missing or a field is absent, safe defaults are used so
 * the server keeps running without admin intervention.
 */

const admin = require('firebase-admin');

// ── Cache ─────────────────────────────────────────────────────────────────────

const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

/** @type {{ config: RiskConfig, fetchedAt: number } | null} */
let _cache = null;

/**
 * @typedef {Object} RiskConfig
 * @property {number} daily_loss_limit        - max net loss (₹) per user per calendar day
 * @property {number} max_open_positions      - max open positions per user at any moment
 * @property {number} max_order_value         - max ₹ value of a single order
 * @property {number} position_sizing_percent - target % of capital per trade (informational)
 */

/** Safe fallback — permissive defaults so no orders are silently blocked if
 *  Firestore config is missing. Tune these to real risk limits before go-live. */
const DEFAULT_CONFIG = {
  daily_loss_limit:        10_000,
  max_open_positions:      10,
  max_order_value:         500_000,
  position_sizing_percent: 5,
};

// ── loadRiskConfig ────────────────────────────────────────────────────────────

/**
 * Load risk config from Firestore, or return the cached copy if fresh.
 * Exported so admin routes / tests can force a reload.
 *
 * @returns {Promise<RiskConfig>}
 */
async function loadRiskConfig() {
  const now = Date.now();

  if (_cache && (now - _cache.fetchedAt) < CACHE_TTL_MS) {
    return _cache.config;
  }

  try {
    const doc = await admin.firestore()
      .collection('app_config')
      .doc('algo_risk')
      .get();

    if (!doc.exists) {
      console.warn('[RiskManager] app_config/algo_risk not found — using defaults');
      _cache = { config: { ...DEFAULT_CONFIG }, fetchedAt: now };
      return _cache.config;
    }

    const data = doc.data();

    // Merge with defaults so missing fields don't cause NaN comparisons
    const cfg = {
      daily_loss_limit:        _toNumber(data.daily_loss_limit,        DEFAULT_CONFIG.daily_loss_limit),
      max_open_positions:      _toNumber(data.max_open_positions,      DEFAULT_CONFIG.max_open_positions),
      max_order_value:         _toNumber(data.max_order_value,         DEFAULT_CONFIG.max_order_value),
      position_sizing_percent: _toNumber(data.position_sizing_percent, DEFAULT_CONFIG.position_sizing_percent),
    };

    _cache = { config: cfg, fetchedAt: now };
    console.log('[RiskManager] Config loaded:', JSON.stringify(cfg));
    return cfg;
  } catch (err) {
    console.error('[RiskManager] Failed to load config — using defaults:', err.message);
    // Don't update fetchedAt so we retry sooner on next order
    return { ...DEFAULT_CONFIG };
  }
}

// ── Individual checks ─────────────────────────────────────────────────────────

/**
 * Synchronous check — is the order value within the single-order cap?
 *
 * @param {number} quantity
 * @param {number} price       - use 0 for MARKET orders (check is skipped)
 * @param {number} maxOrderValue
 * @returns {{ allowed: boolean, reason: string|null }}
 */
function isOrderValueExceeded(quantity, price, maxOrderValue) {
  // Skip value check for MARKET orders where price isn't known upfront
  if (!price || price <= 0) return { allowed: true, reason: null };

  const orderValue = quantity * price;
  if (orderValue > maxOrderValue) {
    return {
      allowed: false,
      reason:  `Order value ₹${orderValue.toFixed(2)} exceeds limit ₹${maxOrderValue.toFixed(2)}`,
    };
  }
  return { allowed: true, reason: null };
}

/**
 * Async check — does the user already hold the max number of open positions?
 *
 * Counts Firestore `positions` docs for this user where status == 'open'.
 *
 * @param {string} userId
 * @param {number} maxPositions
 * @returns {Promise<{ allowed: boolean, reason: string|null }>}
 */
async function isMaxPositionsExceeded(userId, maxPositions) {
  try {
    const snap = await admin.firestore()
      .collection('positions')
      .where('user_id', '==', userId)
      .where('status', '==', 'open')
      .count()   // Firestore COUNT aggregation — no document data fetched
      .get();

    const openCount = snap.data().count;

    if (openCount >= maxPositions) {
      return {
        allowed: false,
        reason:  `Max open positions (${maxPositions}) reached — currently ${openCount} open`,
      };
    }
    return { allowed: true, reason: null };
  } catch (err) {
    // If count query fails (e.g. index not ready), fail open to avoid blocking all orders
    console.warn('[RiskManager] isMaxPositionsExceeded query failed — allowing order:', err.message);
    return { allowed: true, reason: null };
  }
}

/**
 * Async check — has the user's realised P&L today already hit the daily loss floor?
 *
 * Sums `pnl` field on Firestore `positions` docs that were closed today
 * (closed_at >= today midnight IST). A negative sum below -daily_loss_limit
 * blocks further trading.
 *
 * @param {string} userId
 * @param {number} dailyLossLimit   - positive number, e.g. 5000 means max loss is ₹5000
 * @returns {Promise<{ allowed: boolean, reason: string|null }>}
 */
async function isDailyLossLimitBreached(userId, dailyLossLimit) {
  try {
    // Midnight IST today (IST = UTC+5:30)
    const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
    const nowUtc        = Date.now();
    const nowIst        = new Date(nowUtc + IST_OFFSET_MS);
    const midnightIst   = new Date(
      Date.UTC(
        nowIst.getUTCFullYear(),
        nowIst.getUTCMonth(),
        nowIst.getUTCDate(),
      ) - IST_OFFSET_MS
    );

    const snap = await admin.firestore()
      .collection('positions')
      .where('user_id',   '==', userId)
      .where('status',    '==', 'closed')
      .where('closed_at', '>=', admin.firestore.Timestamp.fromDate(midnightIst))
      .get();

    if (snap.empty) return { allowed: true, reason: null };

    // Sum realised P&L across all closed positions today
    let realisedPnl = 0;
    snap.docs.forEach(doc => {
      const val = doc.data().pnl;
      if (typeof val === 'number' && isFinite(val)) realisedPnl += val;
    });

    if (realisedPnl <= -Math.abs(dailyLossLimit)) {
      return {
        allowed: false,
        reason:  `Daily loss limit ₹${dailyLossLimit.toFixed(2)} breached — realised P&L today: ₹${realisedPnl.toFixed(2)}`,
      };
    }

    return { allowed: true, reason: null };
  } catch (err) {
    // Fail open — don't block orders if the check itself errors
    console.warn('[RiskManager] isDailyLossLimitBreached query failed — allowing order:', err.message);
    return { allowed: true, reason: null };
  }
}

// ── checkOrderAllowed ─────────────────────────────────────────────────────────

/**
 * Main gate — run all risk checks before placing an order.
 * Checks are evaluated in order of cheapest-first:
 *   1. Max order value  (synchronous — no Firestore read)
 *   2. Max open positions  (single COUNT query)
 *   3. Daily loss limit    (collection query — most expensive, so last)
 *
 * @param {object} opts
 * @param {string} opts.userId
 * @param {string} opts.symbol    - informational, included in reason strings
 * @param {string} opts.action    - "BUY" | "SELL"
 * @param {number} opts.quantity
 * @param {number} opts.price     - 0 or omit for MARKET orders
 *
 * @returns {Promise<{ allowed: boolean, reason: string|null }>}
 */
async function checkOrderAllowed({ userId, symbol, action, quantity, price }) {
  if (!userId || !quantity) {
    return { allowed: false, reason: 'checkOrderAllowed: userId and quantity are required' };
  }

  const cfg = await loadRiskConfig();

  // ── Check 1: max order value ──────────────────────────────────────────────
  const valueCheck = isOrderValueExceeded(quantity, price, cfg.max_order_value);
  if (!valueCheck.allowed) {
    console.warn(`[RiskManager] ❌ Order blocked for ${userId} (${symbol}): ${valueCheck.reason}`);
    return valueCheck;
  }

  // ── Check 2: max open positions ───────────────────────────────────────────
  // Only relevant for new BUY orders — SELL orders close existing positions
  if (action?.toUpperCase() === 'BUY') {
    const posCheck = await isMaxPositionsExceeded(userId, cfg.max_open_positions);
    if (!posCheck.allowed) {
      console.warn(`[RiskManager] ❌ Order blocked for ${userId} (${symbol}): ${posCheck.reason}`);
      return posCheck;
    }
  }

  // ── Check 3: daily loss limit ─────────────────────────────────────────────
  const lossCheck = await isDailyLossLimitBreached(userId, cfg.daily_loss_limit);
  if (!lossCheck.allowed) {
    console.warn(`[RiskManager] ❌ Order blocked for ${userId} (${symbol}): ${lossCheck.reason}`);
    return lossCheck;
  }

  return { allowed: true, reason: null };
}

// ── helpers ───────────────────────────────────────────────────────────────────

function _toNumber(val, fallback) {
  const n = Number(val);
  return isFinite(n) && n > 0 ? n : fallback;
}

// ── exports ───────────────────────────────────────────────────────────────────

module.exports = {
  checkOrderAllowed,
  loadRiskConfig,
  // Exported for unit testing
  isOrderValueExceeded,
  isMaxPositionsExceeded,
  isDailyLossLimitBreached,
};
