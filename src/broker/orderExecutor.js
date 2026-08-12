/**
 * orderExecutor.js  (per-user credential edition)
 * ─────────────────────────────────────────────────
 * Places, modifies, and cancels orders via Angel One SmartAPI REST.
 * Writes order results to Firestore `orders` collection.
 *
 * Auth strategy (per-user):
 *   Each call that touches Angel One first reads the user's own credentials
 *   from `users/{uid}/broker_connections/angel_one` in Firestore, generates a
 *   fresh TOTP, and logs in to obtain a short-lived JWT.
 *
 *   The JWT is cached in memory keyed by userId so repeated calls within the
 *   same session don't re-login unnecessarily. The cache TTL is 3 hours
 *   (Angel One JWTs expire after ~8 hours, but we refresh conservatively).
 *
 * Why NOT reuse the global angelOne.js session:
 *   The global session belongs to the server's own Angel One account and is
 *   used for the live price feed. Each user trades with their own account, so
 *   they need their own authenticated session.
 */

const axios      = require('axios');
const speakeasy  = require('speakeasy');
const admin      = require('firebase-admin');
const riskManager = require('./riskManager');

// ── Base URL ──────────────────────────────────────────────────────────────────

const ANGEL_BASE = 'https://apiconnect.angelone.in';

// ── Per-user session cache ────────────────────────────────────────────────────
// { [userId]: { authToken, apiKey, expiresAt } }
// We cache per user so multiple orders in quick succession don't each login.

const _sessionCache = new Map();
const SESSION_TTL_MS = 3 * 60 * 60 * 1000; // 3 hours

// ── _getUserCredentials ───────────────────────────────────────────────────────

/**
 * Fetch the user's Angel One credentials from Firestore.
 * Returns null if not found or incomplete.
 *
 * @param {string} userId
 * @returns {Promise<{clientId, apiKey, totpSecret, pin} | null>}
 */
async function _getUserCredentials(userId) {
  const db = admin.firestore();
  const doc = await db
    .collection('users')
    .doc(userId)
    .collection('broker_connections')
    .doc('angel_one')
    .get();

  if (!doc.exists) return null;

  const d = doc.data();
  const { client_id, api_key, totp_secret, pin } = d;

  if (!client_id || !api_key || !totp_secret || !pin) {
    console.warn(`[OrderExecutor] Incomplete broker credentials for user ${userId}`);
    return null;
  }

  return { clientId: client_id, apiKey: api_key, totpSecret: totp_secret, pin };
}

// ── _loginUser ────────────────────────────────────────────────────────────────

/**
 * Perform a fresh Angel One login for the given user credentials.
 * Returns { authToken, apiKey } or throws.
 *
 * @param {{ clientId, apiKey, totpSecret, pin }} creds
 * @returns {Promise<{ authToken: string, apiKey: string }>}
 */
async function _loginUser({ clientId, apiKey, totpSecret, pin }) {
  const totp = speakeasy.totp({
    secret:   totpSecret,
    encoding: 'base32',
  });

  const res = await axios.post(
    `${ANGEL_BASE}/rest/auth/angelbroking/user/v1/loginByPassword`,
    {
      clientcode: clientId,
      password:   pin,
      totp,
    },
    {
      headers: {
        'Content-Type':     'application/json',
        'Accept':           'application/json',
        'X-UserType':       'USER',
        'X-SourceID':       'WEB',
        'X-ClientLocalIP':  '127.0.0.1',
        'X-ClientPublicIP': '127.0.0.1',
        'X-MACAddress':     '00:00:00:00:00:00',
        'X-PrivateKey':     apiKey,
      },
      timeout: 15_000,
    }
  );

  if (res.data?.status !== true) {
    const msg = res.data?.message || 'Login failed';
    throw new Error(`Angel One login failed for ${clientId}: ${msg}`);
  }

  const authToken = res.data.data.jwtToken;
  if (!authToken) throw new Error(`No JWT in Angel One login response for ${clientId}`);

  return { authToken, apiKey };
}

// ── _getSessionForUser ────────────────────────────────────────────────────────

/**
 * Returns a valid { authToken, apiKey } for the user, logging in if needed.
 * Uses the in-memory cache with a 3-hour TTL.
 *
 * @param {string} userId
 * @returns {Promise<{ authToken: string, apiKey: string }>}
 */
async function _getSessionForUser(userId) {
  const cached = _sessionCache.get(userId);
  if (cached && Date.now() < cached.expiresAt) {
    return { authToken: cached.authToken, apiKey: cached.apiKey };
  }

  const creds = await _getUserCredentials(userId);
  if (!creds) {
    throw new Error(
      `No broker credentials found for user ${userId}. ` +
      `Please connect your Angel One account in the app.`
    );
  }

  const session = await _loginUser(creds);

  _sessionCache.set(userId, {
    authToken:  session.authToken,
    apiKey:     creds.apiKey,
    expiresAt:  Date.now() + SESSION_TTL_MS,
  });

  console.log(`[OrderExecutor] ✅ Session created for user ${userId}`);
  return session;
}

// ── _invalidateSession ────────────────────────────────────────────────────────

function _invalidateSession(userId) {
  _sessionCache.delete(userId);
}

// ── _buildHeaders ─────────────────────────────────────────────────────────────

function _buildHeaders(authToken, apiKey) {
  return {
    'Content-Type':     'application/json',
    'Accept':           'application/json',
    'Authorization':    `Bearer ${authToken}`,
    'X-UserType':       'USER',
    'X-SourceID':       'WEB',
    'X-ClientLocalIP':  '127.0.0.1',
    'X-ClientPublicIP': '127.0.0.1',
    'X-MACAddress':     '00:00:00:00:00:00',
    'X-PrivateKey':     apiKey,
  };
}

// ── _requestForUser ───────────────────────────────────────────────────────────

/**
 * Auth-aware request helper scoped to a specific user's session.
 * Automatically refreshes the session on token expiry (AG8001/AG8002/401).
 *
 * @param {string} userId
 * @param {'GET'|'POST'} method
 * @param {string} path
 * @param {object|null} data
 */
async function _requestForUser(userId, method, path, data = null) {
  let session = await _getSessionForUser(userId);

  const _makeOpts = (s) => {
    const opts = {
      method,
      url:     `${ANGEL_BASE}${path}`,
      headers: _buildHeaders(s.authToken, s.apiKey),
      timeout: 15_000,
    };
    if (data) opts.data = data;
    return opts;
  };

  const _handleResponse = async (res, isRetry = false) => {
    if (res.data?.status === false) {
      const errMsg  = res.data?.message  || 'Angel One API error';
      const errCode = res.data?.errorcode || '';

      const isExpired =
        errCode === 'AG8001' ||
        errCode === 'AG8002' ||
        /token|session|unauthori[sz]ed/i.test(errMsg);

      if (isExpired && !isRetry) {
        console.warn(`[OrderExecutor] Token expired for user ${userId} — refreshing...`);
        _invalidateSession(userId);
        session = await _getSessionForUser(userId);
        const retryRes = await axios(_makeOpts(session));
        return _handleResponse(retryRes, true);
      }

      throw new Error(`Angel One error [${errCode}]: ${errMsg}`);
    }
    return res.data;
  };

  try {
    const res = await axios(_makeOpts(session));
    return _handleResponse(res);
  } catch (err) {
    if (err.response?.status === 401) {
      console.warn(`[OrderExecutor] HTTP 401 for user ${userId} — refreshing session...`);
      _invalidateSession(userId);
      session = await _getSessionForUser(userId);
      const retryRes = await axios(_makeOpts(session));
      if (retryRes.data?.status === false) {
        throw new Error(`Angel One error after retry: ${retryRes.data?.message}`);
      }
      return retryRes.data;
    }
    throw err;
  }
}

// ── Firestore helper ──────────────────────────────────────────────────────────

function _db() {
  return admin.firestore();
}

// ── placeOrder ────────────────────────────────────────────────────────────────

/**
 * Place a new order on Angel One using the *user's own* credentials.
 *
 * @param {object} opts
 * @param {string} opts.symbol
 * @param {string} opts.exchange      - "NSE" | "BSE" | "MCX" | "NFO"
 * @param {string} opts.action        - "BUY" | "SELL"
 * @param {string} opts.orderType     - "LIMIT" | "MARKET" | "SL" | "SL-M"
 * @param {number} opts.quantity
 * @param {number} opts.price         - 0 for MARKET orders
 * @param {number} [opts.triggerPrice]
 * @param {string} opts.userId        - Firebase UID (used to look up credentials)
 * @param {string} [opts.signalId]
 *
 * @returns {{ success, angelOrderId, firestoreOrderId }}
 */
async function placeOrder({
  symbol,
  exchange,
  action,
  orderType,
  quantity,
  price,
  triggerPrice = 0,
  userId,
  signalId = null,
}) {
  if (!symbol || !exchange || !action || !orderType || !quantity || !userId) {
    throw new Error('placeOrder: missing required fields');
  }
  if (!['BUY', 'SELL'].includes(action.toUpperCase())) {
    throw new Error(`placeOrder: invalid action "${action}"`);
  }

  // ── Risk check ───────────────────────────────────────────────────────────
  const risk = await riskManager.checkOrderAllowed({ userId, symbol, action, quantity, price });

  if (!risk.allowed) {
    const rejRef = await _db().collection('orders').add({
      user_id:          userId,
      signal_id:        signalId,
      symbol:           symbol.toUpperCase(),
      exchange:         exchange.toUpperCase(),
      action:           action.toUpperCase(),
      order_type:       orderType.toUpperCase(),
      quantity:         Number(quantity),
      price:            Number(price ?? 0),
      trigger_price:    Number(triggerPrice ?? 0),
      product:          'INTRADAY',
      angel_order_id:   null,
      status:           'rejected',
      rejection_reason: risk.reason,
      placed_at:        admin.firestore.Timestamp.fromDate(new Date()),
      updated_at:       admin.firestore.Timestamp.fromDate(new Date()),
    });
    console.warn(`[OrderExecutor] ⛔ Order blocked for user ${userId}: ${risk.reason}`);
    return { success: false, allowed: false, reason: risk.reason, firestoreOrderId: rejRef.id, angelOrderId: null };
  }

  // ── Write pending order doc ───────────────────────────────────────────────
  const now = new Date();
  const orderRef = await _db().collection('orders').add({
    user_id:          userId,
    signal_id:        signalId,
    symbol:           symbol.toUpperCase(),
    exchange:         exchange.toUpperCase(),
    action:           action.toUpperCase(),
    order_type:       orderType.toUpperCase(),
    quantity:         Number(quantity),
    price:            Number(price ?? 0),
    trigger_price:    Number(triggerPrice ?? 0),
    product:          'INTRADAY',
    angel_order_id:   null,
    status:           'pending',
    rejection_reason: null,
    placed_at:        admin.firestore.Timestamp.fromDate(now),
    updated_at:       admin.firestore.Timestamp.fromDate(now),
  });
  const firestoreOrderId = orderRef.id;

  // ── Call Angel One with user's own session ────────────────────────────────
  try {
    const payload = {
      variety:         'NORMAL',
      tradingsymbol:   symbol.toUpperCase(),
      symboltoken:     '',
      transactiontype: action.toUpperCase(),
      exchange:        exchange.toUpperCase(),
      ordertype:       orderType.toUpperCase(),
      producttype:     'INTRADAY',
      duration:        'DAY',
      price:           String(price ?? 0),
      squareoff:       '0',
      stoploss:        '0',
      quantity:        String(quantity),
      triggerprice:    String(triggerPrice ?? 0),
    };

    const res = await _requestForUser(
      userId, 'POST', '/rest/secure/angelbroking/order/v1/placeOrder', payload
    );

    const angelOrderId = res?.data?.orderid || null;

    await orderRef.update({
      angel_order_id: angelOrderId,
      status:         'open',
      updated_at:     admin.firestore.Timestamp.fromDate(new Date()),
    });

    console.log(
      `[OrderExecutor] ✅ Order placed for user ${userId}: ` +
      `${action} ${quantity} ${symbol} — angelId=${angelOrderId} firestoreId=${firestoreOrderId}`
    );

    return { success: true, angelOrderId, firestoreOrderId };
  } catch (err) {
    await orderRef.update({
      status:           'rejected',
      rejection_reason: err.message,
      updated_at:       admin.firestore.Timestamp.fromDate(new Date()),
    });
    console.error(`[OrderExecutor] ❌ placeOrder failed for user ${userId} / ${symbol}: ${err.message}`);
    throw err;
  }
}

// ── modifyOrder ───────────────────────────────────────────────────────────────

/**
 * Modify an open order. Requires userId to use the correct Angel One session.
 *
 * @param {object} opts
 * @param {string} opts.angelOrderId
 * @param {string} opts.orderType
 * @param {number} opts.quantity
 * @param {number} opts.price
 * @param {number} [opts.triggerPrice]
 * @param {string} opts.userId
 */
async function modifyOrder({ angelOrderId, orderType, quantity, price, triggerPrice = 0, userId }) {
  if (!angelOrderId || !orderType || !quantity || !userId) {
    throw new Error('modifyOrder: angelOrderId, orderType, quantity, and userId are required');
  }

  const payload = {
    variety:      'NORMAL',
    orderid:      String(angelOrderId),
    ordertype:    orderType.toUpperCase(),
    producttype:  'INTRADAY',
    duration:     'DAY',
    price:        String(price ?? 0),
    quantity:     String(quantity),
    triggerprice: String(triggerPrice ?? 0),
  };

  await _requestForUser(userId, 'POST', '/rest/secure/angelbroking/order/v1/modifyOrder', payload);

  try {
    const snap = await _db()
      .collection('orders')
      .where('angel_order_id', '==', String(angelOrderId))
      .limit(1)
      .get();

    if (!snap.empty) {
      await snap.docs[0].ref.update({
        order_type:    orderType.toUpperCase(),
        quantity:      Number(quantity),
        price:         Number(price ?? 0),
        trigger_price: Number(triggerPrice ?? 0),
        updated_at:    admin.firestore.Timestamp.fromDate(new Date()),
      });
    }
  } catch (fsErr) {
    console.warn(`[OrderExecutor] Firestore sync after modifyOrder failed: ${fsErr.message}`);
  }

  console.log(`[OrderExecutor] ✅ Order modified: ${angelOrderId} (user ${userId})`);
  return { success: true, angelOrderId };
}

// ── cancelOrder ───────────────────────────────────────────────────────────────

/**
 * Cancel an open order. Requires userId to use the correct Angel One session.
 *
 * @param {object} opts
 * @param {string} opts.angelOrderId
 * @param {string} opts.userId
 */
async function cancelOrder({ angelOrderId, userId }) {
  if (!angelOrderId || !userId) {
    throw new Error('cancelOrder: angelOrderId and userId are required');
  }

  const payload = {
    variety: 'NORMAL',
    orderid: String(angelOrderId),
  };

  await _requestForUser(userId, 'POST', '/rest/secure/angelbroking/order/v1/cancelOrder', payload);

  try {
    const snap = await _db()
      .collection('orders')
      .where('angel_order_id', '==', String(angelOrderId))
      .limit(1)
      .get();

    if (!snap.empty) {
      await snap.docs[0].ref.update({
        status:     'cancelled',
        updated_at: admin.firestore.Timestamp.fromDate(new Date()),
      });
    }
  } catch (fsErr) {
    console.warn(`[OrderExecutor] Firestore sync after cancelOrder failed: ${fsErr.message}`);
  }

  console.log(`[OrderExecutor] ✅ Order cancelled: ${angelOrderId} (user ${userId})`);
  return { success: true, angelOrderId };
}

// ── getOrderStatus ────────────────────────────────────────────────────────────

/**
 * Fetch a single order's status from the user's Angel One order book.
 *
 * @param {string} angelOrderId
 * @param {string} userId
 * @returns {Promise<object|null>}
 */
async function getOrderStatus(angelOrderId, userId) {
  if (!angelOrderId || !userId) throw new Error('getOrderStatus: angelOrderId and userId are required');

  const res = await _requestForUser(userId, 'GET', '/rest/secure/angelbroking/order/v1/getOrderBook');
  const orders = res?.data || [];
  return orders.find(o => String(o.orderid) === String(angelOrderId)) || null;
}

// ── syncOrderBook ─────────────────────────────────────────────────────────────

/**
 * Fetch the user's full order book from Angel One and upsert into Firestore.
 *
 * @param {string} userId
 * @returns {Promise<{ synced: number }>}
 */
async function syncOrderBook(userId) {
  if (!userId) throw new Error('syncOrderBook: userId is required');

  const res = await _requestForUser(userId, 'GET', '/rest/secure/angelbroking/order/v1/getOrderBook');
  const orders = res?.data || [];

  if (!Array.isArray(orders) || orders.length === 0) {
    console.log(`[OrderExecutor] syncOrderBook: no orders for user ${userId}`);
    return { synced: 0 };
  }

  const db    = _db();
  const batch = db.batch();
  const now   = admin.firestore.Timestamp.fromDate(new Date());

  const _normalizeStatus = (s = '') =>
    ({ complete: 'complete', open: 'open', cancelled: 'cancelled', rejected: 'rejected', pending: 'pending' })[s.toLowerCase()] || s.toLowerCase();

  for (const o of orders) {
    if (!o.orderid) continue;
    const docId = `${userId}_${o.orderid}`;
    const ref   = db.collection('orders').doc(docId);
    batch.set(ref, {
      user_id:          userId,
      angel_order_id:   String(o.orderid),
      symbol:           o.tradingsymbol     || '',
      exchange:         o.exchange           || '',
      action:           o.transactiontype    || '',
      order_type:       o.ordertype          || '',
      quantity:         Number(o.quantity    || 0),
      price:            Number(o.price       || 0),
      trigger_price:    Number(o.triggerprice || 0),
      filled_qty:       Number(o.filledshares || 0),
      avg_price:        Number(o.averageprice || 0),
      status:           _normalizeStatus(o.status),
      rejection_reason: o.text || null,
      product:          o.producttype || 'INTRADAY',
      variety:          o.variety     || 'NORMAL',
      placed_at:        o.ordertime
        ? admin.firestore.Timestamp.fromDate(new Date(o.ordertime))
        : now,
      updated_at: now,
    }, { merge: true });
  }

  await batch.commit();
  console.log(`[OrderExecutor] syncOrderBook: upserted ${orders.length} order(s) for user ${userId}`);
  return { synced: orders.length };
}

// ── exports ───────────────────────────────────────────────────────────────────

module.exports = {
  placeOrder,
  modifyOrder,
  cancelOrder,
  getOrderStatus,
  syncOrderBook,
};
