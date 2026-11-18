import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import cors from 'cors';
import express from 'express';
import rateLimit from 'express-rate-limit';
import helmet from 'helmet';
import { createServer as createViteServer } from 'vite';
import { env } from './server/config/env.ts';
import { ensureSeedData, getDb } from './server/db/client.ts';
import type { AuthedRequest } from './server/middleware/auth.ts';
import { initSocketServer } from './server/realtime/socket.ts';
import { authRoutes } from './server/routes/authRoutes.ts';
import { checkoutRoutes } from './server/routes/checkoutRoutes.ts';
import { deviceRoutes } from './server/routes/deviceRoutes.ts';
import { merchantApiRoutes } from './server/routes/merchantApiRoutes.ts';
import { merchantRoutes } from './server/routes/merchantRoutes.ts';
import { notificationRoutes } from './server/routes/notificationRoutes.ts';
import { paymentRoutes } from './server/routes/paymentRoutes.ts';

async function bootstrap() {
  getDb();
  await ensureSeedData();

  const app = express();
  app.set('trust proxy', 1);

  app.use(
    helmet({
      contentSecurityPolicy: false,
      crossOriginEmbedderPolicy: false,
    }),
  );
  app.use(cors());

  app.use(
    express.json({
      limit: '1mb',
      verify: (req, _res, buf) => {
        (req as AuthedRequest).rawBodyString = buf.toString('utf8');
      },
    }),
  );

  // Rate limiting for sensitive endpoints
  const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 60,
    standardHeaders: true,
    legacyHeaders: false,
  });
  const apiLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 180,
    standardHeaders: true,
    legacyHeaders: false,
  });

  app.use('/api/auth/login', authLimiter);
  app.use('/api/v1', apiLimiter);
  app.use('/api/checkout', apiLimiter);

  // Health & DB dialect endpoint
  app.get('/api/health', (_req, res) => {
    const db = getDb();
    res.json({ ok: true, dialect: db.dialect, env: env.nodeEnv, socketIo: true });
  });

  // Demo Merchant Webhook Receiver
  app.post('/api/demo-merchant-webhook', (req, res) => {
    res.status(200).json({
      received: true,
      event: req.header('X-Gateway-Event') ?? req.body?.event,
      signaturePresent: Boolean(req.header('X-Gateway-Signature')),
      receivedAt: new Date().toISOString(),
    });
  });

  // Core API Routers
  app.use('/api/auth', authRoutes);
  app.use('/api/merchants', merchantRoutes);
  app.use('/api/devices', deviceRoutes);
  app.use('/api/notifications', notificationRoutes);
  app.use('/api', paymentRoutes);
  app.use('/api/v1', merchantApiRoutes);
  app.use('/api/checkout', checkoutRoutes);

  // Serve Vite in dev or built static bundle in production
  const distPath = path.resolve(process.cwd(), 'dist');
  if (!env.isProduction && !fs.existsSync(distPath)) {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else if (env.isProduction && fs.existsSync(distPath)) {
    app.use(express.static(distPath));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  } else {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  }

  const httpServer = http.createServer(app);
  initSocketServer(httpServer);

  const onListening = () => {
    const addr = typeof env.port === 'string' ? env.port : `http://0.0.0.0:${env.port}`;
    console.info(`[TakaLedger Gateway] Listening on ${addr} (${getDb().dialect} + Socket.IO)`);
  };

  if (typeof env.port === 'string') {
    httpServer.listen(env.port, onListening);
  } else {
    httpServer.listen(env.port, '0.0.0.0', onListening);
  }
}

bootstrap().catch((err) => {
  console.error('[TakaLedger Gateway] Failed to start:', err);
  process.exit(1);
});
