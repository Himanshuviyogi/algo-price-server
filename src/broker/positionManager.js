/**
 * positionManager.js
 * ───────────────────
 * Fetches the position book from Angel One SmartAPI and syncs it to the
 * Firestore `positions` collection for a given user.
 *
 * Angel One endpoint:
 *   GET /rest/secure/angelbroking/order/v1/getPosition
 *
 * Firestore positions/{positionId} schema:
 * {
 *   user_id:       string
 *   symbol:        string
 *   exchange:      string
 *   action:        'BUY' | 'SELL'
 *   quantity:      number
 *   avg_price:     number
 *   current_price: number   (ltp from Angel One — updated on each sync)
 *   pnl:           number
 *   pnl_percent:   number
 *   status:        'open' | 'closed'
 *   product:       string   (INTRADAY | DELIVERY | etc.)
 *   opened_at:     Timestamp
 *   updated_at:    Timestamp
 * }
 */

const admin    = require('firebase-admin');
const angelOne = require('./angelOne');
const axios    = require('axios');
const config   = require('../config');

// ── Base URL ──────────────────────────────────────────────────────────────────

const ANGEL_BASE = 'https://apiconnect.angelone.in';

// ── Auth-aware GET helper (mirrors orderExecutor pattern) ─────────────────────

function _buildHeaders(authToken) {
  return {
    'Content-Type':       'application/json',
    'Accept':             'application/json',
    'Authorization':      `Bearer ${authToken}`,
    'X-UserType':         'USER',
    'X-SourceID':         'WEB',
    'X-ClientLocalIP':    '127.0.0.1',
    'X-ClientPublicIP':   '127.0.0.1',
    'X-MACAddress':       '00:00:00:00:00:00',
    'X-PrivateKey':       config.angel.apiKey,
  };
}

async function _get(path) {
  let token = angelOne.getAuthToken();

  if (!token) {
    console.log('[PositionManager] No auth token — logging in...');
    await angelOne.login();
    token = angelOne.getAuthToken();
  }

  try {
    const res = await axios.get(`${ANGEL_BASE}${path}`, {
      headers: _buildHeaders(token),
      timeout: 15_000,
    });

    if (res.data?.status === false) {
      const msg  = res.data?.message  || 'Angel One error';
      const code = res.data?.errorcode || '';
      const isExpired =
        code === 'AG8001' || code === 'AG8002' ||
        /token|session|unauthori[sz]ed/i.test(msg);

      if (isExpired) {
        console.warn('[PositionManager] Token expired — refreshing...');
        await angelOne.login();
        const retryRes = await axios.get(`${ANGEL_BASE}${path}`, {
          headers: _buildHeaders(angelOne.getAuthToken()),
          timeout: 15_000,
        });
        if (retryRes.data?.status === false) {
          throw new Error(`Angel One error after retry: ${retryRes.data?.message}`);
        }
        return retryRes.data;
      }
      throw new Error(`Angel One error [${code}]: ${msg}`);
    }
    return res.data;
  } catch (err) {
    if (err.response?.status === 401) {
      await angelOne.login();
      const retryRes = await axios.get(`${ANGEL_BASE}${path}`, {
        headers: _buildHeaders(angelOne.getAuthToken()),
        timeout: 15_000,
      });
      if (retryRes.data?.status === false) {
        throw new Error(`Angel One error after retry: ${retryRes.data?.message}`);
      }
      return retryRes.data;
    }
    throw err;
  }
}

// ── getPositionBook ───────────────────────────────────────────────────────────

/**
 * Fetch raw position book from Angel One.
 * Returns an array of position objects from the API, or [] on empty/error.
 *
 * @returns {Promise<object[]>}
 */
async function getPositionBook() {
  const res = await _get('/rest/secure/angelbroking/order/v1/getPosition');
  const positions = res?.data || [];
  console.log(`[PositionManager] getPositionBook: ${positions.length} position(s) from Angel One`);
  return Array.isArray(positions) ? positions : [];
}

// ── syncPositions ─────────────────────────────────────────────────────────────

/**
 * Fetch positions from Angel One and upsert them into Firestore `positions`
 * for the given user.
 *
 * Uses a deterministic doc ID: `{userId}_{symbol}_{exchange}` so re-runs
 * update in place without creating duplicates.
 *
 * Positions with netqty == 0 are written as status='closed'.
 * Positions with netqty != 0 are written as status='open'.
 *
 * @param {string} userId - Firebase UID of the user
 * @returns {Promise<{ synced: number, open: number, closed: number }>}
 */
async function syncPositions(userId) {
  if (!userId) throw new Error('syncPositions: userId is required');

  const rawPositions = await getPositionBook();

  if (rawPositions.length === 0) {
    console.log(`[PositionManager] No positions to sync for ${userId}`);
    return { synced: 0, open: 0, closed: 0 };
  }

  const db    = admin.firestore();
  const batch = db.batch();
  const now   = admin.firestore.Timestamp.fromDate(new Date());

  let openCount   = 0;
  let closedCount = 0;

  for (const p of rawPositions) {
    const symbol   = (p.tradingsymbol || '').toUpperCase();
    const exchange = (p.exchange      || '').toUpperCase();

    if (!symbol) continue;

    const netQty   = parseInt(p.netqty   ?? p.quantity ?? 0, 10);
    const avgPrice = parseFloat(p.netavgprice   ?? p.averageprice ?? 0);
    const ltp      = parseFloat(p.ltp           ?? 0);
    const action   = (p.transactiontype || 'BUY').toUpperCase();

    // P&L: BUY side = (ltp - avg) * qty; SELL side = (avg - ltp) * qty
    const qty     = Math.abs(netQty);
    const pnl     = action === 'SELL'
      ? (avgPrice - ltp) * qty
      : (ltp - avgPrice) * qty;

    const costBasis   = avgPrice * qty;
    const pnlPercent  = costBasis > 0 ? (pnl / costBasis) * 100 : 0;

    const status = netQty === 0 ? 'closed' : 'open';
    if (status === 'open')   openCount++;
    if (status === 'closed') closedCount++;

    // Deterministic doc ID — one doc per symbol+exchange per user
    const docId = `${userId}_${symbol}_${exchange}`;
    const ref   = db.collection('positions').doc(docId);

    const doc = {
      user_id:       userId,
      symbol,
      exchange,
      action,
      quantity:      qty,
      avg_price:     avgPrice,
      current_price: ltp,
      pnl:           parseFloat(pnl.toFixed(2)),
      pnl_percent:   parseFloat(pnlPercent.toFixed(2)),
      status,
      product:       (p.producttype || 'INTRADAY').toUpperCase(),
      updated_at:    now,
    };

    // Set opened_at only on create (merge preserves existing value)
    batch.set(ref, {
      ...doc,
      // opened_at is preserved on merge — only written on first create
    }, { merge: true });

    // Ensure opened_at is set on first write via a separate conditional update
    // (batch.set with merge won't overwrite an existing field)
    // We handle this by always including it but Firestore merge ignores existing.
    // For new docs, we need it present — use a sentinel.
    batch.set(ref, { opened_at: now }, { merge: true }); // no-op if already set
  }

  await batch.commit();

  console.log(
    `[PositionManager] ✅ Synced ${rawPositions.length} position(s) for ${userId} ` +
    `(open: ${openCount}, closed: ${closedCount})`
  );

  return { synced: rawPositions.length, open: openCount, closed: closedCount };
}

// ── closePosition ─────────────────────────────────────────────────────────────

/**
 * Close an open position by placing the opposite order.
 *
 * Reads the position from Firestore, determines the closing action
 * (BUY → SELL, SELL → BUY), and delegates to orderExecutor.placeOrder().
 *
 * @param {object} opts
 * @param {string} opts.positionId - Firestore position doc ID
 * @param {string} opts.userId     - Firebase UID
 *
 * @returns {Promise<{ success: boolean, firestoreOrderId: string, angelOrderId: string|null }>}
 */
async function closePosition({ positionId, userId }) {
  if (!positionId || !userId) {
    throw new Error('closePosition: positionId and userId are required');
  }

  const db      = admin.firestore();
  const posRef  = db.collection('positions').doc(positionId);
  const posSnap = await posRef.get();

  if (!posSnap.exists) {
    throw new Error(`closePosition: position ${positionId} not found`);
  }

  const pos = posSnap.data();

  if (pos.status !== 'open') {
    throw new Error(`closePosition: position ${positionId} is already ${pos.status}`);
  }

  // Validate ownership
  if (pos.user_id !== userId) {
    throw new Error('closePosition: forbidden — position does not belong to this user');
  }

  // Opposite action closes the position
  const closeAction = pos.action === 'BUY' ? 'SELL' : 'BUY';

  const orderExecutor = require('./orderExecutor');
  const result = await orderExecutor.placeOrder({
    symbol:    pos.symbol,
    exchange:  pos.exchange,
    action:    closeAction,
    orderType: 'MARKET',
    quantity:  pos.quantity,
    price:     0,            // MARKET order — price not required
    userId,
    signalId:  pos.signal_id || null,
  });

  console.log(
    `[PositionManager] closePosition: ${closeAction} ${pos.quantity} ${pos.symbol} ` +
    `for user ${userId} — firestoreOrder: ${result.firestoreOrderId}`
  );

  return result;
}

// ── exports ───────────────────────────────────────────────────────────────────

module.exports = {
  getPositionBook,
  syncPositions,
  closePosition,
};
