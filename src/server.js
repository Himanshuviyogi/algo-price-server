/**
 * Stockara Price Server
 * ─────────────────────
 * Node.js + Socket.IO server that:
 *   1. Connects to Angel One SmartAPI WebSocket for live NSE/BSE/MCX prices
 *   2. Caches prices in memory with change detection
 *   3. Broadcasts only changed prices to subscribed Socket.IO rooms every 1s
 *   4. Verifies Firebase ID tokens on connection (auth stays in Firebase)
 *   5. Auto-reconnects on broker disconnect
 *   6. Auto-login at market open, disconnect at market close
 */

require('dotenv').config();

const express   = require('express');
const http      = require('http');
const path      = require('path');
const { Server } = require('socket.io');
const config    = require('./config');
const priceCache = require('./cache/priceCache');
const angelOne  = require('./broker/angelOne');
const { verifyToken, initFirebase } = require('./auth/firebaseAuth');
const { getAllSymbols, loadFromFirestore } = require('./broker/instrumentTokens');
const { searchInstruments, getFnoContracts, findToken } = require('./broker/scripMaster');

// ── Express + HTTP server ─────────────────────────────────────────────────────

const app    = express();
const server = http.createServer(app);

app.use(express.json());

// ── CORS for admin panel ──────────────────────────────────────────────────────
// Allow requests from the admin panel (localhost dev + production domain)
app.use((req, res, next) => {
  const origin = req.headers.origin || '';
  const allowed = [
    'http://localhost:5173',
    'http://localhost:5174',
    'http://localhost:5175',
    ...(config.server.allowedOrigins),
  ];
  if (allowed.includes(origin) || allowed.length === 0) {
    res.setHeader('Access-Control-Allow-Origin', origin || '*');
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// ── Admin panel static files ──────────────────────────────────────────────────
// Serves the built admin panel from /admin — same origin as price server,
// so no mixed content issues when calling http://31.172.87.141:3001
const adminDist = path.join(__dirname, '../admin-dist');
const fs = require('fs');
if (fs.existsSync(adminDist)) {
  app.use('/admin', express.static(adminDist));
  // SPA fallback — serve index.html for all /admin/* routes
  app.get('/admin/*', (req, res) => {
    res.sendFile(path.join(adminDist, 'index.html'));
  });
  console.log('[Server] Admin panel served at /admin');
} else {
  console.log('[Server] Admin panel not found at', adminDist, '— run deploy-admin.sh to build it');
}

// Health check endpoint (Railway uses this)
app.get('/health', (req, res) => {
  res.json({
    status:      'ok',
    broker:      angelOne.isConnected() ? 'connected' : 'disconnected',
    cachedSymbols: Object.keys(priceCache.getAll()).length,
    uptime:      process.uptime(),
    ts:          new Date().toISOString(),
  });
});

// Snapshot endpoint — returns all current prices (for cold-start in Flutter)
app.get('/prices', (req, res) => {
  res.json(priceCache.getAll());
});

// Single-symbol price check — used by admin panel to verify a symbol is in the feed.
// Returns ~100 bytes instead of the full /prices payload (which can be 50-80 KB at 500 symbols).
// GET /price/:symbol
app.get('/price/:symbol', (req, res) => {
  const symbol = req.params.symbol.toUpperCase();
  const { getInstrument } = require('./broker/instrumentTokens');

  const inFeed   = !!getInstrument(symbol);          // is it in instrument_tokens?
  const cached   = priceCache.get(symbol);            // does it have a live price?

  res.json({
    symbol,
    inFeed,
    cached:    !!cached,
    ltp:       cached?.ltp       ?? null,
    change:    cached?.change    ?? null,
    changePercent: cached?.changePercent ?? null,
    ts:        cached?.ts        ?? null,
  });
});

// Reload symbols from Firestore without restarting the server
// POST /reload-symbols — call this from admin panel after updating tokens
app.post('/reload-symbols', async (req, res) => {
  try {
    const tokens = await loadFromFirestore();
    const symbols = Object.keys(tokens);
    console.log(`[Tokens] Reloaded ${symbols.length} symbols from Firestore.`);
    res.json({ success: true, count: symbols.length, symbols });
  } catch (err) {
    console.error('[Tokens] Reload failed:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Search instruments from Angel One ScripMaster
// GET /search-instruments?q=NIFTY&exchange=NFO&type=OPTIDX
app.get('/search-instruments', async (req, res) => {
  try {
    const { q = '', exchange, type, limit = '20' } = req.query;
    if (!q || q.length < 2) {
      return res.json({ results: [] });
    }
    const results = await searchInstruments(q, {
      exchange: exchange || undefined,
      instrumentType: type || undefined,
      limit: parseInt(limit),
    });
    res.json({ results });
  } catch (err) {
    console.error('[ScripMaster] Search failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Get F&O contracts for an underlying
// GET /fno-contracts?underlying=NIFTY&type=OPTIDX
app.get('/fno-contracts', async (req, res) => {
  try {
    const { underlying, type = 'OPTIDX', limit = '50' } = req.query;
    if (!underlying) return res.status(400).json({ error: 'underlying required' });
    const results = await getFnoContracts(underlying, type, parseInt(limit));
    res.json({ results });
  } catch (err) {
    console.error('[ScripMaster] F&O contracts failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});



// ── Market Movers — Gainers & Losers ─────────────────────────────────────────
// Fetches top NSE gainers/losers using multiple source fallbacks:
//   1. Groww public API  — no cookies, works from VPS IPs
//   2. NSE website API   — requires session cookies (fallback)
//   3. Price cache       — compute from live prices as last resort
// Results cached 60 seconds server-side.

const axios = require('axios');

let _moversCache = { gainers: null, losers: null, fetchedAt: 0 };
const MOVERS_TTL_MS = 60 * 1000; // cache 60s

// ── Source 1: Groww public API ────────────────────────────────────────────────

async function fetchFromGroww() {
  const HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    'Accept': 'application/json, text/plain, */*',
    'Origin': 'https://groww.in',
    'Referer': 'https://groww.in/markets/top-gainers-losers',
  };

  const [gRes, lRes] = await Promise.all([
    axios.get('https://groww.in/v1/api/stocks_data/v1/gainers', {
      params: { intraday: true, limit: 20 },
      timeout: 12_000,
      headers: HEADERS,
    }),
    axios.get('https://groww.in/v1/api/stocks_data/v1/losers', {
      params: { intraday: true, limit: 20 },
      timeout: 12_000,
      headers: HEADERS,
    }),
  ]);

  const parseGrowwItem = (item) => ({
    symbol:        item.bseScripCode ? (item.nseScriptCode || item.symbol || '') : (item.nseScriptCode || item.symbol || ''),
    companyName:   item.companyName || item.name || item.symbol || '',
    ltp:           parseFloat(item.ltp ?? item.currentPrice ?? 0),
    percentChange: parseFloat(item.dayChangePerc ?? item.percentChange ?? 0),
    netChange:     parseFloat(item.dayChange ?? item.change ?? 0),
    volume:        parseInt(item.tradedVolume ?? item.volume ?? 0, 10) || null,
  });

  // Groww response: { gainers: [...] } or just [...] 
  const gainRaw = gRes.data?.gainers || gRes.data?.data || (Array.isArray(gRes.data) ? gRes.data : []);
  const loseRaw = lRes.data?.losers  || lRes.data?.data  || (Array.isArray(lRes.data) ? lRes.data : []);

  const gainers = gainRaw.map(parseGrowwItem).filter(s => s.symbol).slice(0, 20);
  const losers  = loseRaw.map(parseGrowwItem).filter(s => s.symbol).slice(0, 20);

  if (gainers.length === 0 && losers.length === 0) throw new Error('Groww returned empty data');

  console.log(`[Movers] Groww: ${gainers.length} gainers, ${losers.length} losers`);
  return { gainers, losers };
}

// ── Source 2: NSE website (session-cookie approach) ───────────────────────────

let _nseSession = { cookies: '', expiresAt: 0 };

async function getNseSession() {
  if (Date.now() < _nseSession.expiresAt) return _nseSession.cookies;
  const res = await axios.get('https://www.nseindia.com', {
    timeout: 12_000,
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/124.0.0.0 Safari/537.36' },
  });
  const cookieStr = (res.headers['set-cookie'] || [])
    .map(c => c.split(';')[0]).filter(Boolean).join('; ');
  _nseSession = { cookies: cookieStr, expiresAt: Date.now() + 25 * 60 * 1000 };
  return cookieStr;
}

async function fetchFromNse() {
  const cookies = await getNseSession();
  const HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/124.0.0.0 Safari/537.36',
    'Accept': 'application/json, text/plain, */*',
    'Referer': 'https://www.nseindia.com/market-data/live-equity-market',
    Cookie: cookies,
  };
  const [gRes, lRes] = await Promise.all([
    axios.get('https://www.nseindia.com/api/live-analysis-variations?index=gainers', { timeout: 12_000, headers: HEADERS }),
    axios.get('https://www.nseindia.com/api/live-analysis-variations?index=losers',  { timeout: 12_000, headers: HEADERS }),
  ]);

  const parse = (item) => ({
    symbol:        item.symbol || '',
    companyName:   item.meta?.companyName || item.companyName || item.symbol || '',
    ltp:           parseFloat(item.lastPrice ?? item.ltp ?? 0),
    percentChange: parseFloat(item.pChange ?? 0),
    netChange:     parseFloat(item.change  ?? 0),
    volume:        parseInt(item.totalTradedVolume ?? 0, 10) || null,
  });

  const gainRaw = gRes.data?.NIFTY500 || gRes.data?.NIFTY || Object.values(gRes.data || {})[0] || [];
  const loseRaw = lRes.data?.NIFTY500 || lRes.data?.NIFTY || Object.values(lRes.data || {})[0] || [];

  const gainers = gainRaw.map(parse).filter(s => s.symbol).sort((a,b) => b.percentChange - a.percentChange).slice(0, 20);
  const losers  = loseRaw.map(parse).filter(s => s.symbol).sort((a,b) => a.percentChange - b.percentChange).slice(0, 20);

  if (gainers.length === 0 && losers.length === 0) {
    _nseSession.expiresAt = 0; // invalidate session
    throw new Error('NSE returned empty data');
  }

  console.log(`[Movers] NSE: ${gainers.length} gainers, ${losers.length} losers`);
  return { gainers, losers };
}

// GET /nse-movers?type=gainers|losers|both
async function fetchMovers() {
  if (Date.now() - _moversCache.fetchedAt < MOVERS_TTL_MS &&
      _moversCache.gainers && _moversCache.losers) {
    return { ..._moversCache, cached: true };
  }

  // Try sources in order — fail cleanly if both unavailable
  for (const [name, fn] of [['Groww', fetchFromGroww], ['NSE', fetchFromNse]]) {
    try {
      const data = await fn();
      _moversCache = { gainers: data.gainers, losers: data.losers, fetchedAt: Date.now() };
      return { ...data, cached: false };
    } catch (err) {
      console.warn(`[Movers] ${name} failed: ${err.message}`);
    }
  }

  throw new Error('Market data sources unavailable');
}

// GET /nse-movers?type=gainers|losers|both
app.get('/nse-movers', async (req, res) => {
  try {
    const { type = 'both' } = req.query;
    const data = await fetchMovers();
    if (type === 'gainers') return res.json({ gainers: data.gainers, cached: data.cached, fromCache: data.fromCache });
    if (type === 'losers')  return res.json({ losers:  data.losers,  cached: data.cached, fromCache: data.fromCache });
    res.json({ gainers: data.gainers, losers: data.losers, cached: data.cached, fromCache: data.fromCache });
  } catch (err) {
    console.error('[Movers] All sources failed:', err.message);
    res.status(503).json({ error: 'Market data temporarily unavailable', detail: err.message });
  }
});

// ── Bhavcopy proxy — DEPRECATED: NSE archives blocks all server IPs
// Using NSE equity-stockIndices API instead (see downloadNseEquityData)

// GET /download-bhavcopy?date=YYYYMMDD (kept for backward compat, returns 501)
app.get('/download-bhavcopy', (req, res) => {
  res.status(501).json({ error: 'Deprecated — use /nse-equity-data instead' });
});

// ── NSE Equity Data proxy — for Firebase Functions (GCP IPs blocked by NSE) ──
// GET /nse-equity-data?index=NIFTY%20500
// Firebase Functions calls this; VPS fetches from NSE equity-stockIndices API.

let _equitySession = { cookies: '', expiresAt: 0 };

app.get('/nse-equity-data', async (req, res) => {
  try {
    const { index = 'NIFTY 500' } = req.query;

    // Refresh NSE session if expired
    if (Date.now() >= _equitySession.expiresAt) {
      const sessionRes = await axios.get('https://www.nseindia.com', {
        timeout: 12_000,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        },
      });
      const cookies = (sessionRes.headers['set-cookie'] || [])
        .map(c => c.split(';')[0]).filter(Boolean).join('; ');
      _equitySession = { cookies, expiresAt: Date.now() + 20 * 60 * 1000 };
      await new Promise(r => setTimeout(r, 800));
    }

    const apiRes = await axios.get(
      `https://www.nseindia.com/api/equity-stockIndices?index=${encodeURIComponent(String(index))}`,
      {
        timeout: 15_000,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36',
          'Accept': 'application/json, text/plain, */*',
          'Referer': 'https://www.nseindia.com/market-data/live-equity-market',
          'Cookie': _equitySession.cookies,
        },
      }
    );

    res.json(apiRes.data);
    console.log(`[NSEProxy] ${index}: ${(apiRes.data?.data?.length || 0)} stocks`);
  } catch (err) {
    _equitySession.expiresAt = 0; // invalidate session on error
    console.error('[NSEProxy] Failed:', err.message);
    res.status(503).json({ error: err.message });
  }
});

// ── FII/DII proxy — for Firebase Functions (GCP IPs blocked by NSE) ──────────
// GET /nse-fiidii
// Firebase Function calls this; VPS fetches from NSE fiidiiTradeReact API.

app.get('/nse-fiidii', async (req, res) => {
  try {
    // Refresh session if needed (reuse _equitySession from equity proxy)
    if (Date.now() >= _equitySession.expiresAt) {
      const sessionRes = await axios.get('https://www.nseindia.com', {
        timeout: 12_000,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        },
      });
      const cookies = (sessionRes.headers['set-cookie'] || [])
        .map(c => c.split(';')[0]).filter(Boolean).join('; ');
      _equitySession = { cookies, expiresAt: Date.now() + 20 * 60 * 1000 };
      await new Promise(r => setTimeout(r, 800));
    }

    const apiRes = await axios.get('https://www.nseindia.com/api/fiidiiTradeReact', {
      timeout: 15_000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36',
        'Accept': 'application/json, text/plain, */*',
        'Referer': 'https://www.nseindia.com/reports/fii-dii',
        'Cookie': _equitySession.cookies,
      },
    });

    res.json(apiRes.data);
    const rows = Array.isArray(apiRes.data) ? apiRes.data : (apiRes.data?.data ?? []);
    console.log(`[NSEProxy] FII/DII: ${rows.length} rows`);
  } catch (err) {
    _equitySession.expiresAt = 0;
    console.error('[NSEProxy] FII/DII failed:', err.message);
    res.status(503).json({ error: err.message });
  }
});
// ── Option Chain endpoint ─────────────────────────────────────────────────────
// GET /option-chain?symbol=NIFTY&expiry=26-Jun-2025
//
// Fetches NSE option chain for a symbol + expiry combination.
// Results are cached 60s server-side — no polling needed from the app.
// Flutter calls this on screen open and on user-initiated refresh only.

const { fetchOptionChain } = require('./broker/optionChain');

app.get('/option-chain', async (req, res) => {
  try {
    const { symbol, expiry } = req.query;

    if (!symbol || typeof symbol !== 'string' || symbol.trim().length === 0) {
      return res.status(400).json({ error: 'symbol query param is required' });
    }

    const data = await fetchOptionChain(symbol.trim(), expiry?.trim() || null);
    res.json(data);
  } catch (err) {
    console.error('[OptionChain] Request failed:', err.message);
    res.status(503).json({ error: err.message });
  }
});

// POST /run-screeners
// Fetches NIFTY 500 quotes via Angel One, computes all screener buckets,
// returns JSON for Firebase Function to write to Firestore.

const { computeScreeners } = require('./broker/screener');

let _screenerRunning = false; // prevent overlapping runs

app.post('/run-screeners', async (req, res) => {
  if (_screenerRunning) {
    console.warn('[Screeners] Already running — skipping duplicate request');
    return res.status(409).json({ success: false, error: 'Already running' });
  }
  _screenerRunning = true;
  try {
    console.log('[Screeners] Starting computation via Angel One...');
    const results = await computeScreeners();
    res.json({ success: true, results });
    console.log('[Screeners] ✅ Computation complete, sent to Firebase Function');
  } catch (err) {
    console.error('[Screeners] Failed:', err.message);
    res.status(503).json({ success: false, error: err.message });
  } finally {
    _screenerRunning = false;
  }
});


// ── Order Execution endpoints ─────────────────────────────────────────────────
// Backed by orderExecutor.js which calls Angel One SmartAPI and syncs to Firestore.

const orderExecutor = require('./broker/orderExecutor');

// POST /place-order
// Body: { userId, symbol, exchange, action, orderType, quantity, price, triggerPrice, signalId }
app.post('/place-order', async (req, res) => {
  try {
    const {
      userId, symbol, exchange, action, orderType,
      quantity, price, triggerPrice = 0, signalId = null,
    } = req.body;

    if (!userId || !symbol || !exchange || !action || !orderType || !quantity) {
      return res.status(400).json({
        success: false,
        error: 'userId, symbol, exchange, action, orderType, and quantity are required',
      });
    }

    const result = await orderExecutor.placeOrder({
      symbol, exchange, action, orderType,
      quantity, price, triggerPrice,
      userId, signalId,
    });

    res.json(result);
  } catch (err) {
    console.error('[API] /place-order failed:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /cancel-order
// Body: { angelOrderId, userId }
app.post('/cancel-order', async (req, res) => {
  try {
    const { angelOrderId, userId } = req.body;

    if (!angelOrderId || !userId) {
      return res.status(400).json({ success: false, error: 'angelOrderId and userId are required' });
    }

    const result = await orderExecutor.cancelOrder({ angelOrderId, userId });
    res.json(result);
  } catch (err) {
    console.error('[API] /cancel-order failed:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /modify-order
// Body: { angelOrderId, orderType, quantity, price, triggerPrice, userId }
app.post('/modify-order', async (req, res) => {
  try {
    const { angelOrderId, orderType, quantity, price, triggerPrice = 0, userId } = req.body;

    if (!angelOrderId || !orderType || !quantity || !userId) {
      return res.status(400).json({
        success: false,
        error: 'angelOrderId, orderType, quantity, and userId are required',
      });
    }

    const result = await orderExecutor.modifyOrder({
      angelOrderId, orderType, quantity, price, triggerPrice, userId,
    });

    res.json(result);
  } catch (err) {
    console.error('[API] /modify-order failed:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /order-book/:userId — sync from Angel One then return all Firestore orders for user
app.get('/order-book/:userId', async (req, res) => {
  try {
    const { userId } = req.params;

    if (!userId) {
      return res.status(400).json({ success: false, error: 'userId is required' });
    }

    // Sync the latest order book from Angel One first
    const syncResult = await orderExecutor.syncOrderBook(userId);

    // Then fetch from Firestore so the response is the single source of truth
    const snap = await require('firebase-admin')
      .firestore()
      .collection('orders')
      .where('user_id', '==', userId)
      .orderBy('placed_at', 'desc')
      .limit(100)
      .get();

    const orders = snap.docs.map(doc => ({ id: doc.id, ...doc.data() }));

    res.json({ success: true, synced: syncResult.synced, orders });
  } catch (err) {
    console.error('[API] /order-book failed:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── Position sync endpoints ───────────────────────────────────────────────────
// Backed by positionManager.js which calls Angel One and syncs to Firestore.

const positionManager = require('./broker/positionManager');

// POST /sync-positions/:userId — fetch from Angel One, upsert to Firestore
app.post('/sync-positions/:userId', async (req, res) => {
  try {
    const { userId } = req.params;

    if (!userId) {
      return res.status(400).json({ success: false, error: 'userId is required' });
    }

    const result = await positionManager.syncPositions(userId);
    res.json({ success: true, ...result });
  } catch (err) {
    console.error('[API] /sync-positions failed:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /close-position
// Body: { positionId, userId }
app.post('/close-position', async (req, res) => {
  try {
    const { positionId, userId } = req.body;

    if (!positionId || !userId) {
      return res.status(400).json({
        success: false,
        error: 'positionId and userId are required',
      });
    }

    const result = await positionManager.closePosition({ positionId, userId });
    res.json(result);
  } catch (err) {
    console.error('[API] /close-position failed:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /broker/verify
// Body: { uid, brokerId }
// Reads the user's broker credentials from Firestore broker_connections subcollection,
// performs a test Angel One login using those credentials, and returns success/failure.
// Called by the Flutter BrokerRepository after saving credentials.
app.post('/broker/verify', async (req, res) => {
  try {
    // Authenticate the caller — require a valid Firebase ID token
    const authHeader = req.headers.authorization || '';
    const idToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
    if (!idToken) {
      return res.status(401).json({ success: false, error: 'Authorization token required' });
    }

    let callerUid;
    try {
      const decoded = await verifyToken(idToken);
      callerUid = decoded.uid;
    } catch (authErr) {
      return res.status(401).json({ success: false, error: 'Invalid or expired token' });
    }

    const { uid, brokerId = 'angel_one' } = req.body;

    if (!uid) {
      return res.status(400).json({ success: false, error: 'uid is required' });
    }

    // Only allow users to verify their own broker credentials
    if (callerUid !== uid) {
      return res.status(403).json({ success: false, error: 'Forbidden — uid mismatch' });
    }

    const admin = require('firebase-admin');
    const db = admin.firestore();

    // Read credentials from users/{uid}/broker_connections/{brokerId}
    const credsDoc = await db
      .collection('users')
      .doc(uid)
      .collection('broker_connections')
      .doc(brokerId)
      .get();

    if (!credsDoc.exists) {
      return res.status(404).json({
        success: false,
        error: 'Broker credentials not found. Please save your credentials first.',
      });
    }

    const creds = credsDoc.data();
    const { client_id, api_key, totp_secret, pin } = creds;

    if (!client_id || !api_key || !totp_secret || !pin) {
      return res.status(400).json({
        success: false,
        error: 'Incomplete credentials — client_id, api_key, totp_secret, and pin are required.',
      });
    }

    // Perform a test login using the user's credentials
    const speakeasy = require('speakeasy');
    const axios = require('axios');

    const totp = speakeasy.totp({
      secret:   totp_secret,
      encoding: 'base32',
    });

    console.log(`[BrokerVerify] Testing Angel One login for user ${uid} (client: ${client_id})...`);

    let loginRes;
    try {
      loginRes = await axios.post(
        'https://apiconnect.angelone.in/rest/auth/angelbroking/user/v1/loginByPassword',
        {
          clientcode: client_id,
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
            'X-PrivateKey':     api_key,
          },
          timeout: 15_000,
        }
      );
    } catch (netErr) {
      console.error(`[BrokerVerify] Network error for ${uid}:`, netErr.message);
      return res.status(503).json({
        success: false,
        error: `Could not reach Angel One API: ${netErr.message}`,
      });
    }

    if (loginRes.data?.status !== true) {
      const reason = loginRes.data?.message || 'Login failed';
      console.warn(`[BrokerVerify] Login failed for ${uid}: ${reason}`);
      return res.status(200).json({ success: false, error: reason });
    }

    // Login succeeded — update last_verified_at and is_connected in Firestore
    // (Flutter also updates these, but the server is the authoritative verifier)
    await credsDoc.ref.update({
      is_connected:     true,
      last_verified_at: admin.firestore.FieldValue.serverTimestamp(),
    });

    console.log(`[BrokerVerify] ✅ Verified Angel One for user ${uid}`);
    res.json({ success: true });
  } catch (err) {
    console.error('[BrokerVerify] Unexpected error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/start-broker', async (req, res) => {
  if (angelOne.isConnected()) {
    return res.json({ success: true, message: 'Broker already connected' });
  }
  try {
    await startBroker();
    res.json({ success: true, message: 'Broker started' });
  } catch (err) {
    console.error('[Broker] Manual start failed:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/stop-broker', (req, res) => {
  if (!angelOne.isConnected()) {
    return res.json({ success: true, message: 'Broker already disconnected' });
  }
  angelOne.disconnect();
  // Keep cache intact — don't clear prices on manual stop
  io.emit('broker_status', { status: 'market_closed', ts: Date.now() });
  console.log('[Broker] Manually stopped.');
  res.json({ success: true, message: 'Broker stopped' });
});
// ── Socket.IO ─────────────────────────────────────────────────────────────────

const io = new Server(server, {
  cors: {
    origin: config.server.allowedOrigins.length > 0
      ? config.server.allowedOrigins
      : '*',
    methods: ['GET', 'POST'],
  },
  transports: ['websocket', 'polling'],
  pingTimeout:  60_000,  // 60s — Android can hold a socket "alive" for longer
  pingInterval: 25_000,  // ping every 25s to detect dead connections
});

// ── Auth middleware ───────────────────────────────────────────────────────────

io.use(async (socket, next) => {
  try {
    const token = socket.handshake.auth?.token
               || socket.handshake.headers?.authorization?.replace('Bearer ', '');

    if (!token) {
      // Allow unauthenticated — price data is not sensitive
      socket.userId = 'anonymous';
      return next();
    }

    try {
      const decoded  = await verifyToken(token);
      socket.userId  = decoded.uid;
      socket.email   = decoded.email;
      console.log(`[Auth] ✅ Authenticated: ${decoded.uid}`);
    } catch (tokenErr) {
      // Token expired or invalid — still allow connection for price feed
      // The token expiry happens after long background sessions on Android.
      // Price data is not sensitive enough to block on auth failure.
      console.warn(`[Auth] Token verify failed (${tokenErr.message}) — allowing as anonymous`);
      socket.userId = 'anonymous';
    }

    next();
  } catch (err) {
    console.error('[Auth] Middleware error:', err.message);
    // Allow through even on middleware errors — don't block price data
    socket.userId = 'anonymous';
    next();
  }
});

// ── Connection handler ────────────────────────────────────────────────────────

io.on('connection', (socket) => {
  // Send current snapshot immediately so the client isn't blank
  const snapshot = priceCache.getAll();
  if (Object.keys(snapshot).length > 0) {
    socket.emit('snapshot', snapshot);
  }

  // Immediately tell the client whether the market is currently open or closed.
  // This handles the case where the client connects after market close —
  // the broker_status event already fired at 3:30 PM and won't fire again.
  const isMarketOpen = angelOne.isConnected();
  socket.emit('broker_status', {
    status: isMarketOpen ? 'connected' : 'market_closed',
    ts: Date.now(),
  });

  // ── subscribe ──────────────────────────────────────────────────────────────
  socket.on('subscribe', (symbols) => {
    const list = Array.isArray(symbols)
      ? symbols
      : typeof symbols === 'string'
        ? [symbols]
        : [];

    if (list.length === 0) return;

    list.forEach(symbol => {
      if (typeof symbol !== 'string' || symbol.length === 0) return;
      socket.join(symbol);
      const cached = priceCache.get(symbol);
      if (cached) {
        socket.emit('price', { symbol, ...cached });
      }
    });
  });

  // ── unsubscribe ────────────────────────────────────────────────────────────
  socket.on('unsubscribe', (symbols) => {
    const list = Array.isArray(symbols)
      ? symbols
      : typeof symbols === 'string'
        ? [symbols]
        : [];
    list.forEach(symbol => socket.leave(symbol));
  });

  socket.on('error', (err) => {
    console.error(`[Socket.IO] Socket error (${socket.id}):`, err.message);
  });
});

// ── Broadcast loop ────────────────────────────────────────────────────────────
// Every BROADCAST_INTERVAL_MS, drain pending price changes.
// Sends both individual 'price' events (for room-based delivery) AND
// a single 'prices_batch' event (for 500+ symbol setups where Flutter filters).

let _tickCount = 0;

setInterval(() => {
  const changed = priceCache.drainPending();
  if (changed.size === 0) return;

  _tickCount += changed.size;

  // Build batch object for clients that support prices_batch
  const batch = {};
  for (const [symbol, data] of changed) {
    batch[symbol] = data;
    // Also emit to individual rooms for backward compatibility
    io.to(symbol).emit('price', { symbol, ...data });
  }

  // Emit batch to all clients — Flutter handles both 'price' and 'prices_batch'
  io.emit('prices_batch', batch);
}, config.broadcast.intervalMs);

// ── Stats log every 30s ───────────────────────────────────────────────────────

setInterval(() => {
  const clientCount = io.engine.clientsCount;
  const cached = priceCache.getAll();
  const symbolCount = Object.keys(cached).length;
  const samples = Object.entries(cached)
    .slice(0, 3)
    .map(([s, d]) => `${s}=₹${d.ltp}`)
    .join(', ');

  console.log(
    `[Stats] clients=${clientCount} | symbols=${symbolCount} | ticks/30s=${_tickCount}` +
    (samples ? ` | ${samples}` : '')
  );
  _tickCount = 0;
}, 30_000);

// ── Stale price detector — runs every 5 minutes during market hours ───────────
// Detects symbols that have stopped receiving ticks (possible contract roll or
// Angel One disconnection). For MCX commodities, also suggests the next contract
// from ScripMaster. Writes alerts to Firestore `price_alerts` collection.

const STALE_THRESHOLD_MS = 10 * 60 * 1000; // 10 minutes without a tick = stale
const MCX_UNDERLYINGS    = ['GOLD', 'SILVER', 'CRUDEOIL', 'NATURALGAS', 'COPPER'];

// Track last tick time per symbol (updated in broadcast loop)
const _lastTickTime = {};

// Patch the broadcast loop to update _lastTickTime
const _origInterval = setInterval; // already running — we hook into priceCache instead

// We read from priceCache.getAll() which stores the last tick timestamp
function _isMcxOpen() {
  const IST = new Date(Date.now() + 5.5 * 60 * 60 * 1000);
  const h = IST.getUTCHours(), m = IST.getUTCMinutes();
  const totalMin = h * 60 + m;
  return totalMin >= 540 && totalMin < 1410; // 9:00 AM – 11:30 PM IST
}

function _isNseOpen() {
  const IST = new Date(Date.now() + 5.5 * 60 * 60 * 1000);
  const h = IST.getUTCHours(), m = IST.getUTCMinutes();
  const totalMin = h * 60 + m;
  const day = IST.getUTCDay();
  if (day === 0 || day === 6) return false;
  return totalMin >= 555 && totalMin < 930; // 9:15 AM – 3:30 PM IST
}

setInterval(async () => {
  if (!angelOne.isConnected()) return; // only check during live feed

  const cached   = priceCache.getAll();
  const { INSTRUMENT_TOKENS } = require('./broker/instrumentTokens');
  const now = Date.now();
  const staleAlerts = [];

  for (const [symbol, data] of Object.entries(cached)) {
    const inst = INSTRUMENT_TOKENS[symbol];
    if (!inst) continue;

    const isMcx = inst.exchange === 'MCX';
    const isNse = inst.exchange === 'NSE' || inst.exchange === 'BSE';

    // Only check during that exchange's open hours
    if (isMcx  && !_isMcxOpen()) continue;
    if (isNse  && !_isNseOpen()) continue;

    const tsSec  = data.ts || 0;
    const ageMs  = now - tsSec;

    if (ageMs > STALE_THRESHOLD_MS) {
      console.warn(`[Stale] ${symbol} — last tick ${Math.round(ageMs / 60000)}m ago`);

      const alert = {
        symbol,
        exchange: inst.exchange,
        token:    inst.token,
        last_tick_ms: tsSec,
        age_minutes:  Math.round(ageMs / 60000),
        detected_at:  now,
        suggestion:   null,
      };

      // For MCX commodities, search ScripMaster for the next active contract
      if (isMcx) {
        const underlying = MCX_UNDERLYINGS.find(u => symbol.startsWith(u));
        if (underlying) {
          try {
            const results = await searchInstruments(underlying, {
              exchange: 'MCX',
              instrumentType: 'FUTCOM',
              limit: 5,
            });
            // Pick the nearest-expiry active contract that isn't the current one
            const suggestion = results.find(r =>
              r.symbol !== symbol &&
              r.token  !== inst.token
            );
            if (suggestion) {
              alert.suggestion = {
                symbol:      suggestion.symbol,
                token:       suggestion.token,
                exchange:    suggestion.exchange,
                expiry:      suggestion.expiry,
                lot_size:    suggestion.lotSize,
              };
              console.log(`[Stale] Suggested replacement for ${symbol}: ${suggestion.symbol}`);
            }
          } catch (err) {
            console.warn(`[Stale] ScripMaster lookup failed for ${underlying}:`, err.message);
          }
        }
      }

      staleAlerts.push(alert);
    }
  }

  if (staleAlerts.length === 0) return;

  // Write alerts to Firestore `price_alerts` collection
  try {
    const admin = require('firebase-admin');
    const db    = admin.firestore();
    const batch = db.batch();

    for (const alert of staleAlerts) {
      // Use symbol as doc ID so re-runs update in place (no duplicates)
      const ref = db.collection('price_alerts').doc(alert.symbol);
      batch.set(ref, {
        ...alert,
        status:     'pending',   // 'pending' | 'dismissed' | 'resolved'
        updated_at: admin.firestore.FieldValue.serverTimestamp(),
      }, { merge: true });
    }

    await batch.commit();
    console.log(`[Stale] Wrote ${staleAlerts.length} alert(s) to Firestore.`);
  } catch (err) {
    console.error('[Stale] Firestore write failed:', err.message);
  }
}, 5 * 60 * 1000); // check every 5 minutes

// ── Expired F&O token cleanup — runs daily at midnight IST ───────────────────
// Disables instrument_tokens in Firestore where expiry date has passed.
// This keeps the price feed clean without manual maintenance.

let _lastCleanupDate = '';

setInterval(async () => {
  const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
  const nowIst = new Date(Date.now() + IST_OFFSET_MS);
  const istDateStr = nowIst.toISOString().slice(0, 10);
  const h = nowIst.getUTCHours();
  const m = nowIst.getUTCMinutes();

  // Run once per day at 00:05 IST (just after midnight)
  if (istDateStr === _lastCleanupDate) return;
  if (h !== 0 || m < 5) return;

  _lastCleanupDate = istDateStr;

  try {
    const admin = require('firebase-admin');
    const db = admin.firestore();
    const snap = await db
      .collection('instrument_tokens')
      .where('enabled', '==', true)
      .get();

    let disabled = 0;
    const batch = db.batch();

    snap.docs.forEach(doc => {
      const { expiry } = doc.data();
      if (!expiry) return; // no expiry = equity/index, keep it

      // Parse expiry: "29MAY2025" or "2025-05-29"
      let expDate;
      try {
        if (expiry.includes('-')) {
          expDate = new Date(expiry);
        } else {
          const months = { JAN:0,FEB:1,MAR:2,APR:3,MAY:4,JUN:5,JUL:6,AUG:7,SEP:8,OCT:9,NOV:10,DEC:11 };
          const day  = parseInt(expiry.slice(0, 2));
          const mon  = months[expiry.slice(2, 5)];
          const year = parseInt(expiry.slice(5));
          expDate = new Date(year, mon, day);
        }
      } catch { return; }

      // Disable if expired (add 1 day grace period)
      const gracePeriodMs = 24 * 60 * 60 * 1000;
      if (expDate && expDate.getTime() + gracePeriodMs < Date.now()) {
        batch.update(doc.ref, { enabled: false, disabled_reason: 'expired' });
        disabled++;
      }
    });

    if (disabled > 0) {
      await batch.commit();
      console.log(`[Cleanup] Disabled ${disabled} expired F&O token(s).`);
      // Reload symbols so broker stops subscribing to expired contracts
      await loadFromFirestore();
    }
  } catch (err) {
    console.error('[Cleanup] F&O expiry cleanup failed:', err.message);
  }
}, 60_000); // check every minute, runs once per day at 00:05 IST

// ── Broker connection ─────────────────────────────────────────────────────────

async function startBroker() {
  const symbols = getAllSymbols();
  console.log(`[Broker] Starting feed for ${symbols.length} symbols...`);

  await angelOne.connect(
    symbols,
    // onTick — called for every incoming price tick
    (symbol, data) => {
      priceCache.update(symbol, data);
    },
    // onStatus
    (status, msg) => {
      console.log(`[Broker] Status: ${status}${msg ? ` — ${msg}` : ''}`);
      // Broadcast broker status to all connected admin clients
      io.emit('broker_status', { status, ts: Date.now() });
    }
  );
}

// ── Market hours scheduler ────────────────────────────────────────────────────
// Checks every minute if it's time to open or close the broker.
// This repeats daily automatically — no one-shot setTimeout issues.

let _brokerStartedToday = false;
let _brokerStoppedToday = false;
let _lastSchedulerDate  = '';

setInterval(() => {
  const nowUtc = Date.now();
  const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
  const nowIst = new Date(nowUtc + IST_OFFSET_MS);

  const istDateStr = nowIst.toISOString().slice(0, 10); // YYYY-MM-DD

  // Reset daily flags at midnight IST
  if (istDateStr !== _lastSchedulerDate) {
    _lastSchedulerDate  = istDateStr;
    _brokerStartedToday = false;
    _brokerStoppedToday = false;
  }

  const h = nowIst.getUTCHours();
  const m = nowIst.getUTCMinutes();
  const totalMin = h * 60 + m;

  const openMin  = config.market.openHour  * 60 + config.market.openMinute;
  const closeMin = config.market.closeHour * 60 + config.market.closeMinute;

  // Skip weekends — NSE is closed Saturday (6) and Sunday (0)
  const istDayOfWeek = nowIst.getUTCDay(); // 0=Sun, 1=Mon, ..., 6=Sat
  const isWeekend = istDayOfWeek === 0 || istDayOfWeek === 6;

  // Market open window: start broker once per day (weekdays only)
  if (!isWeekend && totalMin >= openMin && totalMin < closeMin && !_brokerStartedToday) {
    _brokerStartedToday = true;
    console.log('[Scheduler] Market open — starting broker...');
    startBroker().catch(err => console.error('[Broker] Start failed:', err.message));
  }

  // Market close: stop broker once per day (weekdays only)
  if (!isWeekend && totalMin >= closeMin && !_brokerStoppedToday && angelOne.isConnected()) {
    _brokerStoppedToday = true;
    console.log('[Scheduler] Market closed — disconnecting broker.');
    angelOne.disconnect();
    // Do NOT clear the cache — keep last known prices in memory and on disk
    // so Flutter clients see closing prices after market hours.
    io.emit('broker_status', { status: 'market_closed', ts: Date.now() });
  }
}, 60_000); // check every minute

// ── Start ─────────────────────────────────────────────────────────────────────

async function main() {
  initFirebase();

  // Load instrument tokens from Firestore (falls back to hardcoded if unavailable)
  await loadFromFirestore();

  server.listen(config.server.port, () => {
    console.log(`[Server] Algo Trading Price Server running on port ${config.server.port}`);
    console.log(`[Server] Health: http://localhost:${config.server.port}/health`);
  });

  // In development, connect immediately without waiting for market hours
  if (process.env.NODE_ENV === 'development') {
    startBroker().catch(err => {
      console.error('[Broker] Dev start failed (check credentials):', err.message);
    });
  }
  // Production: interval-based scheduler handles market hours automatically
}

main().catch(err => {
  console.error('[Fatal]', err);
  process.exit(1);
});
