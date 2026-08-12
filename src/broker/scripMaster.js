/**
 * Angel One ScripMaster — auto token lookup
 *
 * Downloads the full instrument list from Angel One daily.
 * Used to resolve symbol names → tokens without manual entry.
 *
 * URL: https://margincalculator.angelone.in/OpenAPI_File/files/OpenAPIScripMaster.json
 */

const axios = require('axios');

const SCRIP_MASTER_URL =
  'https://margincalculator.angelone.in/OpenAPI_File/files/OpenAPIScripMaster.json';

let _cache = null;
let _cacheDate = null;

/**
 * Load ScripMaster (cached for 24h).
 * @returns {Promise<Array>} full instrument list
 */
async function loadScripMaster() {
  const today = new Date().toISOString().slice(0, 10);
  if (_cache && _cacheDate === today) return _cache;

  console.log('[ScripMaster] Downloading instrument list...');
  const res = await axios.get(SCRIP_MASTER_URL, { timeout: 30_000 });
  _cache = res.data;
  _cacheDate = today;
  console.log(`[ScripMaster] Loaded ${_cache.length} instruments.`);
  return _cache;
}

/**
 * Search for instruments matching a query.
 * @param {string} query - symbol name or partial name
 * @param {object} options
 * @param {string} [options.exchange] - 'NSE'|'BSE'|'NFO'|'MCX'|'BFO'
 * @param {string} [options.instrumentType] - 'EQ'|'OPTIDX'|'OPTSTK'|'FUTIDX'|'FUTSTK'|'FUTCOM'|'OPTFUT'
 * @param {number} [options.limit=20]
 * @returns {Promise<Array>}
 */
async function searchInstruments(query, options = {}) {
  const data = await loadScripMaster();
  const q = query.toUpperCase().trim();
  const { exchange, instrumentType, limit = 500 } = options;

  const filtered = data.filter(item => {
    if (!item.symbol && !item.name) return false;
    const sym  = (item.symbol || '').toUpperCase();
    const name = (item.name   || '').toUpperCase();
    if (!sym.includes(q) && !name.includes(q)) return false;
    if (exchange       && item.exch_seg       !== exchange)       return false;
    if (instrumentType && item.instrumenttype !== instrumentType) return false;
    return true;
  });

  // For F&O instruments sort by nearest expiry first, then by strike price.
  // Without this, contracts deep in the file (e.g. a specific weekly strike)
  // would be silently cut off by the limit slice.
  const isFno = instrumentType &&
    (instrumentType.startsWith('OPT') || instrumentType.startsWith('FUT'));

  if (isFno || filtered.some(i => i.expiry)) {
    filtered.sort((a, b) => {
      const expA = parseExpiry(a.expiry) ?? Infinity;
      const expB = parseExpiry(b.expiry) ?? Infinity;
      if (expA !== expB) return expA - expB;                        // nearest expiry first
      const strikeA = a.strike ? Number(a.strike) : 0;
      const strikeB = b.strike ? Number(b.strike) : 0;
      return strikeA - strikeB;                                     // lower strike first
    });
  }

  return filtered
    .slice(0, limit)
    .map(item => ({
      token:          item.token,
      symbol:         item.symbol,
      name:           item.name,
      exchange:       item.exch_seg,
      instrumentType: item.instrumenttype,
      expiry:         item.expiry || null,
      strike:         item.strike ? Number(item.strike) / 100 : null,
      lotSize:        item.lotsize ? Number(item.lotsize) : null,
    }));
}

/**
 * Find the exact token for a symbol on a given exchange.
 * @param {string} symbol - exact symbol string e.g. 'NIFTY29MAY2523500CE'
 * @param {string} exchange - 'NFO'|'NSE'|'MCX' etc.
 * @returns {Promise<string|null>} token or null
 */
async function findToken(symbol, exchange) {
  const data = await loadScripMaster();
  const sym = symbol.toUpperCase();
  const item = data.find(
    d => d.symbol && d.symbol.toUpperCase() === sym && d.exch_seg === exchange
  );
  return item ? item.token : null;
}

/**
 * Get all active weekly/monthly F&O contracts for an underlying.
 * @param {string} underlying - e.g. 'NIFTY', 'BANKNIFTY'
 * @param {string} instrumentType - 'OPTIDX'|'FUTIDX'|'OPTSTK'|'FUTSTK'
 * @param {number} [limit=50]
 */
async function getFnoContracts(underlying, instrumentType, limit = 50) {
  const data = await loadScripMaster();
  const ul = underlying.toUpperCase();
  const now = Date.now();

  return data
    .filter(item => {
      if (item.instrumenttype !== instrumentType) return false;
      if (!(item.name || '').toUpperCase().startsWith(ul)) return false;
      // Only future/near-term expiries
      if (item.expiry) {
        const exp = parseExpiry(item.expiry);
        if (exp && exp < now) return false; // skip expired
      }
      return true;
    })
    .slice(0, limit)
    .map(item => ({
      token:          item.token,
      symbol:         item.symbol,
      name:           item.name,
      exchange:       item.exch_seg,
      instrumentType: item.instrumenttype,
      expiry:         item.expiry || null,
      strike:         item.strike ? Number(item.strike) / 100 : null,
      lotSize:        item.lotsize ? Number(item.lotsize) : null,
    }));
}

function parseExpiry(expStr) {
  if (!expStr) return null;
  try {
    // Format: "29MAY2025" or "2025-05-29"
    if (expStr.includes('-')) return new Date(expStr).getTime();
    const months = { JAN:0,FEB:1,MAR:2,APR:3,MAY:4,JUN:5,JUL:6,AUG:7,SEP:8,OCT:9,NOV:10,DEC:11 };
    const day  = parseInt(expStr.slice(0, 2));
    const mon  = months[expStr.slice(2, 5)];
    const year = parseInt(expStr.slice(5));
    return new Date(year, mon, day).getTime();
  } catch { return null; }
}

module.exports = { loadScripMaster, searchInstruments, findToken, getFnoContracts };
