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

const axios    = require('axios');
const config   = require('../config');
const angelOne = require('./angelOne');

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
 * Returns { fromdate, todate } strings in "YYYY-MM-DD HH:MM" IST format.
 *
 * Angel One maximum candle limits per interval:
 *   ONE_MINUTE       → max 30 days
 *   THREE_MINUTE     → max 60 days
 *   FIVE_MINUTE      → max 100 days
 *   FIFTEEN_MINUTE   → max 200 days
 *   ONE_HOUR / ONE_DAY → max 2 years
 *
 * We cap at 180 calendar days (~6 months) for intraday intervals to keep
 * response sizes manageable and stay within Angel One's limits.
 *
 * @param {string} interval - Angel One interval string
 * @returns {{ fromdate: string, todate: string }}
 */
function _dateRange(interval) {
  const now  = new Date();
  const from = new Date(now);

  switch (interval) {
    case 'ONE_MINUTE':
      from.setDate(from.getDate() - 25);    // stay under 30-day cap
      break;
    case 'THREE_MINUTE':
      from.setDate(from.getDate() - 55);
      break;
    case 'FIVE_MINUTE':
    case 'TEN_MINUTE':
      from.setDate(from.getDate() - 90);
      break;
    case 'FIFTEEN_MINUTE':
    case 'THIRTY_MINUTE':
      from.setDate(from.getDate() - 180);
      break;
    case 'ONE_HOUR':
    case 'ONE_DAY':
    default:
      from.setFullYear(from.getFullYear() - 1); // 1 year for daily/hourly
      break;
  }

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
async function _fetchCandles(underlying, interval) {
  const inst = INDEX_TOKENS[underlying.toUpperCase()];
  if (!inst) {
    throw new Error(`Unknown underlying "${underlying}". Supported: ${Object.keys(INDEX_TOKENS).join(', ')}`);
  }

  // Ensure we have an auth token — try server's own session first
  let authToken = angelOne.getAuthToken();
  if (!authToken) {
    console.log('[Backtest] No active auth token — logging in...');
    const session = await angelOne.login();
    authToken = session.authToken;
  }

  const { fromdate, todate } = _dateRange(interval);

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
    case 'Volume':
      return candle.volume;
    case 'Option Premium':
      // Approximate ATM call premium as ~2% of close (simplified — real impl
      // would fetch option chain data, but that requires live data per bar)
      return candle.close * 0.02;
    case 'OI':
    case 'PCR':
    case 'IV / IV Rank':
    case 'MACD':
    case 'ADX':
    case 'ATR':
    case 'Bollinger Bands':
    case 'Stochastic':
      // These indicators are not available in OHLCV-only candle data from Angel One.
      // Return a neutral value (50) so they don't block the entry signal.
      // A production implementation would compute them or pull from a data vendor.
      return 50;
    default:
      return null;
  }
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
function _evalCondition(cond, cache, i, candle) {
  const lhs = _indValue(cond.indicator, cond.paramA || '14', cache, i, candle);
  if (lhs === null) return false; // indicator not warmed up yet

  // RHS: either another indicator value or a literal numeric threshold
  let rhs;
  if (cond.rhs_is_indicator || cond.rhsIsInd) {
    rhs = _indValue(cond.value_b || cond.valueB || '', cond.paramB || '14', cache, i, candle);
    if (rhs === null) return false;
  } else {
    rhs = parseFloat(cond.value_a || cond.valueA || '0') || 0;
  }

  switch (cond.op || cond.operator) {
    case '>':             return lhs >  rhs;
    case '<':             return lhs <  rhs;
    case '>=':            return lhs >= rhs;
    case '<=':            return lhs <= rhs;
    case '==':            return Math.abs(lhs - rhs) < rhs * 0.001; // ~0.1% tolerance
    case 'Crosses Above': {
      // True when lhs crossed above rhs on this bar (was below on previous bar)
      const prevLhs = _indValue(cond.indicator, cond.paramA || '14', cache, i - 1, cache.candles[i - 1]);
      const prevRhs = cond.rhs_is_indicator || cond.rhsIsInd
        ? _indValue(cond.value_b || cond.valueB || '', cond.paramB || '14', cache, i - 1, cache.candles[i - 1])
        : rhs;
      if (prevLhs === null || prevRhs === null) return false;
      return prevLhs <= prevRhs && lhs > rhs;
    }
    case 'Crosses Below': {
      const prevLhs2 = _indValue(cond.indicator, cond.paramA || '14', cache, i - 1, cache.candles[i - 1]);
      const prevRhs2 = cond.rhs_is_indicator || cond.rhsIsInd
        ? _indValue(cond.value_b || cond.valueB || '', cond.paramB || '14', cache, i - 1, cache.candles[i - 1])
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
 * Simulate a single options strategy trade over a range of candles.
 *
 * For each strategy leg the approximate option premium is estimated as:
 *   ATM premium ≈ 2% of spot × (1 + |strikeN| × 0.15)
 * This is a simplified model. A production system would query the option
 * chain at entry time to get the real premium.
 *
 * @param {object}   params
 * @param {object[]} params.legs          - array of _Leg objects from Flutter
 * @param {number}   params.entryClose    - spot price at entry bar close
 * @param {number}   params.lotSize       - lot size for the underlying
 * @param {number}   params.slPct         - stop-loss % (e.g. 50 for 50%)
 * @param {number}   params.tgtPct        - target % (e.g. 100 for 100%)
 * @param {object[]} params.futureCandles - remaining candles from entry bar+1
 * @returns {{ pnl: number, exitReason: string }}
 */
function _simulateTrade({ legs, entryClose, lotSize, slPct, tgtPct, futureCandles }) {
  // Compute combined net premium at entry
  let entryPremium = 0;
  for (const leg of legs) {
    const n = leg.strike_n ?? leg.strikeN ?? 0;
    const qty = leg.quantity ?? leg.qty ?? 1;
    // Approximate ATM premium ≈ 2% of spot; each strike away reduces by 15%
    const atmPrem = entryClose * 0.02;
    const legPrem = atmPrem * Math.max(0.05, 1 - Math.abs(n) * 0.15);
    const sign    = leg.side === 'Buy' ? 1 : -1;
    entryPremium += sign * legPrem * qty * lotSize;
  }

  // entryPremium > 0 → we paid a net debit (buy dominant)
  // entryPremium < 0 → we received a net credit (sell dominant)
  const absEntry = Math.abs(entryPremium);
  if (absEntry === 0) return { pnl: 0, exitReason: 'no_premium' };

  const slLevel  = slPct  > 0 ? entryPremium - (absEntry * slPct  / 100) : -Infinity;
  const tgtLevel = tgtPct > 0 ? entryPremium + (absEntry * tgtPct / 100) :  Infinity;

  // Walk forward candle by candle, updating estimated premium based on spot change
  for (const c of futureCandles) {
    const spotChange = (c.close - entryClose) / entryClose; // fractional

    let currentPnl = 0;
    for (const leg of legs) {
      const n   = leg.strike_n ?? leg.strikeN ?? 0;
      const qty = leg.quantity ?? leg.qty ?? 1;
      const atmPrem    = c.close * 0.02;
      const legPrem    = atmPrem * Math.max(0.05, 1 - Math.abs(n) * 0.15);
      const sign       = leg.side === 'Buy' ? 1 : -1;
      currentPnl += sign * legPrem * qty * lotSize;
    }

    const mtmPnl = currentPnl - entryPremium;

    if (tgtPct > 0 && mtmPnl >= absEntry * tgtPct / 100) {
      return { pnl: mtmPnl, exitReason: 'target' };
    }
    if (slPct > 0 && mtmPnl <= -(absEntry * slPct / 100)) {
      return { pnl: mtmPnl, exitReason: 'stoploss' };
    }
  }

  // No SL/target hit → exit at last candle
  const lastSpotChange = futureCandles.length > 0
    ? (futureCandles[futureCandles.length - 1].close - entryClose) / entryClose
    : 0;

  const exitPnl = entryPremium * lastSpotChange;
  return { pnl: exitPnl, exitReason: 'end_of_data' };
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
  } = params;

  const interval = TF_MAP[timeframe] || 'FIFTEEN_MINUTE';
  const lotSize  = LOT_SIZES[underlying.toUpperCase()] ?? 50;
  const sl       = parseFloat(slPct)  || 50;
  const tgt      = parseFloat(tgtPct) || 100;

  // ── Fetch candles ──────────────────────────────────────────────────────────
  const candles = await _fetchCandles(underlying, interval);

  if (candles.length < 50) {
    throw new Error(`Insufficient candle data: only ${candles.length} bars returned`);
  }

  // ── Build shared indicator cache ───────────────────────────────────────────
  const closes = candles.map(c => c.close);
  const cache  = { closes, candles }; // lazy: indicator arrays computed on first access

  // ── Warm-up period: skip the first N bars ─────────────────────────────────
  // 200 is a safe upper bound for any indicator period used in conditions.
  // This avoids false signals before indicators are warmed up.
  const WARMUP = Math.min(200, Math.floor(candles.length * 0.15));

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
        legs, entryClose, lotSize, slPct: sl, tgtPct: tgt, futureCandles,
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
