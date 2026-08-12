const admin  = require('firebase-admin');
const config = require('../config');

let _initialized = false;

function initFirebase() {
  if (_initialized) return;

  let credential;
  const sa = config.firebase.serviceAccount;

  if (typeof sa === 'string' && sa.startsWith('{')) {
    // JSON string (Railway env var)
    credential = admin.credential.cert(JSON.parse(sa));
  } else {
    // File path
    credential = admin.credential.cert(require(sa.startsWith('.') ? `${process.cwd()}/${sa}` : sa));
  }

  admin.initializeApp({ credential });
  _initialized = true;
  console.log('[Firebase] Admin SDK initialized.');
}

/**
 * Verify a Firebase ID token.
 * Returns the decoded token (with uid) or throws.
 */
async function verifyToken(idToken) {
  initFirebase();
  return admin.auth().verifyIdToken(idToken);
}

module.exports = { initFirebase, verifyToken };
