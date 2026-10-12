/**
 * backtestEngine.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Fetches historical OHLCV candles from Angel One and runs a strategy
 * simulation over them, returning the metrics consumed by the Flutter
 * BacktestPanel widget.
 *
 * Angel One historical candle API:
 *   POST /rest/secure/angelbroking/historical/v1/getCandleData
 *   Body: { exchange, symboltoken, interval, fromdate, todate }
 *   Response: { status, data: [[timestamp, open, high, low, close, volume], ...] }
 *
 * Intervals accepted by Angel One:
 *   ONE_MINUTE  THREE_MINUTE  FIVE_MINUTE  TEN_MINUTE  FIFTEEN_MINUTE
 *   THIRTY_MINUTE  ONE_HOUR  ONE_DAY
 *
 * Auth: uses the server's own Angel One session (from angelOne.js getAuthToken).
 * The global session is authenticated at market open and stays valid all day.
 * If it's currently outside market hours we attempt a fresh login.
 */

'use strict';

const axios          = require('axios');
const config         = require('../config');
const angelOne       = require('./angelOne');
const { getInstrument } = require('./instrumentTokens');
const { loadScripMaster } = require('./scripMaster');

const ANGEL_BASE = 'https://apiconnect.angelone.in';

// ── Timeframe mapping ─────────────────────────────────────────────────────────
// Flutter chip value → Angel One interval string

const TF_MAP = {
  '1m':  'ONE_MINUTE',
  '3m':  'THREE_MINUTE',
  '5m':  'FIVE_MINUTE',
  '10m': 'TEN_MINUTE',
  '15m': 'FIFTEEN_MINUTE',
  '30m': 'THIRTY_MINUTE',
  '1H':  'ONE_HOUR',
  '1D':  'ONE_DAY',
};

// ── Index tokens (NSE) ────────────────────────────────────────────────────────
// Angel One's historical API needs the instrument token, not just the symbol.
// These are fixed tokens for NSE indices — they never change.

const INDEX_TOKENS = {
  NIFTY:       { token: '99926000', exchange: 'NSE' },
  BANKNIFTY:   { token: '99926009', exchange: 'NSE' },
  FINNIFTY:    { token: '99926037', exchange: 'NSE' },
  MIDCPNIFTY:  { token: '99926074', exchange: 'NSE' },
  SENSEX:      { token: '99919000', exchange: 'BSE' },
};

// Default lot sizes per underlying
const LOT_SIZES = {
  NIFTY:      50,
  BANKNIFTY:  15,
  FINNIFTY:   40,
  MIDCPNIFTY: 75,
  SENSEX:     10,
};

// ── Date helpers ──────────────────────────────────────────────────────────────

/**
 * Format a Date as "YYYY-MM-DD HH:MM" in IST (required by Angel One).
 * @param {Date} d
 * @returns {string}
 */
function _fmtIst(d) {
  const ist = new Date(d.getTime() + 5.5 * 60 * 60 * 1000);
  const pad = n => String(n).padStart(2, '0');
  return (
    `${ist.getUTCFullYear()}-${pad(ist.getUTCMonth() + 1)}-${pad(ist.getUTCDate())} ` +
    `${pad(ist.getUTCHours())}:${pad(ist.getUTCMinutes())}`
  );
}

/**
 * Build Angel One date range for the requested lookback.
 * Now honours the 'range' string from Flutter (e.g. '1 Month', '3 Months',
 * '6 Months', '1 Year', '2 Years') while still capping at Angel One's per-interval limits.
 *
 * @param {string} interval - Angel One interval string
 * @param {string} range    - human-readable period from Flutter UI
 * @returns {{ fromdate: string, todate: string }}
 */
function _dateRange(interval, range = '3 Months') {
  const now  = new Date();
  const from = new Date(now);

  // Parse the range string into a requested number of calendar days
  const RANGE_DAYS = {
    '1 month':  30,  '1 months':  30,
    '3 months': 90,  '6 months': 180,
    '1 year':  365,  '2 years':  730,
  };
  const requestedDays = RANGE_DAYS[range.toLowerCase()] ?? 90;

  // For daily/hourly intervals enforce a minimum so EMA(50) has enough bars.
  // EMA(50) needs 50 bars to init + warmup + enough bars to trade.
  // ONE_DAY: force minimum 400 calendar days (~280 trading days) so even
  // "1 Month" period selection still produces meaningful backtest results.
  const MIN_DAYS = {
    'ONE_DAY':  400,  // ~280 trading days — comfortable for EMA(50/200) + trades
    'ONE_HOUR': 120,  // ~84 trading days
  };
  const minDays = MIN_DAYS[interval] ?? 0;

  // Angel One per-interval hard caps (slightly under their documented limits)
  const MAX_DAYS = {
    'ONE_MINUTE':     25,
    'THREE_MINUTE':   55,
    'FIVE_MINUTE':    90,
    'TEN_MINUTE':     90,
    'FIFTEEN_MINUTE': 180,
    'THIRTY_MINUTE':  180,
    'ONE_HOUR':       365,
    'ONE_DAY':        730,
  };
  const maxDays    = MAX_DAYS[interval] ?? 180;
  const actualDays = Math.min(Math.max(requestedDays, minDays), maxDays);

  from.setDate(from.getDate() - actualDays);

  // fromdate: market open (09:15)   todate: market close (15:30)
  const fromDate = new Date(from);
  fromDate.setHours(3, 45, 0, 0);  // 09:15 IST = 03:45 UTC

  const toDate = new Date(now);
  toDate.setHours(10, 0, 0, 0);    // 15:30 IST = 10:00 UTC

  return {
    fromdate: _fmtIst(fromDate),
    todate:   _fmtIst(toDate),
  };
}

// ── Candle fetch ──────────────────────────────────────────────────────────────

/**
 * Fetch historical OHLCV candles from Angel One.
 *
 * @param {string} underlying - e.g. 'NIFTY'
 * @param {string} interval   - Angel One interval constant
 * @returns {Promise<Array<{ time, open, high, low, close, volume }>>}
 */
async function _fetchCandles(underlying, interval, range = '3 Months') {
  const sym = underlying.toUpperCase();

  // ── Resolve instrument token ─────────────────────────────────────────────
  // 1. Check INDEX_TOKENS (NSE/BSE indices — use dedicated historical tokens)
  // 2. Fall back to instrumentTokens.js (Firestore + hardcoded stock map)
  // 3. Last resort: search ScripMaster for the NSE EQ token

  let inst = INDEX_TOKENS[sym];

  if (!inst) {
    // Try the shared instrumentTokens map (covers ~25 liquid stocks + MCX)
    const it = getInstrument(sym);
    if (it) {
      inst = { token: it.token, exchange: it.exchange };
    }
  }

  if (!inst) {
    // Last resort — scan Angel One ScripMaster for an exact NSE EQ match
    try {
      const master   = await loadScripMaster();
      const match    = master.find(
        r => r.symbol && r.symbol.toUpperCase() === sym && r.exch_seg === 'NSE' &&
             (!r.instrumenttype || r.instrumenttype === '' || r.instrumenttype === 'EQ')
      );
      if (match) {
        inst = { token: String(match.token), exchange: 'NSE' };
        console.log(`[Backtest] Resolved ${sym} → token ${inst.token} via ScripMaster`);
      }
    } catch (smErr) {
      console.warn('[Backtest] ScripMaster lookup failed:', smErr.message);
    }
  }

  if (!inst) {
    throw new Error(
      `Unknown underlying "${underlying}". ` +
      `Supported indices: ${Object.keys(INDEX_TOKENS).join(', ')}. ` +
      `For stocks, ensure the symbol matches the NSE ticker exactly (e.g. HDFCBANK, RELIANCE).`
    );
  }

  let authToken = angelOne.getAuthToken();
  if (!authToken) {
    console.log('[Backtest] No active auth token — logging in...');
    const session = await angelOne.login();
    authToken = session.authToken;
  }

  const { fromdate, todate } = _dateRange(interval, range);

  console.log(`[Backtest] Fetching ${interval} candles for ${underlying} (${fromdate} → ${todate})`);

  const res = await axios.post(
    `${ANGEL_BASE}/rest/secure/angelbroking/historical/v1/getCandleData`,
    {
      exchange:    inst.exchange,
      symboltoken: inst.token,
      interval,
      fromdate,
      todate,
    },
    {
      headers: {
        'Content-Type':     'application/json',
        'Accept':           'application/json',
        'Authorization':    `Bearer ${authToken}`,
        'X-UserType':       'USER',
        'X-SourceID':       'WEB',
        'X-ClientLocalIP':  '127.0.0.1',
        'X-ClientPublicIP': '127.0.0.1',
        'X-MACAddress':     '00:00:00:00:00:00',
        'X-PrivateKey':     config.angel.apiKey,
      },
      timeout: 30_000,
    }
  );

  if (!res.data?.status) {
    const msg = res.data?.message || JSON.stringify(res.data);
    throw new Error(`Angel One candle API error: ${msg}`);
  }

  const raw = res.data.data;
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new Error(`No candle data returned for ${underlying} (${interval})`);
  }

  // Each row: [timestamp_str, open, high, low, close, volume]
  const candles = raw.map(row => ({
    time:   new Date(row[0]).getTime(),
    open:   Number(row[1]),
    high:   Number(row[2]),
    low:    Number(row[3]),
    close:  Number(row[4]),
    volume: Number(row[5] ?? 0),
  }));

  console.log(`[Backtest] Received ${candles.length} candles for ${underlying}`);
  return candles;
}

// ── Simple Moving Average helper ──────────────────────────────────────────────

/**
 * Compute a simple moving average over the closes array up to index i.
 * Returns null if there aren't enough bars yet.
 *
 * @param {number[]} closes
 * @param {number}   i       - current index
 * @param {number}   period
 * @returns {number|null}
 */
function _sma(closes, i, period) {
  if (i < period - 1) return null;
  let sum = 0;
  for (let j = i - period + 1; j <= i; j++) sum += closes[j];
  return sum / period;
}

// ── EMA helper ────────────────────────────────────────────────────────────────

/**
 * Compute EMA values for the full closes array.
 * Returns an array of the same length — values at the start (< period-1) are null.
 *
 * @param {number[]} closes
 * @param {number}   period
 * @returns {(number|null)[]}
 */
function _emaArray(closes, period) {
  const k = 2 / (period + 1);
  const result = new Array(closes.length).fill(null);

  // Seed with SMA
  let seedSum = 0;
  for (let i = 0; i < period && i < closes.length; i++) seedSum += closes[i];
  if (closes.length < period) return result;

  result[period - 1] = seedSum / period;

  for (let i = period; i < closes.length; i++) {
    result[i] = closes[i] * k + result[i - 1] * (1 - k);
  }
  return result;
}

// ── RSI helper ────────────────────────────────────────────────────────────────

/**
 * Compute RSI values for the full closes array (Wilder smoothing).
 * @param {number[]} closes
 * @param {number}   period  (default 14)
 * @returns {(number|null)[]}
 */
function _rsiArray(closes, period = 14) {
  const result = new Array(closes.length).fill(null);
  if (closes.length <= period) return result;

  let avgGain = 0, avgLoss = 0;
  for (let i = 1; i <= period; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff > 0) avgGain += diff; else avgLoss += Math.abs(diff);
  }
  avgGain /= period;
  avgLoss /= period;

  const rs0 = avgLoss === 0 ? 100 : avgGain / avgLoss;
  result[period] = 100 - 100 / (1 + rs0);

  for (let i = period + 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    const gain = diff > 0 ? diff : 0;
    const loss = diff < 0 ? Math.abs(diff) : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
    const rs = avgLoss === 0 ? 100 : avgGain / avgLoss;
    result[i] = 100 - 100 / (1 + rs);
  }
  return result;
}

// ── Indicator value lookup ────────────────────────────────────────────────────

/**
 * Return the indicator value at index i given all precomputed arrays.
 *
 * @param {string}  indicator   - from _Condition.indicator
 * @param {string}  paramA      - period param (stringified int)
 * @param {object}  cache       - { ema, sma, rsi, volume } keyed arrays
 * @param {number}  i           - current bar index
 * @param {object}  candle      - current OHLCV candle
 * @returns {number|null}
 */
// ── Normalise a condition object — handle both snake_case (from Flutter toMap)
// and camelCase (legacy) field names so both work transparently.
// ─────────────────────────────────────────────────────────────────────────────
function _normCond(c) {
  return {
    lhsType:   c.lhs_type        || c.lhsType        || 'Indicator',
    indicator: c.indicator       || '',
    lhsPrice:  c.lhs_price       || c.lhsPrice        || 'Close',
    paramA:    c.param_a         || c.paramA          || '14',
    paramB:    c.param_b         || c.paramB          || '14',
    paramC:    c.param_c         || c.paramC          || '9',
    candleSrc: c.candle_src      || c.candleSrc       || 'Current Candle',
    op:        c.operator        || c.op              || '>',
    rhsIsInd:  c.rhs_is_indicator != null ? c.rhs_is_indicator : (c.rhsIsInd || false),
    valueA:    c.value_a         || c.valueA          || '0',
    valueB:    c.value_b         || c.valueB          || '',
    rhsPeriod: c.rhs_period      || c.rhsPeriod       || '14',
    logic:     c.logic           || 'AND',
  };
}

function _indValue(indicator, paramA, cache, i, candle) {
  const period = parseInt(paramA) || 14;

  switch (indicator) {
    case 'EMA': {
      const key = `ema_${period}`;
      if (!cache[key]) cache[key] = _emaArray(cache.closes, period);
      return cache[key][i];
    }
    case 'SMA': {
      const key = `sma_${period}`;
      if (!cache[key]) cache[key] = cache.closes.map((_, j) => _sma(cache.closes, j, period));
      return cache[key][i];
    }
    case 'RSI': {
      const key = `rsi_${period}`;
      if (!cache[key]) cache[key] = _rsiArray(cache.closes, period);
      return cache[key][i];
    }
    case 'VWAP': {
      // VWAP: cumulative (close × volume) / cumulative volume, reset per day
      if (!cache.vwap) {
        const v = new Array(cache.closes.length).fill(null);
        let cumTpv = 0, cumVol = 0, lastDay = null;
        for (let j = 0; j < cache.candles.length; j++) {
          const cn = cache.candles[j];
          const day = new Date(cn.time).toDateString();
          if (day !== lastDay) { cumTpv = 0; cumVol = 0; lastDay = day; }
          const tp  = (cn.high + cn.low + cn.close) / 3;
          cumTpv += tp * cn.volume;
          cumVol += cn.volume;
          v[j] = cumVol > 0 ? cumTpv / cumVol : cn.close;
        }
        cache.vwap = v;
      }
      return cache.vwap[i];
    }
    case 'MACD': {
      // MACD line = EMA(fast) - EMA(slow). paramA = fast (12), paramB handled in caller.
      const fast = period;   // from paramA
      const slow = 26;       // standard default — caller passes paramB separately
      const keyM = `macd_${fast}_${slow}`;
      if (!cache[keyM]) {
        const emaFast = _emaArray(cache.closes, fast);
        const emaSlow = _emaArray(cache.closes, slow);
        cache[keyM] = cache.closes.map((_, j) =>
          emaFast[j] != null && emaSlow[j] != null ? emaFast[j] - emaSlow[j] : null
        );
      }
      return cache[keyM][i];
    }
    case 'ATR': {
      const key = `atr_${period}`;
      if (!cache[key]) {
        const atr = new Array(cache.candles.length).fill(null);
        const trs = cache.candles.map((cn, j) => {
          if (j === 0) return cn.high - cn.low;
          const prev = cache.candles[j - 1].close;
          return Math.max(cn.high - cn.low, Math.abs(cn.high - prev), Math.abs(cn.low - prev));
        });
        // Wilder smooth
        let sum = 0;
        for (let j = 0; j < period && j < trs.length; j++) sum += trs[j];
        if (trs.length >= period) atr[period - 1] = sum / period;
        for (let j = period; j < trs.length; j++) {
          atr[j] = (atr[j - 1] * (period - 1) + trs[j]) / period;
        }
        cache[key] = atr;
      }
      return cache[key][i];
    }
    case 'Bollinger Bands': {
      // Returns upper band value; paramA = period (20), stdDev default 2
      const key = `bb_upper_${period}`;
      if (!cache[key]) {
        cache[key] = cache.closes.map((_, j) => {
          if (j < period - 1) return null;
          const slice = cache.closes.slice(j - period + 1, j + 1);
          const mean  = slice.reduce((a, b) => a + b, 0) / period;
          const std   = Math.sqrt(slice.reduce((s, v) => s + (v - mean) ** 2, 0) / period);
          return mean + 2 * std;
        });
      }
      return cache[key][i];
    }
    case 'Supertrend': {
      // Simplified: returns 1 if bullish, -1 if bearish (compares to price)
      // Uses ATR(paramA) with multiplier 3
      const atrKey = `atr_${period}`;
      if (!cache[atrKey]) {
        const atr = new Array(cache.candles.length).fill(null);
        const trs = cache.candles.map((cn, j) => {
          if (j === 0) return cn.high - cn.low;
          const prev = cache.candles[j - 1].close;
          return Math.max(cn.high - cn.low, Math.abs(cn.high - prev), Math.abs(cn.low - prev));
        });
        let sum = 0;
        for (let j = 0; j < period && j < trs.length; j++) sum += trs[j];
        if (trs.length >= period) atr[period - 1] = sum / period;
        for (let j = period; j < trs.length; j++) {
          atr[j] = (atr[j - 1] * (period - 1) + trs[j]) / period;
        }
        cache[atrKey] = atr;
      }
      const stKey = `st_${period}`;
      if (!cache[stKey]) {
        const st = new Array(cache.candles.length).fill(null);
        let isBull = true;
        for (let j = period; j < cache.candles.length; j++) {
          const cn  = cache.candles[j];
          const mid = (cn.high + cn.low) / 2;
          const atrV = cache[atrKey][j];
          if (atrV == null) continue;
          const upper = mid + 3 * atrV;
          const lower = mid - 3 * atrV;
          if (cn.close > upper) isBull = false;
          if (cn.close < lower) isBull = true;
          st[j] = isBull ? 1 : -1;
        }
        cache[stKey] = st;
      }
      return cache[stKey][i];
    }
    case 'CCI': {
      const key = `cci_${period}`;
      if (!cache[key]) {
        cache[key] = cache.candles.map((cn, j) => {
          if (j < period - 1) return null;
          const slice = cache.candles.slice(j - period + 1, j + 1);
          const tps   = slice.map(c => (c.high + c.low + c.close) / 3);
          const mean  = tps.reduce((a, b) => a + b, 0) / period;
          const mad   = tps.reduce((s, v) => s + Math.abs(v - mean), 0) / period;
          const tp    = (cn.high + cn.low + cn.close) / 3;
          return mad === 0 ? 0 : (tp - mean) / (0.015 * mad);
        });
      }
      return cache[key][i];
    }
    case 'ADX': {
      // Simplified ADX using DX average — returns 0-100
      const key = `adx_${period}`;
      if (!cache[key]) {
        const adx = new Array(cache.candles.length).fill(null);
        const dxArr = [];
        for (let j = 1; j < cache.candles.length; j++) {
          const curr = cache.candles[j], prev = cache.candles[j - 1];
          const upMove   = curr.high - prev.high;
          const downMove = prev.low  - curr.low;
          const plusDM   = (upMove > downMove && upMove > 0) ? upMove : 0;
          const minusDM  = (downMove > upMove && downMove > 0) ? downMove : 0;
          const tr = Math.max(curr.high - curr.low, Math.abs(curr.high - prev.close), Math.abs(curr.low - prev.close));
          const plusDI  = tr > 0 ? 100 * plusDM  / tr : 0;
          const minusDI = tr > 0 ? 100 * minusDM / tr : 0;
          const diff = Math.abs(plusDI - minusDI);
          const sum  = plusDI + minusDI;
          dxArr.push(sum > 0 ? (diff / sum) * 100 : 0);
        }
        let avg = dxArr.slice(0, period).reduce((a, b) => a + b, 0) / period;
        adx[period] = avg;
        for (let j = period + 1; j < cache.candles.length; j++) {
          avg = (avg * (period - 1) + dxArr[j - 1]) / period;
          adx[j] = avg;
        }
        cache[key] = adx;
      }
      return cache[key][i];
    }
    case 'Volume':
      return candle.volume;
    case 'Option Premium':
      return candle.close * 0.02;
    case 'OI':
    case 'PCR':
    case 'IV / IV Rank':
      // Not available in OHLCV data — return neutral so they don't block entry
      return 50;
    default:
      return null;
  }
}

// ── LHS value resolver — handles lhs_type: 'Price' (OHLC) vs 'Indicator' ─────
function _lhsValue(cond, cache, i, candle) {
  if (cond.lhsType === 'Price') {
    switch (cond.lhsPrice) {
      case 'Open':   return candle.open;
      case 'High':   return candle.high;
      case 'Low':    return candle.low;
      case 'Volume': return candle.volume;
      case 'LTP':
      case 'Close':
      default:       return candle.close;
    }
  }
  return _indValue(cond.indicator, cond.paramA, cache, i, candle);
}

// ── Condition evaluator ───────────────────────────────────────────────────────

/**
 * Evaluate a single condition against the current bar.
 *
 * @param {object}  cond    - { indicator, op, valueA, valueB, rhsIsInd, paramA, paramB }
 * @param {object}  cache   - shared indicator cache
 * @param {number}  i       - current bar index
 * @param {object}  candle  - current OHLCV candle
 * @returns {boolean}
 */
function _evalCondition(rawCond, cache, i, candle) {
  const cond = _normCond(rawCond); // normalise snake_case → camelCase

  const lhs = _lhsValue(cond, cache, i, candle);
  if (lhs === null) return false;

  let rhs;
  if (cond.rhsIsInd) {
    rhs = _indValue(cond.valueB, cond.rhsPeriod, cache, i, candle);
    if (rhs === null) return false;
  } else {
    rhs = parseFloat(cond.valueA) || 0;
  }

  switch (cond.op) {
    case '>':             return lhs >  rhs;
    case '<':             return lhs <  rhs;
    case '>=':            return lhs >= rhs;
    case '<=':            return lhs <= rhs;
    case '==':            return Math.abs(lhs - rhs) < Math.max(0.001, Math.abs(rhs) * 0.001);
    case 'Crosses Above': {
      if (i === 0) return false;
      const prevCond = _normCond(rawCond);
      const prevLhs  = _lhsValue(prevCond, cache, i - 1, cache.candles[i - 1]);
      const prevRhs  = cond.rhsIsInd
        ? _indValue(cond.valueB, cond.rhsPeriod, cache, i - 1, cache.candles[i - 1])
        : rhs;
      if (prevLhs === null || prevRhs === null) return false;
      return prevLhs <= prevRhs && lhs > rhs;
    }
    case 'Crosses Below': {
      if (i === 0) return false;
      const prevCond2 = _normCond(rawCond);
      const prevLhs2  = _lhsValue(prevCond2, cache, i - 1, cache.candles[i - 1]);
      const prevRhs2  = cond.rhsIsInd
        ? _indValue(cond.valueB, cond.rhsPeriod, cache, i - 1, cache.candles[i - 1])
        : rhs;
      if (prevLhs2 === null || prevRhs2 === null) return false;
      return prevLhs2 >= prevRhs2 && lhs < rhs;
    }
    default: return false;
  }
}

/**
 * Evaluate a list of conditions at index i, respecting per-condition AND/OR gates.
 *
 * The logic chain works left-to-right:
 *   cond[0].logic connects cond[0] → cond[1]
 *   cond[1].logic connects cond[1] → cond[2]
 *   ...
 * The last condition's logic field is ignored.
 *
 * @param {object[]} conds
 * @param {object}   cache
 * @param {number}   i
 * @param {object}   candle
 * @returns {boolean}
 */
function _evalConditions(conds, cache, i, candle) {
  if (!conds || conds.length === 0) return true;

  let result = _evalCondition(conds[0], cache, i, candle);

  for (let c = 1; c < conds.length; c++) {
    const gate   = (conds[c - 1].logic || 'AND').toUpperCase();
    const thisOk = _evalCondition(conds[c], cache, i, candle);

    if (gate === 'OR') {
      result = result || thisOk;
    } else { // AND (default)
      result = result && thisOk;
    }
  }

  return result;
}

// ── Trade simulation ──────────────────────────────────────────────────────────

/**
 * Simulate a single trade over a range of candles.
 *
 * Options strategy (legs provided): estimates option premium via the simplified
 *   2%-of-spot model, walks forward bar by bar, exits on SL/target/time.
 *
 * Stock / no-legs strategy: simulates a directional equity trade.
 *   P&L = (exitPrice - entryClose) × shares  (BUY)
 *   P&L = (entryClose - exitPrice) × shares  (SELL/short)
 *   shares defaults to 1 if not provided — caller should pass shares from payload.
 *
 * @param {object}   params
 * @param {object[]} params.legs          - option leg objects (empty for stocks)
 * @param {string}   params.action        - 'BUY' | 'SELL' (for stocks)
 * @param {number}   params.shares        - number of shares (for stocks)
 * @param {number}   params.entryClose    - spot price at entry bar close
 * @param {number}   params.lotSize       - lot size for the underlying (options)
 * @param {number}   params.slPct         - stop-loss % (e.g. 3 for 3%)
 * @param {number}   params.tgtPct        - target % (e.g. 6 for 6%)
 * @param {object[]} params.futureCandles - remaining candles from entry bar+1
 * @returns {{ pnl: number, exitReason: string }}
 */
function _simulateTrade({ legs, action = 'BUY', shares = 1, entryClose, lotSize, slPct, tgtPct, futureCandles }) {
  const isOptions = legs && legs.length > 0;

  if (isOptions) {
    // ── Options: premium-based simulation ──────────────────────────────────
    let entryPremium = 0;
    for (const leg of legs) {
      const n   = leg.strike_n ?? leg.strikeN ?? 0;
      const qty = leg.quantity ?? leg.qty ?? 1;
      const atmPrem = entryClose * 0.02;
      const legPrem = atmPrem * Math.max(0.05, 1 - Math.abs(n) * 0.15);
      const sign    = leg.side === 'Buy' ? 1 : -1;
      entryPremium += sign * legPrem * qty * lotSize;
    }

    const absEntry = Math.abs(entryPremium);
    if (absEntry === 0) return { pnl: 0, exitReason: 'no_premium' };

    for (const c of futureCandles) {
      let currentPnl = 0;
      for (const leg of legs) {
        const n   = leg.strike_n ?? leg.strikeN ?? 0;
        const qty = leg.quantity ?? leg.qty ?? 1;
        const atmPrem = c.close * 0.02;
        const legPrem = atmPrem * Math.max(0.05, 1 - Math.abs(n) * 0.15);
        const sign    = leg.side === 'Buy' ? 1 : -1;
        currentPnl += sign * legPrem * qty * lotSize;
      }
      const mtmPnl = currentPnl - entryPremium;
      if (tgtPct > 0 && mtmPnl >= absEntry * tgtPct / 100) return { pnl: mtmPnl, exitReason: 'target' };
      if (slPct  > 0 && mtmPnl <= -(absEntry * slPct / 100))  return { pnl: mtmPnl, exitReason: 'stoploss' };
    }

    const lastChange = futureCandles.length > 0
      ? (futureCandles[futureCandles.length - 1].close - entryClose) / entryClose
      : 0;
    return { pnl: entryPremium * lastChange, exitReason: 'end_of_data' };

  } else {
    // ── Stocks / index futures: price-change simulation ─────────────────────
    const isBuy  = action.toUpperCase() !== 'SELL';
    const slAbs  = slPct  > 0 ? entryClose * (slPct  / 100) : Infinity;
    const tgtAbs = tgtPct > 0 ? entryClose * (tgtPct / 100) : Infinity;

    for (const c of futureCandles) {
      const priceDiff = c.close - entryClose;
      const move      = isBuy ? priceDiff : -priceDiff;

      if (move >=  tgtAbs) return { pnl:  tgtAbs * shares, exitReason: 'target' };
      if (move <= -slAbs)  return { pnl: -slAbs  * shares, exitReason: 'stoploss' };
    }

    // No exit hit — close at last candle price
    const lastClose = futureCandles.length > 0
      ? futureCandles[futureCandles.length - 1].close
      : entryClose;
    const finalMove = isBuy ? lastClose - entryClose : entryClose - lastClose;
    return { pnl: finalMove * shares, exitReason: 'end_of_data' };
  }
}

// ── Max indicator period helper ───────────────────────────────────────────────
// Scans all conditions and returns the largest period value so the warmup
// skips enough bars for every indicator to be fully initialised.
function _maxIndicatorPeriod(entryConds = [], exitConds = []) {
  let max = 20; // baseline
  const allConds = [...entryConds, ...exitConds];
  for (const rawCond of allConds) {
    const c = _normCond(rawCond);
    const a = parseInt(c.paramA)    || 0;
    const b = parseInt(c.paramB)    || 0;
    const r = parseInt(c.rhsPeriod) || 0;
    if (a > max) max = a;
    if (b > max) max = b;
    if (r > max) max = r;
    // MACD slow period default is 26 — if indicator is MACD and paramB empty, use 26
    if (c.indicator === 'MACD' && b === 0 && 26 > max) max = 26;
  }
  return max;
}

// ── Main backtest runner ──────────────────────────────────────────────────────

/**
 * Run a strategy backtest against real Angel One historical candle data.
 *
 * @param {object} params
 * @param {string}   params.underlying    - 'NIFTY' | 'BANKNIFTY' | etc.
 * @param {string}   params.timeframe     - Flutter tf string e.g. '5m', '15m', '1H'
 * @param {object[]} params.entryConds    - array of _Condition objects from Flutter
 * @param {object[]} [params.exitConds]   - optional exit conditions
 * @param {object[]} params.legs          - array of _Leg objects from Flutter
 * @param {string}   [params.slPct]       - stop-loss percent string (e.g. '50')
 * @param {string}   [params.tgtPct]      - target percent string (e.g. '100')
 *
 * @returns {Promise<{
 *   totalPnl: number,
 *   totalTrades: number,
 *   winTrades: number,
 *   maxDrawdown: number,
 *   winRate: number,
 *   equityCurve: number[],
 *   interval: string,
 *   candleCount: number,
 *   fromDate: string,
 *   toDate: string,
 *   source: 'angel_one'
 * }>}
 */
async function runBacktest(params) {
  const {
    underlying  = 'NIFTY',
    timeframe   = '15m',
    entryConds  = [],
    exitConds   = [],
    legs        = [],
    slPct       = '50',
    tgtPct      = '100',
    range       = '3 Months', // user-selected lookback period
    action      = 'BUY',      // stock direction: 'BUY' | 'SELL'
    shares      = 10,         // number of shares for stock backtests
  } = params;

  const interval = TF_MAP[timeframe] || 'FIFTEEN_MINUTE';
  const lotSize  = LOT_SIZES[underlying.toUpperCase()] ?? 50;
  const sl       = parseFloat(slPct)  || 50;
  const tgt      = parseFloat(tgtPct) || 100;

  // ── Fetch candles ──────────────────────────────────────────────────────────
  const candles = await _fetchCandles(underlying, interval, range);  if (candles.length < 50) {
    throw new Error(`Insufficient candle data: only ${candles.length} bars returned`);
  }

  // ── Build shared indicator cache ───────────────────────────────────────────
  const closes = candles.map(c => c.close);
  const cache  = { closes, candles }; // lazy: indicator arrays computed on first access

  // ── Warm-up period: skip the first N bars ─────────────────────────────────
  // Must cover the longest indicator period in the entry conditions so we
  // don't get null values on the first evaluated bar.
  // Daily strategies with EMA(50) need at least 50 bars of warmup.
  const maxPeriod = _maxIndicatorPeriod(entryConds, exitConds);
  const WARMUP    = Math.min(
    Math.floor(candles.length * 0.35),  // never burn more than 35% of data
    Math.max(maxPeriod + 5, 20)         // at least max-period + 5 buffer bars
  );

  // Guard: if warmup consumes too much data, abort with a clear message
  if (WARMUP >= candles.length - 10) {
    const needed = maxPeriod + 15;
    throw new Error(
      `Not enough candle data for this strategy. The longest indicator period ` +
      `is ${maxPeriod}, which needs at least ${needed} bars, but only ` +
      `${candles.length} were returned. Try a longer date range or higher timeframe.`
    );
  }

  // ── Trade simulation state ─────────────────────────────────────────────────
  let inTrade       = false;
  let entryBar      = -1;
  let entryClose    = 0;

  // Minimum bars to hold a trade before checking exit (avoids same-bar exit)
  const MIN_HOLD_BARS = interval === 'ONE_DAY' ? 1 : 3;

  const equityCurve  = [];
  let cumPnl         = 0;
  let peak           = 0;
  let maxDrawdown    = 0;
  let totalTrades    = 0;
  let winTrades      = 0;

  // ── Walk forward ──────────────────────────────────────────────────────────
  for (let i = WARMUP; i < candles.length; i++) {
    const candle = candles[i];

    if (!inTrade) {
      // Check entry conditions on bar close
      const entrySignal = _evalConditions(entryConds, cache, i, candle);
      if (entrySignal) {
        inTrade    = true;
        entryBar   = i;
        entryClose = candle.close;
      }
    } else {
      const barsHeld = i - entryBar;
      if (barsHeld < MIN_HOLD_BARS) continue;

      // Check explicit exit conditions first
      const exitSignal = exitConds.length > 0
        ? _evalConditions(exitConds, cache, i, candle)
        : false;

      // Check SL / target via trade simulation on the bars after entry
      const futureCandles = candles.slice(entryBar + 1, i + 1);
      const { pnl, exitReason } = _simulateTrade({
        legs, action, shares, entryClose, lotSize, slPct: sl, tgtPct: tgt, futureCandles,
      });

      const shouldExit =
        exitSignal ||
        exitReason === 'target' ||
        exitReason === 'stoploss' ||
        barsHeld >= _maxHoldBars(interval); // time-based exit

      if (shouldExit) {
        // Record trade
        inTrade = false;
        totalTrades++;
        if (pnl > 0) winTrades++;
        cumPnl += pnl;
        equityCurve.push(parseFloat(cumPnl.toFixed(2)));

        // Update max drawdown
        if (cumPnl > peak) peak = cumPnl;
        const dd = peak - cumPnl;
        if (dd > maxDrawdown) maxDrawdown = dd;
      }
    }
  }

  const winRate = totalTrades > 0 ? (winTrades / totalTrades) * 100 : 0;

  // Fill equity curve with at least 2 points so the Flutter chart can render
  if (equityCurve.length === 0) equityCurve.push(0, 0);
  if (equityCurve.length === 1) equityCurve.push(equityCurve[0]);

  const { fromdate, todate } = _dateRange(interval);

  console.log(
    `[Backtest] Done — ${totalTrades} trades, winRate=${winRate.toFixed(1)}%, ` +
    `PnL=₹${cumPnl.toFixed(0)}, maxDD=₹${maxDrawdown.toFixed(0)}`
  );

  return {
    totalPnl:    parseFloat(cumPnl.toFixed(2)),
    totalTrades,
    winTrades,
    maxDrawdown: parseFloat(maxDrawdown.toFixed(2)),
    winRate:     parseFloat(winRate.toFixed(2)),
    equityCurve,
    interval,
    candleCount: candles.length,
    fromDate:    fromdate,
    toDate:      todate,
    source:      'angel_one',
  };
}

// ── Time-based exit cap ───────────────────────────────────────────────────────

/**
 * Maximum bars to hold a position before forced exit.
 * Keeps the backtest realistic — we don't hold indefinitely.
 *
 * @param {string} interval
 * @returns {number}
 */
function _maxHoldBars(interval) {
  switch (interval) {
    case 'ONE_MINUTE':      return 30;   // ~30 min
    case 'THREE_MINUTE':    return 20;   // ~1 hour
    case 'FIVE_MINUTE':     return 18;   // ~1.5 hours
    case 'TEN_MINUTE':      return 12;   // ~2 hours
    case 'FIFTEEN_MINUTE':  return 10;   // ~2.5 hours
    case 'THIRTY_MINUTE':   return 8;    // ~4 hours
    case 'ONE_HOUR':        return 5;    // ~5 days
    case 'ONE_DAY':         return 20;   // ~1 month
    default:                return 10;
  }
}

module.exports = { runBacktest };
