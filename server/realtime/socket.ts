import type { Server as HttpServer } from 'node:http';
import jwt from 'jsonwebtoken';
import { Server as SocketIOServer } from 'socket.io';
import { env } from '../config/env.ts';
import type { UserRole } from '../middleware/auth.ts';

let io: SocketIOServer | null = null;

export function initSocketServer(httpServer: HttpServer): SocketIOServer {
  io = new SocketIOServer(httpServer, {
    cors: { origin: '*', methods: ['GET', 'POST'] },
    path: '/socket.io',
  });

  io.on('connection', (socket) => {
    const token = typeof socket.handshake.auth?.token === 'string' ? socket.handshake.auth.token : '';
    const checkoutPaymentId =
      typeof socket.handshake.query?.checkoutId === 'string'
        ? socket.handshake.query.checkoutId
        : '';

    if (checkoutPaymentId) {
      socket.join(`checkout:${checkoutPaymentId}`);
    }

    if (token) {
      try {
        const decoded = jwt.verify(token, env.jwtSecret) as {
          sub: string;
          role: UserRole;
          merchantId: string | null;
        };
        if (decoded.role === 'MERCHANT_ADMIN' && decoded.merchantId) {
          socket.join(`merchant:${decoded.merchantId}`);
        } else if (['SUPER_ADMIN', 'FINANCE_REVIEWER', 'OPERATIONS'].includes(decoded.role)) {
          socket.join('admin:global');
        }
      } catch {
        // Unauthenticated or expired token only receives explicit public checkout room events
      }
    }

    socket.on('checkout:subscribe', (paymentId: unknown) => {
      if (typeof paymentId === 'string' && paymentId.length > 0) {
        socket.join(`checkout:${paymentId}`);
      }
    });
  });

  return io;
}

export function emitPaymentUpdated(payload: {
  paymentId: string;
  merchantId: string;
  status: string;
  provider: string;
  amountBdt: number;
  matchConfidence?: number | null;
}): void {
  if (!io) return;
  io.to('admin:global').emit('payment:updated', payload);
  io.to(`merchant:${payload.merchantId}`).emit('payment:updated', payload);
  io.to(`checkout:${payload.paymentId}`).emit('checkout:status', {
    paymentId: payload.paymentId,
    status: payload.status,
    matchConfidence: payload.matchConfidence ?? null,
  });
}

export function emitNotificationIngested(payload: {
  eventId: string;
  merchantId: string | null;
  provider: string;
  parseStatus: string;
  parsedTrxId: string | null;
  parsedAmountBdt: number | null;
}): void {
  if (!io) return;
  io.to('admin:global').emit('notification:ingested', payload);
  if (payload.merchantId) {
    io.to(`merchant:${payload.merchantId}`).emit('notification:ingested', payload);
  }
}

export function emitDeviceTelemetry(payload: {
  deviceId: string;
  merchantId: string | null;
  status: string;
  batteryPct: number | null;
  networkType: string | null;
  queueDepth: number;
}): void {
  if (!io) return;
  io.to('admin:global').emit('device:telemetry', payload);
  if (payload.merchantId) {
    io.to(`merchant:${payload.merchantId}`).emit('device:telemetry', payload);
  }
}

export function emitFraudAlert(payload: {
  id: string;
  merchantId: string | null;
  alertType: string;
  severity: string;
  summary: string;
}): void {
  if (!io) return;
  io.to('admin:global').emit('fraud:alert', payload);
  if (payload.merchantId) {
    io.to(`merchant:${payload.merchantId}`).emit('fraud:alert', payload);
  }
}

export function emitWebhookDelivered(payload: {
  deliveryId: string;
  merchantId: string;
  paymentIntentId: string;
  status: string;
  httpStatus: number | null;
}): void {
  if (!io) return;
  io.to('admin:global').emit('webhook:delivered', payload);
  io.to(`merchant:${payload.merchantId}`).emit('webhook:delivered', payload);
}
