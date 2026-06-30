// PM2 process definition for CamBridge — mirrors the admin/mirror-server setup.
// Run from the repo root on the server: `pm2 start ecosystem.config.js`
const path = require('path');

const SERVER = path.join(__dirname, 'server');
const DIST = path.join(SERVER, 'dist');

module.exports = {
  apps: [
    {
      name: 'cambridge-server',
      script: path.join(DIST, 'index.js'),
      cwd: SERVER,
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      max_restarts: 10,
      min_uptime: '10s',
      restart_delay: 3000,
      max_memory_restart: '256M',
      kill_timeout: 5000,
      env: {
        NODE_ENV: 'production',
        NODE_OPTIONS: '--enable-source-maps',
      },
    },
  ],
};
