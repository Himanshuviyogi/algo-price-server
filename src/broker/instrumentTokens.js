/**
 * Instrument token map for Angel One SmartAPI.
 *
 * Tokens are loaded from Firestore collection `instrument_tokens` at startup.
 * Each document has: { symbol, token, exchange, enabled }
 *
 * Fallback hardcoded map is used if Firestore is unavailable.
 *
 * To find tokens for new symbols:
 *   1. Download: https://margincalculator.angelone.in/OpenAPI_File/files/OpenAPIScripMaster.json
 *   2. Search for your symbol in the "name" field.
 *   3. Use the "token" value.
 */

const admin = require('firebase-admin');

// ── Hardcoded fallback (used if Firestore load fails) ─────────────────────────

const FALLBACK_TOKENS = {
  'RELIANCE':   { token: '2885',   exchange: 'NSE' },
  'TCS':        { token: '11536',  exchange: 'NSE' },
  'HDFCBANK':   { token: '1333',   exchange: 'NSE' },
  'INFY':       { token: '1594',   exchange: 'NSE' },
  'ICICIBANK':  { token: '4963',   exchange: 'NSE' },
  'SBIN':       { token: '3045',   exchange: 'NSE' },
  'BAJFINANCE': { token: '317',    exchange: 'NSE' },
  'WIPRO':      { token: '3787',   exchange: 'NSE' },
  'TATAMOTORS': { token: '3456',   exchange: 'NSE' },
  'AXISBANK':   { token: '5900',   exchange: 'NSE' },
  'KOTAKBANK':  { token: '1922',   exchange: 'NSE' },
  'LT':         { token: '11483',  exchange: 'NSE' },
  'HINDUNILVR': { token: '1394',   exchange: 'NSE' },
  'ASIANPAINT': { token: '236',    exchange: 'NSE' },
  'MARUTI':     { token: '10999',  exchange: 'NSE' },
  'SUNPHARMA':  { token: '3351',   exchange: 'NSE' },
  'TITAN':      { token: '3506',   exchange: 'NSE' },
  'ULTRACEMCO': { token: '11532',  exchange: 'NSE' },
  'NESTLEIND':  { token: '17963',  exchange: 'NSE' },
  'POWERGRID':  { token: '14977',  exchange: 'NSE' },
  'KPITTECH':   { token: '9683',   exchange: 'NSE' },
  'NIFTY':      { token: '26000',  exchange: 'NSE' },
  'BANKNIFTY':  { token: '26009',  exchange: 'NSE' },
  'SENSEX':     { token: '1',      exchange: 'BSE' },
  'GOLD':       { token: '459277', exchange: 'MCX' },
  'SILVER':     { token: '464150', exchange: 'MCX' },
  'CRUDEOIL':   { token: '488290', exchange: 'MCX' },
};

// ── Live token map (populated from Firestore) ─────────────────────────────────

let INSTRUMENT_TOKENS = { ...FALLBACK_TOKENS };

// Reverse map: token → symbol (rebuilt on every load)
let TOKEN_TO_SYMBOL = {};

function _buildReverseMap() {
  TOKEN_TO_SYMBOL = {};
  for (const [symbol, inst] of Object.entries(INSTRUMENT_TOKENS)) {
    TOKEN_TO_SYMBOL[inst.token] = symbol;
  }
}

_buildReverseMap();

/**
 * Load instrument tokens from Firestore.
 * Falls back to hardcoded map on error.
 */
async function loadFromFirestore() {
  try {
    const db = admin.firestore();
    const snap = await db
      .collection('instrument_tokens')
      .where('enabled', '==', true)
      .get();

    if (snap.empty) {
      console.log('[Tokens] Firestore collection empty — using fallback tokens.');
      INSTRUMENT_TOKENS = { ...FALLBACK_TOKENS };
    } else {
      const loaded = {};
      snap.docs.forEach(doc => {
        const { symbol, token, exchange } = doc.data();
        if (symbol && token && exchange) {
          loaded[symbol.toUpperCase()] = { token: String(token), exchange };
        }
      });
      INSTRUMENT_TOKENS = loaded;
      console.log(`[Tokens] Loaded ${Object.keys(loaded).length} symbols from Firestore.`);
    }

    _buildReverseMap();
    return INSTRUMENT_TOKENS;
  } catch (err) {
    console.error('[Tokens] Firestore load failed, using fallback:', err.message);
    INSTRUMENT_TOKENS = { ...FALLBACK_TOKENS };
    _buildReverseMap();
    return INSTRUMENT_TOKENS;
  }
}

/**
 * Returns the Angel One instrument token for a given symbol.
 */
function getInstrument(symbol) {
  return INSTRUMENT_TOKENS[symbol.toUpperCase()] || null;
}

/**
 * Returns all currently configured symbols.
 */
function getAllSymbols() {
  return Object.keys(INSTRUMENT_TOKENS);
}

/**
 * Returns the token → symbol reverse map.
 */
function getTokenToSymbolMap() {
  return TOKEN_TO_SYMBOL;
}

/**
 * Returns the subscription list format required by Angel One WebSocket.
 */
function toSubscriptionList(symbols) {
  return symbols
    .map(s => {
      const inst = getInstrument(s);
      if (!inst) return null;
      return { exchangeType: exchangeCode(inst.exchange), tokens: [inst.token] };
    })
    .filter(Boolean);
}

function exchangeCode(exchange) {
  const codes = { NSE: 1, NFO: 2, BSE: 3, BFO: 4, MCX: 5, NCDEX: 7, CDS: 13 };
  return codes[exchange] || 1;
}

module.exports = {
  getInstrument,
  getAllSymbols,
  toSubscriptionList,
  loadFromFirestore,
  getTokenToSymbolMap,
  get INSTRUMENT_TOKENS() { return INSTRUMENT_TOKENS; },
};
