// CommonJS entry bridge for cPanel CloudLinux Node.js Selector / Phusion Passenger
// Works on Node.js 22+ ("Application startup file: app.cjs")
'use strict';

import('./server.ts').catch((err) => {
  console.error('[TakaLedger] Failed to boot server.ts from app.cjs:', err);
  process.exit(1);
});
