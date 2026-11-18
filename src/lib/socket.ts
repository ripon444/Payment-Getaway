import { io, type Socket } from 'socket.io-client';
import { getStoredToken } from './api.ts';

export function createGatewaySocket(options?: { checkoutId?: string }): Socket {
  const token = getStoredToken();
  return io({
    path: '/socket.io',
    transports: ['websocket', 'polling'],
    auth: token ? { token } : undefined,
    query: options?.checkoutId ? { checkoutId: options.checkoutId } : undefined,
  });
}
