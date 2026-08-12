require('dotenv').config();

// ── Startup env validation ────────────────────────────────────────────────────
// Logs which variables are loaded so you can confirm .env is being read.
// Credentials are masked — only presence is shown, not values.

const _required = ['ANGEL_API_KEY', 'ANGEL_CLIENT_ID', 'ANGEL_PASSWORD', 'ANGEL_TOTP_SECRET', 'FIREBASE_SERVICE_ACCOUNT'];
const _missing  = _required.filter(k => !process.env[k]);

if (_missing.length > 0) {
  console.warn(`[Config] ⚠️  Missing env vars: ${_missing.join(', ')} — check your .env file`);
} else {
  console.log(`[Config] ✅ All required env vars loaded (PORT=${process.env.PORT || '3001'})`);
}

module.exports = {
  angel: {
    apiKey:     process.env.ANGEL_API_KEY,
    clientId:   process.env.ANGEL_CLIENT_ID,
    password:   process.env.ANGEL_PASSWORD,
    totpSecret: process.env.ANGEL_TOTP_SECRET,
  },

  server: {
    port:           parseInt(process.env.PORT || '3001', 10),
    allowedOrigins: (process.env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean),
  },

  firebase: {
    serviceAccount: process.env.FIREBASE_SERVICE_ACCOUNT || './firebase-service-account.json',
  },

  broadcast: {
    intervalMs: parseInt(process.env.BROADCAST_INTERVAL_MS || '1000', 10),
  },

  market: {
    openHour:    parseInt(process.env.MARKET_OPEN_HOUR   || '9',  10),
    openMinute:  parseInt(process.env.MARKET_OPEN_MINUTE || '15', 10),
    closeHour:   parseInt(process.env.MARKET_CLOSE_HOUR  || '15', 10),
    closeMinute: parseInt(process.env.MARKET_CLOSE_MINUTE|| '30', 10),
  },
};
