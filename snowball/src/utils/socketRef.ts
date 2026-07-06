import type { Socket } from 'socket.io-client';
import type { ClientToServerEvents, ServerToClientEvents } from '../../../shared/types';

export type GameSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

// The live game socket is created (and owned) by Game.tsx, but app-level UI
// like the bug-report button also needs it. This tiny external store avoids
// threading the socket through a context just for that; read it with
// useSyncExternalStore(subscribeActiveSocket, getActiveSocket).
let current: GameSocket | null = null;
const listeners = new Set<() => void>();

export const setActiveSocket = (socket: GameSocket | null): void => {
  current = socket;
  listeners.forEach(l => l());
};

export const getActiveSocket = (): GameSocket | null => current;

export const subscribeActiveSocket = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
};
