/**
 * In-memory price cache with change detection and disk persistence.
 *
 * Stores the latest price data for each symbol.
 * Persists to cache.json every 60s and on process exit so prices
 * survive server restarts (e.g. VPS reboot, PM2 restart).
 */

const fs   = require('fs');
const path = require('path');

const CACHE_FILE = path.join(__dirname, '../../cache.json');

/** @type {Map<string, { ltp, open, high, low, close, change, changePercent, ts }>} */
const _cache = new Map();

/** Pending updates collected between broadcast intervals */
const _pending = new Map();

// ── Load persisted cache on startup ──────────────────────────────────────────

try {
  if (fs.existsSync(CACHE_FILE)) {
    const saved = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
    for (const [symbol, data] of Object.entries(saved)) {
      _cache.set(symbol, data);
    }
    console.log(`[Cache] Loaded ${_cache.size} cached prices from disk.`);
  }
} catch (err) {
  console.warn('[Cache] Could not load persisted cache:', err.message);
}

// ── Persist cache to disk every 60s ──────────────────────────────────────────

function _saveToDisk() {
  try {
    const data = {};
    for (const [symbol, val] of _cache) {
      data[symbol] = val;
    }
    fs.writeFileSync(CACHE_FILE, JSON.stringify(data), 'utf8');
  } catch (err) {
    console.warn('[Cache] Could not persist cache to disk:', err.message);
  }
}

setInterval(_saveToDisk, 60_000);

// Save on process exit (PM2 restart, SIGTERM, etc.)
process.on('exit',    _saveToDisk);
process.on('SIGTERM', () => { _saveToDisk(); process.exit(0); });
process.on('SIGINT',  () => { _saveToDisk(); process.exit(0); });

/**
 * Record an incoming tick. Returns true if LTP changed.
 */
function update(symbol, data) {
  const prev = _cache.get(symbol);
  const changed = !prev || prev.ltp !== data.ltp;

  _cache.set(symbol, data);

  if (changed) {
    _pending.set(symbol, data);
  }

  return changed;
}

/**
 * Drain all pending (changed) updates and clear the pending map.
 */
function drainPending() {
  const snapshot = new Map(_pending);
  _pending.clear();
  return snapshot;
}

/**
 * Get the latest cached price for a symbol.
 */
function get(symbol) {
  return _cache.get(symbol) || null;
}

/**
 * Get all cached prices (for snapshot on connect).
 */
function getAll() {
  const result = {};
  for (const [symbol, data] of _cache) {
    result[symbol] = data;
  }
  return result;
}

/**
 * Clear all in-memory cached data (called at market close).
 * Does NOT clear the disk file — last known prices are preserved
 * so they survive server restarts even after market close.
 */
function clear() {
  _cache.clear();
  _pending.clear();
  // Intentionally NOT calling _saveToDisk() here —
  // we want to keep the last prices on disk for post-market restarts.
}

module.exports = { update, drainPending, get, getAll, clear };
