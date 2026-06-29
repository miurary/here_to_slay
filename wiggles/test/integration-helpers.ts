/**
 * Helpers for real socket.io integration tests: boot the actual server on an
 * ephemeral port and connect real socket.io-client instances. Each TestClient
 * mirrors the server's broadcast state and records received events so tests can
 * await specific outcomes.
 */
import type { AddressInfo } from 'node:net';
import { io as ioc, type Socket as ClientSocket } from 'socket.io-client';
import { httpServer, io } from '../src/server.js';
import type { GameState } from '../../shared/src/types.js';

export const startServer = (): Promise<number> =>
  new Promise(resolve => httpServer.listen(0, () => resolve((httpServer.address() as AddressInfo).port)));

export const stopServer = (): Promise<void> =>
  new Promise(resolve => io.close(() => resolve()));

export const createRoom = async (port: number): Promise<string> => {
  const res = await fetch(`http://localhost:${port}/api/create-room`, { method: 'POST' });
  const body = (await res.json()) as { roomCode: string };
  return body.roomCode;
};

const delay = (ms: number) => new Promise(r => setTimeout(r, ms));
const waitFor = async <T>(getter: () => T, pred: (v: T) => boolean, ms = 3000): Promise<T> => {
  const start = Date.now();
  for (;;) {
    const v = getter();
    if (pred(v)) return v;
    if (Date.now() - start > ms) throw new Error('integration timeout');
    await delay(8);
  }
};

// Events the client records for assertions.
const RECORDED = [
  'stateUpdate', 'playersUpdated', 'actionFailed', 'cardDrawn', 'heroRollResult',
  'monsterAttackResult', 'challengeResolved', 'abilityPrompt', 'abilityResolution',
  'heroPlayAccepted', 'heroPlayedFromAbility', 'roomFull', 'pongClient',
];

export interface TestClient {
  socket: ClientSocket;
  id: string;
  events: Record<string, unknown[][]>;
  state(): GameState | undefined;
  emit(event: string, ...args: unknown[]): void;
  waitState(pred: (gs: GameState) => boolean, ms?: number): Promise<GameState>;
  /** Resolve with the next occurrence of `event` after this call. */
  waitEvent(event: string, ms?: number): Promise<unknown[]>;
  close(): void;
}

export const connect = (port: number, roomCode: string, username: string): Promise<TestClient> =>
  new Promise((resolve, reject) => {
    const socket = ioc(`http://localhost:${port}`, {
      auth: { roomCode, username }, transports: ['websocket'], forceNew: true,
    });
    const events: Record<string, unknown[][]> = Object.fromEntries(RECORDED.map(e => [e, []]));
    let lastState: GameState | undefined;
    for (const e of RECORDED) {
      socket.on(e, (...args: unknown[]) => {
        events[e]!.push(args);
        if (e === 'stateUpdate') lastState = args[0] as GameState;
      });
    }
    socket.on('connect_error', err => reject(err));
    socket.on('connect', () => {
      resolve({
        socket,
        id: socket.id!,
        events,
        state: () => lastState,
        emit: (event, ...args) => { socket.emit(event, ...args); },
        waitState: (pred, ms) => waitFor(() => lastState, gs => !!gs && pred(gs), ms) as Promise<GameState>,
        waitEvent: (event, ms) => {
          const base = events[event]!.length;
          return waitFor(() => events[event]!, arr => arr.length > base, ms).then(arr => arr[arr.length - 1]!);
        },
        close: () => socket.disconnect(),
      });
    });
  });
