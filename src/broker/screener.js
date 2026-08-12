/**
 * Stockara Screener Engine
 * ─────────────────────────
 * Uses Angel One SmartAPI quote endpoint to fetch OHLC + 52W data for
 * all NIFTY 500 constituents, then computes screener filters.
 *
 * Why Angel One instead of NSE directly:
 *   - NSE blocks all server/datacenter IPs (403 on both bhavcopy and API)
 *   - Angel One is an authenticated REST API, never IP-blocked
 *   - ScripMaster already gives us all NSE EQ tokens for NIFTY 500
 *
 * Angel One quote API limits:
 *   - Max 50 tokens per request
 *   - Rate limit: 1 req/sec (enforced by 1100ms delay between batches)
 *
 * For 500 stocks: ceil(500/50) = 10 batches × ~1.5s = ~15s total.
 * Runs once daily at 5:30 PM IST — totally fine.
 */

const axios          = require('axios');
const speakeasy      = require('speakeasy');
const { loadScripMaster } = require('./scripMaster');

// ── NIFTY 500 constituent symbols ─────────────────────────────────────────────
// Source: NSE index composition (updated infrequently — quarterly rebalancing)
// These are the NSE equity symbols for all NIFTY 500 stocks.
// We resolve them to Angel One tokens via ScripMaster at runtime.

const NIFTY_500_SYMBOLS = [
  'RELIANCE','TCS','HDFCBANK','BHARTIARTL','ICICIBANK','INFOSYS','SBIN','HINDUNILVR',
  'ITC','LT','KOTAKBANK','BAJFINANCE','AXISBANK','ASIANPAINT','MARUTI','TITAN',
  'SUNPHARMA','ULTRACEMCO','NESTLEIND','WIPRO','ONGC','NTPC','POWERGRID','COALINDIA',
  'M&M','HCLTECH','BAJAJFINSV','ADANIENT','ADANIPORTS','JSWSTEEL','TATAMOTORS',
  'TECHM','HDFCLIFE','SBILIFE','DRREDDY','CIPLA','GRASIM','DIVISLAB','EICHERMOT',
  'INDUSINDBK','TATACONSUM','APOLLOHOSP','BPCL','HINDALCO','BRITANIA','HEROMOTOCO',
  'VEDL','SHREECEM','UPL','BAJAJ-AUTO','ICICIGI','DABUR','PIDILITIND','BERGEPAINT',
  'MARICO','GODREJCP','COLPAL','LUPIN','MUTHOOTFIN','TORNTPHARM','BIOCON','ALKEM',
  'TATAPOWER','AMBUJACEM','ACC','IDFCFIRSTB','FEDERALBNK','INDUSTOWER','BANKBARODA',
  'CANBK','PNB','INDIANB','UNIONBANK','IOC','HINDPETRO','CASTROLIND','MRPL',
  'SAIL','NMDC','IRCTC','HAL','BEL','BHEL','RVNL','IRFC','RECLTD','PFC',
  'HUDCO','NBCC','NHPC','SJVN','TATAELXSI','MPHASIS','COFORGE','LTTS','PERSISTENT',
  'KPITTECH','ZOMATO','PAYTM','NYKAA','DELHIVERY','CARTRADE','POLICYBZR',
  'TATASTEEL','JSPL','HINDZINC','NATIONALUM','WELCORP','APLAPOLLO','RATNAMANI',
  'PIIND','COROMANDEL','CHAMBAL','RALLIS','DEEPAKNITR','AARTIIND','NAVINFLUOR',
  'JUBLFOOD','WESTLIFE','DEVYANI','BARBEQUE','SAPPHIRE','RESTAUR','SPECIALITY',
  'BATAINDIA','PAGEIND','ABFRL','ARVIND','RAYMOND','TRENT','VMART','SHOPRITE',
  'DMART','NAUKRI','JUSTDIAL','INDIAMART','AFFLE','ZEXUS','ROUTE','TEAMLEASE',
  'MCDOWELL-N','UNITEDSPRT','RADICO','TILAKNAGAR','GLOBUSSPR','SMLISUZU',
  'SWANENERGY','AEGISLOG','CESC','TORNTPOWER','ADANITRANS','ADANIGREEN','ADANIPOWER',
  'TATACOMM','MTNL','HFCL','STLTECH','TEJAS','RAILTEL','IRCON','KEC','KALPATPOWR',
  'ENGINERSIN','GRINDWELL','TIMKEN','SKF','SCHAEFFLER','CUMMINSIND','THERMAX',
  'VOLTAS','BLUESTAR','HAVELLS','POLYCAB','KTKBANK','DCBBANK','RBLBANK','YESBANK',
  'IDBI','LICHOUSING','CANFINHOME','GRUH','PNBHOUSING','REPCO','AAVAS','HOMEFIRST',
  'APTUS','MANAPPURAM','CHOLAFIN','SUNDARMFIN','M&MFIN','MAHINDCIE','AUBANK',
  'EQUITASBNK','UTKARSHBANK','SURYODAY','ESAFSFB','UJJIVANSFB','CREDITACC',
  'SPANDANA','AROHAN','ASIANLPG','AEGISCHEM','DEEPAKFERT','GNFC','GSFC','RCF',
  'FACT','ZUARIIND','TATACHEM','GHCL','APCOTEXIND','BASF','NOCIL','CASTROL',
  'BALRAMCHIN','DHANUKA','JUBLPHARMA','PFIZER','GLAXO','ABBOTINDIA','ASTRAZEN',
  'SANOFI','IPCALAB','GRANULES','LALPATHLAB','METROPOLIS','THYROCARE','VIJAYA',
  'KRBL','LT','GODREJIND','GODREJPROP','SOBHA','BRIGADE','PRESTIGE','OBEROIRLTY',
  'PHOENIXLTD','MAHLIFE','SUNTV','ZEEL','PVR','INOX','SAREGAMA','TIPS','BALAJITELE',
  'MTARTECH','IDEAFORGE','PARAS','NETWEB','RATEGAIN','XCHANGING','HAPPSTMNDS',
  'INTELLECT','SONATSOFTW','MASTEK','NIIT','TANLA','GTLINFRA','INDIAMART',
  'LATENTVIEW','DATAMATICS','KFINTECH','CAMS','CDSL','BSE','MCX','NSDL',
  'ICICIGI','HDFCAMC','NIPPONIND','ABSL','UTI','SUNDARMFIN','SHRIRAMEPC',
  'CHOLAHLDNG','BAJHLDNGS','BAJAJHLDNG','M&MFIN','BHARTIFORG','RIIL','RPOWER',
  'ADANIGAS','MAHANAGAR','GUJGAS','IGL','MGL','PETRONET','GAIL','GSPL',
  'TPLPLASTEH','SUPREMEIND','ASTRAL','FINOLEX','JYOTHYLAB','EMAMILTD','VBL',
  'VAIBHAVGBL','BATAINDIA','MCDOWELL-N','HINDWAREAP','CROMPTON','BAJAJCON',
  'WHIRLPOOL','TTK','PGHH','GILLETTE','HONAUT','BOSCHLTD','MOTHERSON',
  'SUPRAJIT','ENDURANCE','SUNDRMFAST','BALKRISIND','MRF','APOLLOTYRE','CEATLTD',
  'JKTYRE','TVSSRICHAK','ACCELYA','TATAELXSI','NEWGEN','ZENSAR','BIRLASOFT',
  'CYIENT','KPIGREEN','SOLARINDS','TDPOWER','SUZLON','INOXWIND','GREENPANEL',
  'CENTURYPLY','GREENLAM','ACTION','RELAXO','CAMPUS','METRO','LIBERTY',
];

// ── Auth token management ─────────────────────────────────────────────────────

let _authToken   = null;
let _tokenExpiry = 0;
const config     = require('../config');

async function getAuthToken() {
  if (_authToken && Date.now() < _tokenExpiry) return _authToken;

  const totp = speakeasy.totp({ secret: config.angel.totpSecret, encoding: 'base32' });
  const res  = await axios.post(
    'https://apiconnect.angelone.in/rest/auth/angelbroking/user/v1/loginByPassword',
    { clientcode: config.angel.clientId, password: config.angel.password, totp },
    {
      headers: {
        'Content-Type':  'application/json',
        'Accept':        'application/json',
        'X-UserType':    'USER',
        'X-SourceID':    'WEB',
        'X-ClientLocalIP':  '127.0.0.1',
        'X-ClientPublicIP': '127.0.0.1',
        'X-MACAddress':  '00:00:00:00:00:00',
        'X-PrivateKey':  config.angel.apiKey,
      },
    }
  );

  if (res.data?.status !== true) throw new Error('Angel One login failed for screener');
  _authToken   = res.data.data.jwtToken;
  _tokenExpiry = Date.now() + 6 * 60 * 60 * 1000; // 6h TTL
  console.log('[Screener] Angel One auth obtained.');
  return _authToken;
}

// ── Resolve symbols → tokens ──────────────────────────────────────────────────

async function resolveNifty500Tokens() {
  const scripMaster = await loadScripMaster();
  const tokenMap    = []; // [ { token, symbol, name } ]

  // Debug: log a sample entry to understand the field structure
  const sampleNse = scripMaster.find(s => s.exch_seg === 'NSE');
  if (sampleNse) {
    console.log(`[Screener] Sample NSE entry: symbol=${sampleNse.symbol} instrumenttype=${sampleNse.instrumenttype} exch_seg=${sampleNse.exch_seg}`);
  }

  // Build a fast lookup map: name → entry (NSE equity only)
  // Angel One ScripMaster:
  //   - exch_seg = 'NSE' for NSE stocks
  //   - instrumenttype = '' (empty) for equities
  //   - symbol = 'RELIANCE-EQ' (appends -EQ, -BE etc)
  //   - name = 'RELIANCE' (clean name — use this for matching)
  const nseEqByName = {};  // name → entry
  const nseEqBySymbol = {}; // symbol stripped of suffix → entry

  for (const s of scripMaster) {
    if (s.exch_seg === 'NSE' && s.instrumenttype === '') {
      // Index by clean name
      if (s.name) nseEqByName[s.name.toUpperCase()] = s;
      // Index by symbol with -EQ/-BE suffix stripped
      if (s.symbol) {
        const stripped = s.symbol.replace(/-(EQ|BE|SM|ST|BZ|IL)$/, '');
        nseEqBySymbol[stripped.toUpperCase()] = s;
      }
    }
  }
  console.log(`[Screener] NSE EQ symbols in ScripMaster: ${Object.keys(nseEqByName).length}`);

  for (const sym of NIFTY_500_SYMBOLS) {
    // Try by name first (most reliable), then by stripped symbol
    const entry = nseEqByName[sym.toUpperCase()]
               ?? nseEqBySymbol[sym.toUpperCase()];
    if (entry) {
      tokenMap.push({ token: entry.token, symbol: sym, name: entry.name || sym });
    }
  }

  console.log(`[Screener] Resolved ${tokenMap.length}/${NIFTY_500_SYMBOLS.length} NIFTY500 tokens`);
  return tokenMap;
}

// ── Quote fetch via Angel One REST ────────────────────────────────────────────
// Fetches OHLC + 52W high/low for a batch of max 50 tokens.

async function fetchQuoteBatch(tokens, authToken) {
  // Angel One quote API: exchange 1 = NSE
  const res = await axios.post(
    'https://apiconnect.angelone.in/rest/secure/angelbroking/market/v1/quote/',
    {
      mode:      'FULL',
      exchangeTokens: { NSE: tokens },
    },
    {
      headers: {
        'Content-Type':  'application/json',
        'Accept':        'application/json',
        'Authorization': `Bearer ${authToken}`,
        'X-UserType':    'USER',
        'X-SourceID':    'WEB',
        'X-ClientLocalIP':  '127.0.0.1',
        'X-ClientPublicIP': '127.0.0.1',
        'X-MACAddress':  '00:00:00:00:00:00',
        'X-PrivateKey':  config.angel.apiKey,
      },
    }
  );

  // Response: { status: true, data: { fetched: [...], unfetched: [...] } }
  return (res.data?.data?.fetched) ?? [];
}

// ── Main screener computation ─────────────────────────────────────────────────

/**
 * Fetch quotes for all NIFTY 500 stocks and compute screener buckets.
 * Returns an object keyed by screener ID.
 */
async function computeScreeners() {
  const authToken  = await getAuthToken();
  const tokenMap   = await resolveNifty500Tokens();

  if (tokenMap.length === 0) throw new Error('No tokens resolved from ScripMaster');
  if (tokenMap.length < 20) {
    console.warn(`[Screener] Only ${tokenMap.length} tokens resolved — ScripMaster may be stale or symbols mismatched`);
  }

  const allTokens = tokenMap.map(t => t.token);
  const allQuotes = [];

  // Batch in groups of 50 with 1.1s delay to respect Angel One rate limit
  for (let i = 0; i < allTokens.length; i += 50) {
    const batch = allTokens.slice(i, i + 50);
    try {
      const quotes = await fetchQuoteBatch(batch, authToken);
      allQuotes.push(...quotes);
    } catch (err) {
      console.warn(`[Screener] Batch ${i}-${i+50} failed: ${err.message}`);
    }
    if (i + 50 < allTokens.length) {
      await new Promise(r => setTimeout(r, 1100)); // 1.1s between batches
    }
  }

  console.log(`[Screener] Fetched ${allQuotes.length} quotes from Angel One`);
  if (allQuotes.length < 50) throw new Error(`Too few quotes: ${allQuotes.length}`);

  // Build a token → symbol map for name resolution
  const tokenToInfo = {};
  for (const t of tokenMap) tokenToInfo[t.token] = t;

  // Normalize quotes into screener rows
  const rows = allQuotes.map(q => {
    const info      = tokenToInfo[q.symbolToken] || {};
    const close     = parseFloat(q.ltp     ?? 0);
    const prevClose = parseFloat(q.close   ?? 0); // Angel One 'close' = prev day close
    const high52    = parseFloat(q.weekHighYear  ?? q['52WeekHigh'] ?? 0);
    const low52     = parseFloat(q.weekLowYear   ?? q['52WeekLow']  ?? 0);
    const upperCP   = parseFloat(q.upperCircuit  ?? 0);
    const lowerCP   = parseFloat(q.lowerCircuit  ?? 0);
    const volume    = parseInt(q.tradeVolume ?? q.tradedVolume ?? 0, 10) || 0;
    const netChange = prevClose > 0 ? close - prevClose : 0;
    const pctChange = prevClose > 0 ? (netChange / prevClose) * 100 : 0;

    return {
      symbol:       info.symbol || q.tradingSymbol || '',
      name:         info.name   || q.symbolName    || '',
      close,
      prevClose,
      pctChange:    parseFloat(pctChange.toFixed(2)),
      netChange:    parseFloat(netChange.toFixed(2)),
      volume,
      high52,
      low52,
      upperCircuit: upperCP,
      lowerCircuit: lowerCP,
    };
  }).filter(r => r.symbol && r.close > 0 && r.prevClose > 0);

  // ── Screener definitions ───────────────────────────────────────────────────

  const screeners = [
    {
      id:    '52w_high_breakout',
      label: '52-Week High Breakout',
      emoji: '🚀',
      color: 'green',
      filter: r => r.high52 > 0 && r.close >= r.high52 * 0.99 && r.pctChange > 0,
      sort:   (a, b) => b.pctChange - a.pctChange,
    },
    {
      id:    'near_52w_high',
      label: 'Near 52-Week High',
      emoji: '📈',
      color: 'teal',
      filter: r => r.high52 > 0 && r.close >= r.high52 * 0.95 && r.close < r.high52 * 0.99,
      sort:   (a, b) => (b.close / b.high52) - (a.close / a.high52),
    },
    {
      id:    '52w_low',
      label: '52-Week Low',
      emoji: '📉',
      color: 'red',
      filter: r => r.low52 > 0 && r.close <= r.low52 * 1.01,
      sort:   (a, b) => a.pctChange - b.pctChange,
    },
    {
      id:    'strong_gainers',
      label: 'Strong Gainers (≥5%)',
      emoji: '💹',
      color: 'green',
      filter: r => r.pctChange >= 5,
      sort:   (a, b) => b.pctChange - a.pctChange,
    },
    {
      id:    'strong_losers',
      label: 'Strong Losers (≤-5%)',
      emoji: '🔻',
      color: 'red',
      filter: r => r.pctChange <= -5,
      sort:   (a, b) => a.pctChange - b.pctChange,
    },
    {
      id:    'upper_circuit',
      label: 'Upper Circuit',
      emoji: '⚡',
      color: 'amber',
      filter: r => r.upperCircuit > 0 && Math.abs(r.close - r.upperCircuit) < 0.02,
      sort:   (a, b) => b.pctChange - a.pctChange,
    },
    {
      id:    'lower_circuit',
      label: 'Lower Circuit',
      emoji: '🔴',
      color: 'orange',
      filter: r => r.lowerCircuit > 0 && Math.abs(r.close - r.lowerCircuit) < 0.02,
      sort:   (a, b) => a.pctChange - b.pctChange,
    },
    {
      id:    'daily_breakout',
      label: 'Daily Fresh Breakout',
      emoji: '🔥',
      color: 'indigo',
      filter: r => r.high52 > 0 && r.close >= r.high52 * 0.995 && r.pctChange > 0,
      sort:   (a, b) => b.pctChange - a.pctChange,
    },
    {
      id:    'nearing_breakout',
      label: 'Nearing Breakout',
      emoji: '🎯',
      color: 'purple',
      filter: r => r.high52 > 0 && r.close >= r.high52 * 0.97 && r.close < r.high52 * 0.995,
      sort:   (a, b) => (b.close / b.high52) - (a.close / a.high52),
    },
  ];

  const results = {};
  for (const s of screeners) {
    const matched = rows
      .filter(s.filter)
      .sort(s.sort)
      .slice(0, 100)
      .map(r => ({
        symbol:    r.symbol,
        name:      r.name,
        close:     r.close,
        pctChange: r.pctChange,
        netChange: r.netChange,
        volume:    r.volume,
        high52:    r.high52,
        low52:     r.low52,
      }));

    results[s.id] = {
      id:     s.id,
      label:  s.label,
      emoji:  s.emoji,
      color:  s.color,
      stocks: matched,
      count:  matched.length,
    };
    console.log(`[Screener] ${s.label}: ${matched.length} stocks`);
  }

  // Also compute top 20 gainers/losers for market_data
  const gainers = [...rows]
    .sort((a, b) => b.pctChange - a.pctChange)
    .slice(0, 20)
    .map(r => ({ symbol: r.symbol, companyName: r.name, ltp: r.close, percentChange: r.pctChange, netChange: r.netChange, volume: r.volume }));

  const losers = [...rows]
    .sort((a, b) => a.pctChange - b.pctChange)
    .slice(0, 20)
    .map(r => ({ symbol: r.symbol, companyName: r.name, ltp: r.close, percentChange: r.pctChange, netChange: r.netChange, volume: r.volume }));

  results._gainers = gainers;
  results._losers  = losers;

  return results;
}

module.exports = { computeScreeners };
