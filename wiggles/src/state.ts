// state.ts — extracted from the original monolithic server.ts.
import { randomUUID } from 'crypto';
import type { Server } from 'socket.io';
import type {
  ClientToServerEvents, ServerToClientEvents,
  CardInstance, Effect, GameState,
} from '../../shared/src/types.js';
import type { Socket } from 'socket.io';


type AbilityPromptType = 'selectPlayer' | 'selectCard' | 'discardCard' | 'confirm' | 'multiSelectCard';

interface AbilityPromptOption {
  id: string;
  label: string;
  payload?: {
    playerId?: string;
    cardInstanceId?: string;
    [key: string]: unknown;
  };
}

interface AbilityPromptRequest {
  promptId: string;
  roomCode: string;
  heroInstanceId: string;
  sourcePlayerId: string;
  promptType: AbilityPromptType;
  message: string;
  options: AbilityPromptOption[];
  effect: Effect;
  remainingEffects: Effect[];
  isItemTrigger?: boolean;
  itemInstanceId?: string;
  isMagicCard?: boolean;
  isChallengePrompt?: boolean;
  isMonsterEffect?: boolean;
  isPartyLeaderAbility?: boolean;
  isSlainPassive?: boolean;
  minSelections?: number;
  maxSelections?: number;
}

const abilityPromptRequests = new Map<string, AbilityPromptRequest>();
const heroesPlayedFromAbilityThisTurn = new Map<string, Set<string>>(); // roomCode → Set<heroInstanceId>

// Records that a hero entered a party via an ability/recovery this turn, so it
// may roll its effect for free (see the rollHeroAbility handler). Callers still
// emit the appropriate client event (heroPlayedFromAbility / heroPlayAccepted).
const markHeroPlayedFromAbility = (roomCode: string, heroInstanceId: string) => {
  let set = heroesPlayedFromAbilityThisTurn.get(roomCode);
  if (!set) { set = new Set(); heroesPlayedFromAbilityThisTurn.set(roomCode, set); }
  set.add(heroInstanceId);
};

interface PendingChallengeState {
  pendingCardInstance: CardInstance;
  pendingPlayerId: string;
  pendingCardType: 'hero' | 'item' | 'magic';
  itemTargetPlayerId?: string;
  itemTargetHeroInstanceId?: string;
  magicSteps?: Effect[];
  eligibleChallengerIds: string[];
  passedPlayerIds: Set<string>;
  challengerId?: string;
  challengeCardInstanceId?: string;
  challengerRollBonus: number;
}
const pendingChallenges = new Map<string, PendingChallengeState>();

interface ModifierPhaseState {
  die1: number;
  die2: number;
  rawDiceTotal: number;
  persistentBonus: number;
  accumulatedModifier: number;
  requiredRoll: number;
  rollContext: 'HERO_ABILITY' | 'ATTACK_MONSTER';
  rollType: 'hero_ability' | 'monster_attack';
  heroInstanceId: string;
  rollingPlayerId: string;
  phase: 'roller_turn' | 'opponent_turn';
  allOpponentsWithModifiers: string[];
  opponentQueue: string[];
  cardPlayedThisCycle: boolean;
  modifiersPlayed: Array<{ playerName: string; cardName: string; amount: number; choiceLabel: string }>;
  monsterInstanceId?: string;
  lowerBound?: number;
  /** True when the slay condition is "roll N or LESS" (m_011 Dracos): requiredRoll
      is then the lower bound and the roll succeeds at or under it. */
  slayOnLow?: boolean;
}
const modifierPhases = new Map<string, ModifierPhaseState>();

// The Socket.IO server is created in server.ts (the entrypoint) and registered
// here via setIo() before any connection is handled. Engine modules read it
// lazily through getIo()/getSocketByPlayerId(), so the circular dependency
// (server → state, engine → state) never resolves io at module-load time.
let io: Server<ClientToServerEvents, ServerToClientEvents>;
const setIo = (server: Server<ClientToServerEvents, ServerToClientEvents>) => { io = server; };
const getIo = () => io;

// Live game rooms, keyed by room code. Owned here so both server.ts (room
// lifecycle) and the prompt-response handlers can reach the same map.
const rooms: Record<string, GameState> = {};
const getRoomState = (roomCode?: string) => roomCode ? rooms[roomCode] : undefined;

// ── player identity ⇄ live socket registry ──────────────────────────────────
// Players are keyed by a persistent, client-generated playerId so a reconnect
// (new socket) can reclaim the same seat. This registry maps a seat to its
// current live socket; keys are room-scoped because the same browser (same
// playerId) can sit in two rooms at once.
const playerSocketIds = new Map<string, string>();
const playerSocketKey = (roomCode: string, playerId: string) => `${roomCode}:${playerId}`;

const registerPlayerSocket = (roomCode: string, playerId: string, socketId: string) => {
  playerSocketIds.set(playerSocketKey(roomCode, playerId), socketId);
};

/** Unbind only if this socket still owns the seat (a takeover may have rebound it). */
const unregisterPlayerSocket = (roomCode: string, playerId: string, socketId: string) => {
  const key = playerSocketKey(roomCode, playerId);
  if (playerSocketIds.get(key) === socketId) playerSocketIds.delete(key);
};

const socketIdForPlayer = (roomCode: string, playerId: string) =>
  playerSocketIds.get(playerSocketKey(roomCode, playerId));

/** The stable player id bound to a socket at connection time (falls back to
    the socket id for clients/tests that don't send one). */
const pidOf = (socket: { id: string; data: { playerId?: unknown } }): string =>
  typeof socket.data.playerId === 'string' && socket.data.playerId ? socket.data.playerId : socket.id;

const getSocketByPlayerId = (roomCode: string, playerId: string) =>
  io.sockets.sockets.get(socketIdForPlayer(roomCode, playerId) ?? playerId);

// Pending seat-removal timers for disconnected players (grace period), keyed
// like the socket registry. Owned here so tests can reset them with the rest
// of the engine state.
const seatRemovalTimers = new Map<string, { timer: NodeJS.Timeout; disconnectedAt: number }>();

const emitAbilityPrompt = (playerId: string, prompt: AbilityPromptRequest) => {
  const targetSocket = getSocketByPlayerId(prompt.roomCode, playerId);
  if (!targetSocket) return;
  abilityPromptRequests.set(prompt.promptId, prompt);
  targetSocket.emit('abilityPrompt', {
    promptId: prompt.promptId,
    heroInstanceId: prompt.heroInstanceId,
    promptType: prompt.promptType,
    message: prompt.message,
    options: prompt.options,
    requesterId: prompt.sourcePlayerId,
    ...(prompt.minSelections !== undefined ? { minSelections: prompt.minSelections } : {}),
    ...(prompt.maxSelections !== undefined ? { maxSelections: prompt.maxSelections } : {}),
  });
};

const emitAbilityResolution = (socket: Socket<ClientToServerEvents, ServerToClientEvents>, heroInstanceId: string, message: string) => {
  socket.emit('abilityResolution', { heroInstanceId, message });
};

const buildPromptId = () => randomUUID();

// h_025 Beary Wise: tracks a round of forced discards so the caster can pick one
// of the discarded cards once every prompted player has discarded.
const collectedDiscards = new Map<string, {
  casterId: string;
  heroInstanceId: string;
  roomCode: string;
  remaining: number;
  cardIds: string[];
}>();
export type { AbilityPromptType, AbilityPromptOption, AbilityPromptRequest, PendingChallengeState, ModifierPhaseState };
export {
  abilityPromptRequests, heroesPlayedFromAbilityThisTurn, markHeroPlayedFromAbility,
  pendingChallenges, modifierPhases,
  collectedDiscards, getSocketByPlayerId, emitAbilityPrompt, emitAbilityResolution, buildPromptId,
  rooms, getRoomState, setIo, getIo,
  playerSocketIds, registerPlayerSocket, unregisterPlayerSocket, socketIdForPlayer, pidOf,
  seatRemovalTimers, playerSocketKey,
};

