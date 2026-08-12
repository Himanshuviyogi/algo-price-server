const speakeasy = require('speakeasy');
const axios     = require('axios');
const WebSocket = require('ws');
const config    = require('../config');
const { toSubscriptionList, getInstrument, getTokenToSymbolMap } = require('./instrumentTokens');

// ── Session state ─────────────────────────────────────────────────────────────

let _authToken  = null;
let _feedToken  = null;
let _ws         = null;
let _onTick     = null;
let _onStatus   = null;
let _reconnectTimer = null;

// ── Login ─────────────────────────────────────────────────────────────────────

async function login() {
  const totp = speakeasy.totp({
    secret:   config.angel.totpSecret,
    encoding: 'base32',
  });

  console.log('[AngelOne] Logging in...');

  const res = await axios.post(
    'https://apiconnect.angelone.in/rest/auth/angelbroking/user/v1/loginByPassword',
    {
      clientcode: config.angel.clientId,
      password:   config.angel.password,
      totp,
    },
    {
      headers: {
        'Content-Type':  'application/json',
        'Accept':        'application/json',
        'X-UserType':    'USER',
        'X-SourceID':    'WEB',
        'X-ClientLocalIP': '127.0.0.1',
        'X-ClientPublicIP': '127.0.0.1',
        'X-MACAddress':  '00:00:00:00:00:00',
        'X-PrivateKey':  config.angel.apiKey,
      },
    }
  );

  if (res.data?.status !== true) {
    throw new Error(`Angel One login failed: ${JSON.stringify(res.data)}`);
  }

  _authToken = res.data.data.jwtToken;
  _feedToken = res.data.data.feedToken;

  console.log('[AngelOne] Login successful. Feed token obtained.');
  return { authToken: _authToken, feedToken: _feedToken };
}

// ── WebSocket feed ────────────────────────────────────────────────────────────

/**
 * Connect to Angel One SmartAPI WebSocket feed.
 * @param {string[]} symbols - list of symbols to subscribe (e.g. ['RELIANCE', 'TCS'])
 * @param {Function} onTick  - called with (symbol, priceData) on each tick
 * @param {Function} onStatus - called with ('connected'|'disconnected'|'error', msg?)
 */
async function connect(symbols, onTick, onStatus) {
  if (!_feedToken) {
    await login();
  }

  _onTick   = onTick;
  _onStatus = onStatus;

  const wsUrl = `wss://smartapisocket.angelone.in/smart-stream`;

  console.log(`[AngelOne] Connecting WebSocket for ${symbols.length} symbols...`);

  _ws = new WebSocket(wsUrl, {
    headers: {
      Authorization:   `Bearer ${_authToken}`,
      'x-api-key':     config.angel.apiKey,
      'x-client-code': config.angel.clientId,
      'x-feed-token':  _feedToken,
    },
  });

  _ws.on('open', () => {
    _subscribe(symbols);
    if (_onStatus) _onStatus('connected');
  });

  _ws.on('message', (data) => {
    // Angel One sends a text "pong" response to our ping — ignore it
    if (typeof data === 'string') return;
    _parseTick(data);
  });

  _ws.on('error', (err) => {
    console.error('[AngelOne] WebSocket error:', err.message);
    if (_onStatus) _onStatus('error', err.message);
  });

  _ws.on('close', (code, reason) => {
    console.warn(`[AngelOne] WebSocket closed. Code: ${code}, Reason: ${reason}`);
    if (_onStatus) _onStatus('disconnected', `${code}`);
    _heartbeatInterval && clearInterval(_heartbeatInterval);
    _scheduleReconnect(symbols);
  });

  // Angel One requires a text-frame keepalive every 30s.
  // Standard WebSocket ping frames are NOT sufficient — Angel One needs
  // a JSON {"action":"ping"} text message to reset their idle timeout.
  let _heartbeatInterval = setInterval(() => {
    if (_ws && _ws.readyState === WebSocket.OPEN) {
      _ws.send(JSON.stringify({ action: 'ping' }));
    } else {
      clearInterval(_heartbeatInterval);
    }
  }, 25_000); // every 25s (Angel One idle timeout is ~30s)
}

function _subscribe(symbols) {
  const subscriptionList = toSubscriptionList(symbols);
  if (subscriptionList.length === 0) return;

  // Angel One limits: max 50 tokens per exchange per subscription message.
  // Group by exchangeType and send in batches of 50.
  const byExchange = {};
  for (const item of subscriptionList) {
    const key = item.exchangeType;
    if (!byExchange[key]) byExchange[key] = [];
    byExchange[key].push(...item.tokens);
  }

  let batchIndex = 0;
  for (const [exchangeType, tokens] of Object.entries(byExchange)) {
    for (let i = 0; i < tokens.length; i += 50) {
      const batch = tokens.slice(i, i + 50);
      const msg = {
        correlationID: `stockara_feed_${exchangeType}_${batchIndex++}`,
        action: 1,
        params: {
          mode: 3, // SNAP_QUOTE
          tokenList: [{ exchangeType: Number(exchangeType), tokens: batch }],
        },
      };
      _ws.send(JSON.stringify(msg));
    }
  }

  console.log(`[AngelOne] Subscribed to ${symbols.length} symbols in ${batchIndex} batch(es).`);
}

function _scheduleReconnect(symbols) {
  if (_reconnectTimer) return;
  _reconnectTimer = setTimeout(async () => {
    _reconnectTimer = null;
    try {
      await login();
      await connect(symbols, _onTick, _onStatus);
    } catch (err) {
      console.error('[AngelOne] Reconnect failed:', err.message);
      _scheduleReconnect(symbols);
    }
  }, 5_000);
}

/**
 * Parse Angel One binary tick message.
 *
 * Byte layout per Angel One official Python SDK (smartWebSocketV2.py):
 *   [0]       subscription_mode  (1 byte,  uint8)
 *   [1]       exchange_type      (1 byte,  uint8)
 *   [2-26]    token              (25 bytes, null-terminated string)
 *   [27-34]   sequence_number    (8 bytes, int64 LE)
 *   [35-42]   exchange_timestamp (8 bytes, int64 LE)
 *   [43-50]   ltp                (8 bytes, int64 LE, value × 100)
 *   [51-58]   last_traded_qty    (8 bytes, int64 LE)
 *   [59-66]   avg_traded_price   (8 bytes, int64 LE, × 100)
 *   [67-74]   volume_traded      (8 bytes, int64 LE)
 *   [75-82]   total_buy_qty      (8 bytes, float64 LE)
 *   [83-90]   total_sell_qty     (8 bytes, float64 LE)
 *   [91-98]   open               (8 bytes, int64 LE, × 100)
 *   [99-106]  high               (8 bytes, int64 LE, × 100)
 *   [107-114] low                (8 bytes, int64 LE, × 100)
 *   [115-122] close              (8 bytes, int64 LE, × 100)
 */
function _parseTick(data) {
  try {
    // Angel One sends JSON for control messages (ping responses etc), binary for ticks
    if (typeof data === 'string') return; // ignore control messages

    const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
    if (buf.length < 123) return; // too short for SNAP_QUOTE

    // Extract token (bytes 2–26, null-terminated string)
    const tokenBytes = buf.slice(2, 27);
    const token = tokenBytes.toString('utf8').replace(/\0/g, '').trim();

    const symbol = getTokenToSymbolMap()[token];
    if (!symbol) return; // unknown token

    // Prices are int64 LE × 100.
    // Read as BigInt to avoid JS integer precision loss on large values,
    // then convert to Number before dividing so decimals are preserved.
    const ltp   = Number(buf.readBigInt64LE(43))  / 100;
    const open  = Number(buf.readBigInt64LE(91))  / 100;
    const high  = Number(buf.readBigInt64LE(99))  / 100;
    const low   = Number(buf.readBigInt64LE(107)) / 100;
    const close = Number(buf.readBigInt64LE(115)) / 100;

    const change        = ltp - close;
    const changePercent = close > 0 ? (change / close) * 100 : 0;

    if (_onTick) {
      _onTick(symbol, {
        ltp:           parseFloat(ltp.toFixed(2)),
        open:          parseFloat(open.toFixed(2)),
        high:          parseFloat(high.toFixed(2)),
        low:           parseFloat(low.toFixed(2)),
        close:         parseFloat(close.toFixed(2)),
        change:        parseFloat(change.toFixed(2)),
        changePercent: parseFloat(changePercent.toFixed(2)),
        ts:            Date.now(),
      });
    }
  } catch (err) {
    // Silently ignore malformed frames
  }
}

function disconnect() {
  if (_reconnectTimer) {
    clearTimeout(_reconnectTimer);
    _reconnectTimer = null;
  }
  if (_ws) {
    _ws.removeAllListeners();
    _ws.close();
    _ws = null;
  }
  console.log('[AngelOne] Disconnected.');
}

function isConnected() {
  return _ws !== null && _ws.readyState === WebSocket.OPEN;
}

function getAuthToken() {
  return _authToken;
}

module.exports = { login, connect, disconnect, isConnected, getAuthToken };
