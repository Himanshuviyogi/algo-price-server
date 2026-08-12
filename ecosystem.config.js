/**
 * PM2 Ecosystem Config — Algo Trading Price Server
 *
 * Usage:
 *   pm2 start ecosystem.config.js          # start
 *   pm2 restart algo-price-server          # restart
 *   pm2 stop    algo-price-server          # stop
 *   pm2 save                               # persist across reboots
 *   pm2 logs    algo-price-server          # tail logs
 */

module.exports = {
  apps: [
    {
      name: 'algo-price-server',
      script: 'src/server.js',

      // ── Restart policy ────────────────────────────────────────────────────
      autorestart: true,          // restart on crash
      watch: false,               // don't watch files in production
      max_memory_restart: '512M', // restart if process exceeds 512 MB

      // ── Instances ─────────────────────────────────────────────────────────
      instances: 1,               // single instance — Socket.IO requires sticky sessions
      exec_mode: 'fork',          // fork mode (not cluster) for WebSocket compatibility

      // ── Logging ───────────────────────────────────────────────────────────
      out_file: 'logs/out.log',
      error_file: 'logs/error.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      merge_logs: true,

      // ── Environment ───────────────────────────────────────────────────────
      // Set NODE_ENV and all secrets in a real .env file on the server.
      // PM2 will load .env automatically when env_file is set.
      env: {
        NODE_ENV: 'production',
        PORT: 3001,
      },

      // ── Windows-specific ──────────────────────────────────────────────────
      // PM2 on Windows needs the interpreter set explicitly if node isn't in PATH.
      // Uncomment and adjust if `pm2 start` fails:
      // interpreter: 'C:\\Program Files\\nodejs\\node.exe',

      // ── Graceful shutdown ─────────────────────────────────────────────────
      kill_timeout: 5000,         // wait 5s for clean shutdown before SIGKILL
      listen_timeout: 10000,      // wait 10s for app to declare "ready"
    },
  ],
};
