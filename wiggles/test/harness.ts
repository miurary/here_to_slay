/**
 * Test harness for driving the game engine directly (no real network).
 *
 * The engine reads the Socket.IO server lazily through state.getIo(), so we can
 * register a fake `io` whose sockets simply record every event they emit. That
 * lets a test call an engine entrypoint (e.g. activateHeroAbility) against an
 * in-memory GameState and then assert on (a) the mutated GameState and (b) the
 * events captured per socket / per room broadcast.
 */
import {
  setIo,
  abilityPromptRequests,
  heroesPlayedFromAbilityThisTurn,
  pendingChallenges,
  modifierPhases,
  collectedDiscards,
  rooms,
} from '../src/state.js';
import { loadAllCardTemplates } from '../src/cards.js';
import type {
  GameState, PlayerState, CardInstance, CardTemplate, MonsterInstance, CardType,
} from '../../shared/src/types.js';

// ── card templates (loaded once) ─────────────────────────────────────────────
let _templates: Record<string, CardTemplate> | null = null;
export const templates = (): Record<string, CardTemplate> => (_templates ??= loadAllCardTemplates());

const TYPE_MAP: Record<string, CardType> = {
  partyleader: 'party_leader', party_leader: 'party_leader',
  hero: 'hero', item: 'item', cursed_item: 'item', magic: 'magic',
  modifier: 'modifier', challenge: 'challenge', monster: 'monster',
};
const cardTypeFor = (templateId: string): CardType => {
  const t = templates()[templateId];
  return (t ? TYPE_MAP[t.type.toLowerCase()] : undefined) ?? 'magic';
};

// ── fixture builders ─────────────────────────────────────────────────────────
let _seq = 0;
/** Create a CardInstance for a real template id (cardType derived from the template). */
export const makeCard = (templateId: string, overrides: Partial<CardInstance> = {}): CardInstance => ({
  instanceId: `${templateId}#${++_seq}`,
  templateId,
  cardType: cardTypeFor(templateId),
  effectUsedThisTurn: false,
  ...overrides,
});

export const makeMonster = (templateId: string, overrides: Partial<MonsterInstance> = {}): MonsterInstance => ({
  ...makeCard(templateId, { cardType: 'monster' }),
  ...overrides,
});

export interface BuildPlayerInput {
  id: string;
  username?: string;
  hand?: CardInstance[];
  party?: CardInstance[];
  actionPoints?: number;
  partyLeaderId?: string;
  slainMonsters?: CardInstance[];
  temporaryModifiers?: PlayerState['temporaryModifiers'];
}

export const buildPlayer = (input: BuildPlayerInput): PlayerState => ({
  id: input.id,
  username: input.username ?? input.id,
  actionPoints: input.actionPoints ?? 3,
  partyLeaderId: input.partyLeaderId,
  slainMonsters: input.slainMonsters ?? [],
  zones: { hand: input.hand ?? [], party: input.party ?? [] },
  ...(input.temporaryModifiers ? { temporaryModifiers: input.temporaryModifiers } : {}),
});

export interface BuildStateInput {
  players: PlayerState[];
  activePlayerId?: string;
  status?: GameState['status'];
  mainDeck?: CardInstance[];
  discardPile?: CardInstance[];
  activeMonsters?: MonsterInstance[];
  monsterDeck?: MonsterInstance[];
  roomFlags?: Record<string, boolean>;
  targetMonstersToWin?: number;
}

export const buildGameState = (input: BuildStateInput): GameState => {
  const players: Record<string, PlayerState> = {};
  for (const p of input.players) players[p.id] = p;
  return {
    gameId: 'TEST',
    status: input.status ?? 'in_progress',
    activePlayerId: input.activePlayerId ?? input.players[0]?.id ?? '',
    turnNumber: 1,
    phase: 'DRAW',
    players,
    stack: [],
    monsterDeck: input.monsterDeck ?? [],
    partyLeaderDeck: [],
    mainDeck: input.mainDeck ?? [],
    activeMonsters: input.activeMonsters ?? [],
    discardedMonsters: [],
    discardPile: input.discardPile ?? [],
    cardTemplates: templates(),
    diceRolls: {},
    availablePartyLeaderCards: [],
    partyLeaderSelectionOrder: [],
    currentSelectionPlayerId: undefined,
    rollWinnerId: undefined,
    lobbyLeaderId: input.players[0]?.id,
    currentRollerId: undefined,
    firstPlayerId: undefined,
    targetMonstersToWin: input.targetMonstersToWin,
    gameLog: [],
    ...(input.roomFlags ? { roomFlags: input.roomFlags } : {}),
  };
};

// ── fake socket / io ─────────────────────────────────────────────────────────
export interface EmittedEvent { event: string; args: unknown[]; }

export interface FakeSocket {
  id: string;
  data: { roomCode?: string; [k: string]: unknown };
  handshake: { auth: Record<string, unknown> };
  emitted: EmittedEvent[];
  emit(event: string, ...args: unknown[]): boolean;
  join(): void;
  disconnect(): void;
  disconnected: boolean;
  /** Handlers registered via socket.on, keyed by event name. */
  handlers: Map<string, (...args: unknown[]) => void>;
  on(event: string, cb: (...args: unknown[]) => void): void;
  /** Invoke a registered handler as if the client emitted the event. */
  fire(event: string, ...args: unknown[]): void;
  /** All abilityPrompt payloads this socket has received, in order. */
  prompts(): AbilityPromptPayload[];
  /** The most recent abilityPrompt payload (throws if none). */
  lastPrompt(): AbilityPromptPayload;
  emittedOf(event: string): EmittedEvent[];
}

export interface AbilityPromptPayload {
  promptId: string;
  heroInstanceId: string;
  promptType: string;
  message: string;
  options: Array<{ id: string; label: string; payload?: Record<string, unknown> }>;
  requesterId: string;
  minSelections?: number;
  maxSelections?: number;
}

export interface FakeIo {
  sockets: { sockets: Map<string, FakeSocket>; adapter: { rooms: Map<string, { size: number }> } };
  broadcasts: Array<{ room: string; event: string; args: unknown[] }>;
  to(room: string): { emit(event: string, ...args: unknown[]): void };
}

const makeSocket = (id: string, roomCode: string): FakeSocket => {
  const emitted: EmittedEvent[] = [];
  const handlers = new Map<string, (...args: unknown[]) => void>();
  return {
    id,
    data: { roomCode },
    handshake: { auth: { roomCode, username: id } },
    emitted,
    disconnected: false,
    handlers,
    emit(event, ...args) { emitted.push({ event, args }); return true; },
    join() {},
    disconnect() { this.disconnected = true; },
    on(event, cb) { handlers.set(event, cb); },
    fire(event, ...args) {
      const cb = handlers.get(event);
      if (!cb) throw new Error(`socket ${id} has no handler for '${event}'`);
      cb(...args);
    },
    prompts() {
      return emitted.filter(e => e.event === 'abilityPrompt').map(e => e.args[0] as AbilityPromptPayload);
    },
    lastPrompt() {
      const ps = this.prompts();
      const last = ps[ps.length - 1];
      if (!last) throw new Error(`socket ${id} received no abilityPrompt`);
      return last;
    },
    emittedOf(event) { return emitted.filter(e => e.event === event); },
  };
};

export interface Harness {
  io: FakeIo;
  roomCode: string;
  /** The fake socket for a given player id. */
  socket(id: string): FakeSocket;
  /** No-op-ish room update callback passed to engine entrypoints. */
  sendRoomUpdate: () => void;
  roomUpdateCount(): number;
  /** Find the prompt (across all sockets) whose payload matches, by promptId. */
  promptById(promptId: string): AbilityPromptPayload | undefined;
}

/**
 * Build a fake io, register a socket per player, install it via setIo(), and
 * register the room in the shared rooms map (so getRoomState works).
 */
export const createHarness = (gameState: GameState, roomCode = 'ROOM'): Harness => {
  const socketMap = new Map<string, FakeSocket>();
  for (const id of Object.keys(gameState.players)) socketMap.set(id, makeSocket(id, roomCode));

  const broadcasts: FakeIo['broadcasts'] = [];
  const adapterRooms = new Map<string, { size: number }>([[roomCode, { size: socketMap.size }]]);
  const io: FakeIo = {
    sockets: { sockets: socketMap, adapter: { rooms: adapterRooms } },
    broadcasts,
    to(room) { return { emit(event, ...args) { broadcasts.push({ room, event, args }); } }; },
  };
  setIo(io as unknown as Parameters<typeof setIo>[0]);
  rooms[roomCode] = gameState;

  let updates = 0;
  const sendRoomUpdate = () => { updates += 1; };

  return {
    io,
    roomCode,
    socket(id) {
      const s = socketMap.get(id);
      if (!s) throw new Error(`no fake socket for player ${id}`);
      return s;
    },
    sendRoomUpdate,
    roomUpdateCount: () => updates,
    promptById(promptId) {
      for (const s of socketMap.values()) {
        const found = s.prompts().find(p => p.promptId === promptId);
        if (found) return found;
      }
      return undefined;
    },
  };
};

/** Clear all module-level engine state so tests don't leak into each other. */
export const resetEngineState = (): void => {
  abilityPromptRequests.clear();
  heroesPlayedFromAbilityThisTurn.clear();
  pendingChallenges.clear();
  modifierPhases.clear();
  collectedDiscards.clear();
  for (const key of Object.keys(rooms)) delete rooms[key];
};
