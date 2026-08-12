/**
 * Option Chain Data Module
 * ─────────────────────────
 * Data sources tried in order:
 *   1. NSE option-chain API (with proper two-step session)
 *   2. Angel One REST option Greeks endpoint (fallback)
 *
 * Results cached 60 seconds server-side per symbol+expiry key.
 */

const axios  = require('axios');
const config = require('../config');
const angel  = require('./angelOne');

// ── In-memory cache ───────────────────────────────────────────────────────────

const _cache    = new Map();
const CACHE_TTL = 60 * 1000; // 60 seconds

function _cacheKey(symbol, expiry) {
  return `${symbol.toUpperCase()}__${expiry || 'latest'}`;
}

function _getCache(symbol, expiry) {
  const entry = _cache.get(_cacheKey(symbol, expiry));
  if (!entry) return null;
  if (Date.now() - entry.fetchedAt > CACHE_TTL) {
    _cache.delete(_cacheKey(symbol, expiry));
    return null;
  }
  return entry.data;
}

function _setCache(symbol, expiry, data) {
  _cache.set(_cacheKey(symbol, expiry), { data, fetchedAt: Date.now() });
}

// ── NSE session state ─────────────────────────────────────────────────────────

let _nseSession = { cookies: '', expiresAt: 0 };

async function _getNseSession() {
  if (Date.now() < _nseSession.expiresAt) return _nseSession.cookies;

  console.log('[OptionChain] Refreshing NSE session...');

  // Step 1: hit homepage to get initial cookies
  const homeRes = await axios.get('https://www.nseindia.com', {
    timeout: 12_000,
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.5',
      'Accept-Encoding': 'gzip, deflate, br',
      'Connection': 'keep-alive',
      'Upgrade-Insecure-Requests': '1',
    },
  });

  let cookies = (homeRes.headers['set-cookie'] || [])
    .map(c => c.split(';')[0])
    .filter(Boolean)
    .join('; ');

  // Step 2: hit option-chain page to get the remaining session cookies NSE needs
  await new Promise(r => setTimeout(r, 800));
  try {
    const ocRes = await axios.get('https://www.nseindia.com/option-chain', {
      timeout: 12_000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.5',
        'Referer': 'https://www.nseindia.com',
        'Cookie': cookies,
      },
    });
    const ocCookies = (ocRes.headers['set-cookie'] || [])
      .map(c => c.split(';')[0])
      .filter(Boolean);
    if (ocCookies.length > 0) {
      // Merge new cookies, overwriting existing keys
      const cookieMap = new Map(
        cookies.split('; ').filter(Boolean).map(c => c.split('='))
      );
      for (const c of ocCookies) {
        const [k, v] = c.split('=');
        cookieMap.set(k, v);
      }
      cookies = [...cookieMap.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
    }
  } catch (e) {
    // Non-fatal — proceed with homepage cookies
    console.warn('[OptionChain] NSE option-chain page fetch failed:', e.message);
  }

  _nseSession = { cookies, expiresAt: Date.now() + 15 * 60 * 1000 };
  await new Promise(r => setTimeout(r, 500));
  return _nseSession.cookies;
}

// ── Source 1: NSE ─────────────────────────────────────────────────────────────

const NSE_INDEX_SYMBOLS = new Set([
  'NIFTY', 'BANKNIFTY', 'FINNIFTY', 'MIDCPNIFTY', 'NIFTYNXT50', 'SENSEX',
]);

async function _fetchFromNse(symbol, expiry) {
  const cookies = await _getNseSession();

  const headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    'Accept': 'application/json, text/plain, */*',
    'Accept-Language': 'en-US,en;q=0.5',
    'Accept-Encoding': 'gzip, deflate, br',
    'Referer': 'https://www.nseindia.com/option-chain',
    'X-Requested-With': 'XMLHttpRequest',
    'Cookie': cookies,
    'Connection': 'keep-alive',
  };

  const isIndex  = NSE_INDEX_SYMBOLS.has(symbol.toUpperCase());
  const endpoint = isIndex
    ? 'https://www.nseindia.com/api/option-chain-indices'
    : 'https://www.nseindia.com/api/option-chain-equities';

  const res = await axios.get(endpoint, {
    params:  { symbol: symbol.toUpperCase() },
    timeout: 15_000,
    headers,
  });

  // NSE sometimes returns an HTML block page instead of JSON
  if (typeof res.data === 'string' || !res.data?.records) {
    throw new Error(`NSE returned non-JSON or blocked response for ${symbol}`);
  }

  const raw     = res.data;
  const records = raw?.filtered?.data || raw?.records?.data || [];

  if (!records || records.length === 0) {
    throw new Error(`NSE returned empty option chain for ${symbol}`);
  }

  const underlyingValue = raw?.records?.underlyingValue
    ?? raw?.filtered?.PE?.underlyingValue
    ?? 0;

  const allExpiries = raw?.records?.expiryDates || [];

  const targetExpiry = expiry && expiry !== 'latest'
    ? expiry
    : (allExpiries[0] || null);

  const filteredRecords = targetExpiry
    ? records.filter(r => r.expiryDate === targetExpiry)
    : records;

  const rowMap = new Map();

  for (const record of filteredRecords) {
    const strike = record.strikePrice;
    if (!rowMap.has(strike)) rowMap.set(strike, { strike, ce: null, pe: null });
    const row = rowMap.get(strike);

    if (record.CE) {
      row.ce = {
        oi:        record.CE.openInterest          || 0,
        oiChange:  record.CE.changeinOpenInterest   || 0,
        ltp:       record.CE.lastPrice              || 0,
        ltpChange: record.CE.change                 || 0,
        volume:    record.CE.totalTradedVolume       || 0,
        iv:        record.CE.impliedVolatility       || 0,
        bidQty:    record.CE.bidQty                 || 0,
        askQty:    record.CE.askQty                 || 0,
        bidPrice:  record.CE.bidprice               || 0,
        askPrice:  record.CE.askPrice               || 0,
      };
    }
    if (record.PE) {
      row.pe = {
        oi:        record.PE.openInterest          || 0,
        oiChange:  record.PE.changeinOpenInterest   || 0,
        ltp:       record.PE.lastPrice              || 0,
        ltpChange: record.PE.change                 || 0,
        volume:    record.PE.totalTradedVolume       || 0,
        iv:        record.PE.impliedVolatility       || 0,
        bidQty:    record.PE.bidQty                 || 0,
        askQty:    record.PE.askQty                 || 0,
        bidPrice:  record.PE.bidprice               || 0,
        askPrice:  record.PE.askPrice               || 0,
      };
    }
  }

  const rows = Array.from(rowMap.values()).sort((a, b) => b.strike - a.strike);
  if (rows.length === 0) throw new Error(`NSE: no strike rows parsed for ${symbol}`);

  console.log(`[OptionChain] NSE ✅ ${symbol} ${targetExpiry} — ${rows.length} strikes`);

  return {
    symbol: symbol.toUpperCase(),
    underlyingValue,
    expiry: targetExpiry,
    allExpiries,
    rows,
    source: 'nse',
    fetchedAt: Date.now(),
  };
}

// ── Source 2: Angel One option Greeks ────────────────────────────────────────
// Angel One SmartAPI — option chain via /v1/optionGreeks
// Docs: https://smartapi.angelbroking.com/docs/MarketData

async function _fetchFromAngelOne(symbol, expiry) {
  let authToken = angel.getAuthToken();
  if (!authToken) {
    console.log('[OptionChain] No Angel One auth token — triggering login...');
    await angel.login();
    authToken = angel.getAuthToken();
  }

  if (!authToken) throw new Error('Angel One auth token unavailable after login');

  // Angel One option Greeks needs the instrument name exactly as it appears
  // in their master — NIFTY, BANKNIFTY etc (no space, caps)
  const name = symbol.toUpperCase().replace(/\s/g, '');

  const payload = { name };
  if (expiry && expiry !== 'latest') payload.expirydate = expiry;

  let res;
  try {
    res = await axios.post(
      'https://apiconnect.angelone.in/rest/secure/angelbroking/market/v1/optionGreeks',
      payload,
      {
        timeout: 15_000,
        headers: {
          'Content-Type':  'application/json',
          'Accept':        'application/json',
          'Authorization': `Bearer ${authToken}`,
          'X-UserType':    'USER',
          'X-SourceID':    'WEB',
          'X-ClientLocalIP':  '127.0.0.1',
          'X-ClientPublicIP': '127.0.0.1',
          'X-MACAddress':     '00:00:00:00:00:00',
          'X-PrivateKey':  config.angel.apiKey,
        },
      }
    );
  } catch (axiosErr) {
    throw new Error(`Angel One HTTP error: ${axiosErr.message}`);
  }

  console.log('[OptionChain] AngelOne raw status:', res.data?.status, '| message:', res.data?.message);

  if (!res.data?.status) {
    throw new Error(`Angel One option Greeks failed: ${res.data?.message || JSON.stringify(res.data)}`);
  }

  const contracts = res.data?.data || [];
  if (contracts.length === 0) {
    throw new Error(`Angel One returned empty option chain for ${symbol}`);
  }

  const rowMap = new Map();
  let underlyingValue = 0;

  for (const c of contracts) {
    const strike  = parseFloat(c.strikePrice || 0);
    const optType = (c.optionType || '').toUpperCase();
    if (!strike || (optType !== 'CE' && optType !== 'PE')) continue;

    if (!rowMap.has(strike)) rowMap.set(strike, { strike, ce: null, pe: null });

    const side = {
      oi:        parseInt(c.openInterest         || 0, 10),
      oiChange:  parseInt(c.changeinOpenInterest  || 0, 10),
      ltp:       parseFloat(c.ltp                || 0),
      ltpChange: parseFloat(c.netChange          || 0),
      volume:    parseInt(c.tradeVolume          || 0, 10),
      iv:        parseFloat(c.impliedVolatility  || 0),
      delta:     parseFloat(c.delta              || 0),
      gamma:     parseFloat(c.gamma              || 0),
      theta:     parseFloat(c.theta              || 0),
      vega:      parseFloat(c.vega               || 0),
      bidQty:    0,
      askQty:    0,
      bidPrice:  0,
      askPrice:  0,
    };

    if (optType === 'CE') rowMap.get(strike).ce = side;
    else                  rowMap.get(strike).pe = side;

    if (c.underlyingValue) underlyingValue = parseFloat(c.underlyingValue);
  }

  const allExpiries = [...new Set(contracts.map(c => c.expiryDate).filter(Boolean))];
  const targetExpiry = expiry && expiry !== 'latest' ? expiry : (allExpiries[0] || null);
  const rows = Array.from(rowMap.values()).sort((a, b) => b.strike - a.strike);

  if (rows.length === 0) throw new Error(`Angel One: no strike rows parsed for ${symbol}`);

  console.log(`[OptionChain] AngelOne ✅ ${symbol} ${targetExpiry} — ${rows.length} strikes`);

  return {
    symbol: symbol.toUpperCase(),
    underlyingValue,
    expiry: targetExpiry,
    allExpiries,
    rows,
    source: 'angelone',
    fetchedAt: Date.now(),
  };
}

// ── Public API ────────────────────────────────────────────────────────────────

async function fetchOptionChain(symbol, expiry) {
  const cached = _getCache(symbol, expiry);
  if (cached) {
    console.log(`[OptionChain] Cache hit: ${symbol} ${expiry || 'latest'}`);
    return { ...cached, cached: true };
  }

  const sources = [
    ['NSE',       () => _fetchFromNse(symbol, expiry)],
    ['AngelOne',  () => _fetchFromAngelOne(symbol, expiry)],
  ];

  const errors = [];

  for (const [name, fn] of sources) {
    try {
      const data = await fn();
      _setCache(symbol, expiry, data);
      return { ...data, cached: false };
    } catch (err) {
      const msg = err.message || String(err);
      errors.push(`${name}: ${msg}`);
      console.warn(`[OptionChain] ${name} failed for ${symbol}:`, msg);
      // Invalidate NSE session on failure
      if (name === 'NSE') _nseSession.expiresAt = 0;
    }
  }

  throw new Error(`All option chain sources failed — ${errors.join(' | ')}`);
}

module.exports = { fetchOptionChain };
