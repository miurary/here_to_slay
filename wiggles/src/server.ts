// server.ts — extracted from the original monolithic server.ts.
import express from 'express';
import { createServer } from 'http';
import { Server, Socket } from 'socket.io';
import cors from 'cors';
import type {
  ClientToServerEvents, ServerToClientEvents,
  BugCategory, Effect, GameState, MonsterInstance,
} from '../../shared/src/types.js';
import { BUG_CATEGORIES } from '../../shared/src/types.js';
import { logEvent, nameOf } from './log.js';
import {
  beginGameSession, currentSessionInfo, endGameSession, logGame, saveBugReport,
  shutdownAnalytics, sweepOrphanedLogs,
} from './analytics.js';
import { drawCards, initializeDecks, loadAllCardTemplates } from './cards.js';
import {
  rooms, getRoomState, setIo, getIo, emitAbilityPrompt, buildPromptId, abilityPromptRequests,
  pendingChallenges, modifierPhases, heroesPlayedFromAbilityThisTurn, markHeroPlayedFromAbility,
  registerPlayerSocket, unregisterPlayerSocket, socketIdForPlayer, playerSocketKey, seatRemovalTimers,
} from './state.js';
import type { AbilityPromptOption } from './state.js';
import {
  getHeroEffectiveClass, decrementTemporaryModifiers, applyWinIfMet,
  playerHasSlainEffectFlag, playerHasSlainEffectAction,
} from './util.js';
import { drawCardsForPlayer, activateHeroAbility, triggerSlainMonsterPassive } from './effects.js';
import { processMagicCardSteps } from './magic.js';
import { checkMonsterRequirements, executeMonsterAttackRoll } from './monsters.js';
import {
  getModifierAmount, getModifierChoiceLabel, modifierDiscardsHand, updateModifierPhaseGameState,
  finalizeRoll, advanceModifierQueue, getSlainOpponentModifierBonus, executeRollAndEmit,
} from './rolls.js';
import {
  getEligibleChallengerIds, getChallengeCardBonus, openChallengeWindow,
  executePendingCardPlay, resolveChallengeRollOff,
} from './challenges.js';
import { handlePromptResponse, handleMultiPromptResponse } from './promptResponse.js';


// Falls back to the Vite dev server origin for local development. In production,
// set CORS_ORIGIN to the deployed frontend origin. Must be an explicit origin
// (not "*") because the client connects with credentials.
const CORS_ORIGIN = process.env.CORS_ORIGIN || 'http://localhost:5173';

const app = express();
app.use(cors({origin: CORS_ORIGIN, credentials: true}));
app.use(express.json());

const generateRoomCode = (): string => {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  return Array.from({ length: 6 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
};

const createInitialGameState = (roomCode: string): GameState => ({
  gameId: roomCode,
  status: 'waiting',
  activePlayerId: '',
  turnNumber: 0,
  phase: 'DRAW',
  players: {},
  stack: [],
  monsterDeck: [],
  partyLeaderDeck: [],
  mainDeck: [],
  activeMonsters: [],
  discardedMonsters: [],
  discardPile: [],
  cardTemplates: loadAllCardTemplates(),
  diceRolls: {},
  availablePartyLeaderCards: [],
  partyLeaderSelectionOrder: [],
  currentSelectionPlayerId: undefined,
  rollWinnerId: undefined,
  lobbyLeaderId: undefined,
  currentRollerId: undefined,
  firstPlayerId: undefined,
  targetMonstersToWin: undefined,
  gameLog: []
});

app.post('/api/create-room', (_req, res) => {
  let roomCode = generateRoomCode();
  while (rooms[roomCode]) {
    roomCode = generateRoomCode();
  }
  rooms[roomCode] = createInitialGameState(roomCode);
  res.json({ roomCode });
});

app.get('/api/room/:roomCode', (req, res) => {
  const roomCode = req.params.roomCode?.toUpperCase();
  res.json({ exists: Boolean(getRoomState(roomCode)) });
});

const httpServer = createServer(app);
const API_URL = CORS_ORIGIN;

// Apply the types to the Socket Server
const io = new Server<ClientToServerEvents, ServerToClientEvents>(httpServer, {
  cors: {
    origin: API_URL,
    methods: ["GET", "POST"],
    credentials: true
  },
  // Briefly-dropped connections (same tab, short network blip) resume with
  // their socket session intact instead of surfacing as a full disconnect.
  connectionStateRecovery: {},
});

// Register the io instance so state.ts (and through it every engine module) can
// resolve sockets without importing the entrypoint.
setIo(io);

// Anonymous players are named by join order, skipping any name already taken
// (e.g. a player who called themselves "Player 1", or an earlier anonymous join).
const nextDefaultUsername = (gameState: GameState): string => {
  const taken = new Set(Object.values(gameState.players).map(p => p.username));
  for (let n = 1; ; n++) {
    if (!taken.has(`Player ${n}`)) return `Player ${n}`;
  }
};

// Push the full room state to every client in the room. Mirrors the
// per-connection sendRoomUpdate, for callers with no socket (e.g. timers).
const broadcastRoomUpdate = (roomCode: string) => {
  const current = getRoomState(roomCode);
  if (!current) return;
  getIo().to(roomCode).emit('stateUpdate', current);
  getIo().to(roomCode).emit('playersUpdated', Object.values(current.players));
};

// ── Auto-advance for the confirm phases ─────────────────────────────────────
// roll_complete and party_leader_review advance on their own after this long;
// the lobby leader's Continue button just skips the wait. autoAdvanceAt is
// broadcast in the state so every client renders the same countdown.
const AUTO_ADVANCE_MS = 6000;
const autoAdvanceTimers = new Map<string, NodeJS.Timeout>();

const clearAutoAdvance = (roomCode: string, gameState?: GameState) => {
  const timer = autoAdvanceTimers.get(roomCode);
  if (timer) clearTimeout(timer);
  autoAdvanceTimers.delete(roomCode);
  if (gameState) delete gameState.autoAdvanceAt;
};

// The two leader-confirmed transitions, shared by the auto-advance timer and a
// manual continueGame.
const beginPartyLeaderSelection = (gameState: GameState) => {
  const allPlayerIds = Object.keys(gameState.players);
  const firstPlayer = gameState.firstPlayerId ?? allPlayerIds[0] ?? '';
  const selectionOrder = firstPlayer
    ? [firstPlayer, ...allPlayerIds.filter((id) => id !== firstPlayer)]
    : [...allPlayerIds];

  gameState.status = 'party_leader_selection';
  gameState.availablePartyLeaderCards = [...gameState.partyLeaderDeck];
  gameState.partyLeaderSelectionOrder = selectionOrder;
  gameState.currentSelectionPlayerId = selectionOrder[0];
  gameState.diceRolls = {};
  logGame(gameState, 'party_leader_selection_started', { selectionOrder });
  // The first picker may be a seat held for a disconnected player.
  ensureSelectionProgress(gameState.gameId, gameState);
};

const beginInProgress = (gameState: GameState) => {
  gameState.status = 'in_progress';
  const desired = gameState.firstPlayerId ?? Object.keys(gameState.players)[0] ?? '';
  gameState.activePlayerId = isSeatConnected(gameState, desired)
    ? desired
    : nextConnectedAfter(gameState, desired) ?? desired;
  for (const pid of Object.keys(gameState.players)) {
    const p = gameState.players[pid];
    if (!p) continue;
    p.actionPoints = 3;
  }
  logGame(gameState, 'first_turn_started', { activePlayerId: gameState.activePlayerId }, gameState.activePlayerId);
};

const scheduleAutoAdvance = (roomCode: string, gameState: GameState) => {
  clearAutoAdvance(roomCode, gameState);
  gameState.autoAdvanceAt = Date.now() + AUTO_ADVANCE_MS;
  const timer = setTimeout(() => {
    autoAdvanceTimers.delete(roomCode);
    const gs = getRoomState(roomCode);
    if (!gs) return;
    delete gs.autoAdvanceAt;
    if (gs.status === 'roll_complete') beginPartyLeaderSelection(gs);
    else if (gs.status === 'party_leader_review') beginInProgress(gs);
    else return;
    broadcastRoomUpdate(roomCode);
  }, AUTO_ADVANCE_MS);
  // Don't let a pending countdown keep the process alive on shutdown.
  timer.unref?.();
  autoAdvanceTimers.set(roomCode, timer);
};

// ── Reconnection & seat grace ────────────────────────────────────────────────
// Once a game has started, a disconnected player's seat (hand, party, slain
// monsters) is held for SEAT_GRACE_MS so they can reconnect: the client keeps
// a persistent playerId in localStorage and presents it in the handshake. In
// the lobby (and after a game finishes) there is nothing to hold, so seats
// are removed immediately.
const SEAT_GRACE_MS = 120_000;

const isSeatConnected = (gameState: GameState, playerId: string | undefined) =>
  !!playerId && !!gameState.players[playerId] && gameState.players[playerId]?.connected !== false;

// Next seat after `fromPid` in table order whose player is connected. Wraps
// all the way around, so a lone connected player keeps their own turn.
const nextConnectedAfter = (gameState: GameState, fromPid: string): string | undefined => {
  const ids = Object.keys(gameState.players);
  const start = ids.indexOf(fromPid);
  for (let i = 1; i <= ids.length; i++) {
    const candidate = ids[(start + i) % ids.length];
    if (candidate && isSeatConnected(gameState, candidate)) return candidate;
  }
  return undefined;
};

const cancelSeatRemoval = (roomCode: string, playerId: string): { disconnectedAt: number } | undefined => {
  const key = playerSocketKey(roomCode, playerId);
  const entry = seatRemovalTimers.get(key);
  if (!entry) return undefined;
  clearTimeout(entry.timer);
  seatRemovalTimers.delete(key);
  return entry;
};

// Permanently drop a seat: lobby leave, game-over leave, or grace expiry.
const removePlayerSeat = (roomCode: string, gameState: GameState, playerId: string, reason: string) => {
  const player = gameState.players[playerId];
  if (!player) return;

  cancelSeatRemoval(roomCode, playerId);
  logGame(gameState, 'player_removed', { username: player.username, reason }, playerId);
  delete gameState.players[playerId];
  if (gameState.status === 'rolling') delete gameState.diceRolls[playerId];

  if (gameState.activePlayerId === playerId) {
    gameState.activePlayerId = nextConnectedAfter(gameState, playerId) ?? Object.keys(gameState.players)[0] ?? '';
  }
  if (gameState.lobbyLeaderId === playerId) {
    gameState.lobbyLeaderId = nextConnectedAfter(gameState, playerId) ?? Object.keys(gameState.players)[0];
  }

  if (Object.keys(gameState.players).length === 0) {
    void endGameSession(gameState, 'abandoned');
    clearAutoAdvance(roomCode);
    pendingChallenges.delete(roomCode);
    modifierPhases.delete(roomCode);
    delete rooms[roomCode];
    return;
  }

  // The departed seat may have been holding up the roll or leader selection.
  if (gameState.status === 'rolling' && gameState.currentRollerId === playerId) {
    advanceFirstRoll(roomCode, gameState);
  }
  if (gameState.status === 'party_leader_selection') {
    ensureSelectionProgress(roomCode, gameState);
  }

  broadcastRoomUpdate(roomCode);
};

const scheduleSeatRemoval = (roomCode: string, playerId: string) => {
  cancelSeatRemoval(roomCode, playerId);
  const timer = setTimeout(() => {
    seatRemovalTimers.delete(playerSocketKey(roomCode, playerId));
    const gs = getRoomState(roomCode);
    if (!gs) return;
    const player = gs.players[playerId];
    if (!player || player.connected !== false) return; // reconnected meanwhile
    logEvent(gs, 'system', `${nameOf(gs, playerId)}'s seat was released after ${Math.round(SEAT_GRACE_MS / 60000)} minutes.`, { id: playerId, username: player.username });
    removePlayerSeat(roomCode, gs, playerId, 'grace_expired');
  }, SEAT_GRACE_MS);
  timer.unref?.();
  seatRemovalTimers.set(playerSocketKey(roomCode, playerId), { timer, disconnectedAt: Date.now() });
};

// Turn advancement shared by endTurn and a mid-turn disconnect (forced pass).
// Skips seats held for disconnected players.
const advanceTurn = (roomCode: string, gameState: GameState, fromPid: string, forced: boolean) => {
  const currentPlayer = gameState.players[fromPid];
  if (currentPlayer) {
    decrementTemporaryModifiers(currentPlayer);
  }

  const nextPlayerId = nextConnectedAfter(gameState, fromPid) ?? '';
  gameState.activePlayerId = nextPlayerId;
  gameState.turnNumber = (gameState.turnNumber ?? 0) + 1;

  const nextPlayer = nextPlayerId ? gameState.players[nextPlayerId] : undefined;
  if (nextPlayer) {
    nextPlayer.actionPoints = 3;
    for (const slainMonster of nextPlayer.slainMonsters ?? []) {
      const mt = gameState.cardTemplates[slainMonster.templateId];
      if (mt?.slainEffect?.action === 'EXTRA_AP') nextPlayer.actionPoints += mt.slainEffect.amount ?? 0;
    }
    // Reset ability usage flags for new active player
    nextPlayer.zones.party.forEach((card) => {
      card.effectUsedThisTurn = false;
    });
    nextPlayer.zones.hand.forEach((card) => {
      card.effectUsedThisTurn = false;
    });
  }

  heroesPlayedFromAbilityThisTurn.delete(roomCode);
  delete gameState.roomFlags;

  logEvent(gameState, 'system', forced
    ? `${nameOf(gameState, fromPid)} disconnected — their turn passes to ${nameOf(gameState, nextPlayerId)}.`
    : `${nameOf(gameState, fromPid)} ended their turn. It is now ${nameOf(gameState, nextPlayerId)}'s turn.`,
    { id: fromPid, username: currentPlayer?.username });
  logGame(gameState, 'turn_ended', { forced, nextPlayerId }, fromPid);
  logGame(gameState, 'turn_started', {
    turnNumber: gameState.turnNumber,
    actionPoints: nextPlayer?.actionPoints,
  }, nextPlayerId);
};

// Move the first-player roll along: hand the dice to the next connected player
// who hasn't rolled; when none remain (held seats simply don't roll), decide
// the winner and enter roll_complete.
const advanceFirstRoll = (roomCode: string, gameState: GameState) => {
  const next = Object.keys(gameState.players).find(id =>
    !(id in gameState.diceRolls) && isSeatConnected(gameState, id));
  if (next) {
    gameState.currentRollerId = next;
    return;
  }

  let maxRoll = 0;
  let winnerId = '';
  for (const [playerId, roll] of Object.entries(gameState.diceRolls)) {
    if (roll > maxRoll) {
      maxRoll = roll;
      winnerId = playerId;
    }
  }

  gameState.activePlayerId = winnerId;
  gameState.firstPlayerId = winnerId;
  gameState.currentRollerId = undefined;
  gameState.rollWinnerId = winnerId;
  gameState.turnNumber = 1;
  gameState.phase = 'DRAW';
  gameState.status = 'roll_complete';
  logGame(gameState, 'turn_order_decided', { rolls: gameState.diceRolls, firstPlayerId: winnerId });
  scheduleAutoAdvance(roomCode, gameState);
};

// Advance leader selection one step, entering review once the order is done.
const advanceLeaderSelection = (roomCode: string, gameState: GameState) => {
  const order = gameState.partyLeaderSelectionOrder;
  const currentIndex = order.findIndex((id) => id === gameState.currentSelectionPlayerId);
  const nextIndex = currentIndex + 1;

  if (nextIndex < order.length) {
    gameState.currentSelectionPlayerId = order[nextIndex];
  } else {
    gameState.currentSelectionPlayerId = undefined;
    gameState.status = 'party_leader_review';
    if (gameState.activeMonsters.length === 0) {
      gameState.activeMonsters = drawCards(gameState.monsterDeck, 3) as MonsterInstance[];
    }
    scheduleAutoAdvance(roomCode, gameState);
  }
};

// While the pick belongs to a disconnected (or removed) seat, auto-assign the
// top available leader so selection never stalls waiting for someone who
// isn't there. The seat keeps the leader for when they reconnect.
const ensureSelectionProgress = (roomCode: string, gameState: GameState) => {
  while (gameState.status === 'party_leader_selection' && gameState.currentSelectionPlayerId) {
    const currentPid = gameState.currentSelectionPlayerId;
    const player = gameState.players[currentPid];
    if (player && player.connected !== false) return;
    if (player && !player.partyLeaderId) {
      const card = gameState.availablePartyLeaderCards.shift();
      if (card) {
        player.zones.party = [card];
        player.partyLeaderId = card.templateId;
        logEvent(gameState, 'system', `${nameOf(gameState, currentPid)} is disconnected — ${gameState.cardTemplates[card.templateId]?.name ?? 'a party leader'} was chosen for them.`, { id: currentPid, username: player.username });
        logGame(gameState, 'party_leader_chosen', {
          templateId: card.templateId,
          auto: true,
          remainingChoices: gameState.availablePartyLeaderCards.map(c => c.templateId),
        }, currentPid);
      }
    }
    advanceLeaderSelection(roomCode, gameState);
  }
};

// Resolve everything the game may be waiting on from a player who just went
// away: pending challenge participation, modifier phase turns, their active
// turn, their first-player roll, or their leader pick. Decisions default to
// "pass" — the seat itself survives (or not) per the caller's rules.
const resolveDeparture = (roomCode: string, gameState: GameState, playerId: string) => {
  const pending = pendingChallenges.get(roomCode);
  if (pending) {
    if (pending.pendingPlayerId === playerId) {
      gameState.discardPile.push(pending.pendingCardInstance);
      pendingChallenges.delete(roomCode);
      delete gameState.pendingChallenge;
    } else if (pending.eligibleChallengerIds.includes(playerId)) {
      pending.passedPlayerIds.add(playerId);
      const remaining = pending.eligibleChallengerIds.filter(id => !pending.passedPlayerIds.has(id));
      if (remaining.length === 0 && !pending.challengerId) {
        executePendingCardPlay(roomCode, pending, gameState);
        pendingChallenges.delete(roomCode);
        delete gameState.pendingChallenge;
      } else {
        const gsPending = gameState.pendingChallenge;
        if (gsPending) gsPending.eligibleChallengerIds = remaining;
      }
    }
  }

  const modPhase = modifierPhases.get(roomCode);
  if (modPhase) {
    if (modPhase.rollingPlayerId === playerId) {
      modifierPhases.delete(roomCode);
      delete gameState.modifierPhase;
    } else if (modPhase.allOpponentsWithModifiers.includes(playerId)) {
      modPhase.allOpponentsWithModifiers = modPhase.allOpponentsWithModifiers.filter(id => id !== playerId);
      modPhase.opponentQueue = modPhase.opponentQueue.filter(id => id !== playerId);
      if (modPhase.phase === 'opponent_turn' && modPhase.opponentQueue.length === 0) {
        if (modPhase.cardPlayedThisCycle) {
          const newQueue = modPhase.allOpponentsWithModifiers.filter(
            id => gameState.players[id]?.zones.hand.some(c => c.cardType === 'modifier')
          );
          if (newQueue.length === 0) {
            finalizeRoll(roomCode, modPhase, gameState, () => broadcastRoomUpdate(roomCode));
          } else {
            modPhase.opponentQueue = newQueue;
            modPhase.cardPlayedThisCycle = false;
            updateModifierPhaseGameState(roomCode, modPhase, gameState);
          }
        } else {
          finalizeRoll(roomCode, modPhase, gameState, () => broadcastRoomUpdate(roomCode));
        }
      } else {
        updateModifierPhaseGameState(roomCode, modPhase, gameState);
      }
    }
  }

  if (gameState.status === 'in_progress' && gameState.activePlayerId === playerId) {
    advanceTurn(roomCode, gameState, playerId, true);
  }
  if (gameState.status === 'rolling' && gameState.currentRollerId === playerId) {
    advanceFirstRoll(roomCode, gameState);
  }
  if (gameState.status === 'party_leader_selection') {
    ensureSelectionProgress(roomCode, gameState);
  }
};

// The per-connection handler. Exported so tests can drive it with a fake socket
// (and fake io via setIo) without booting a real server. It resolves the live io
// through getIo() so broadcasts go to whichever server instance is registered.
const handleConnection = (socket: Socket) => {
  const roomCode = (socket.handshake.auth.roomCode as string | undefined)?.toUpperCase();
  const username = (socket.handshake.auth.username as string | undefined)?.trim() || undefined;
  const gameState = getRoomState(roomCode);

  if (!roomCode || !gameState) {
    socket.emit('roomNotFound', 'Room not found or room code missing.');
    socket.disconnect();
    return;
  }

  // Stable identity: the client keeps a UUID in localStorage and sends it on
  // every handshake, so a reconnect (new socket) maps back to the same seat.
  // Clients that don't send one (old builds, tests) fall back to the socket id.
  const rawPlayerId = socket.handshake.auth.playerId;
  const pid = (typeof rawPlayerId === 'string' && rawPlayerId.trim()) || socket.id;

  const isExistingPlayer = !!gameState.players[pid];
  if (!isExistingPlayer && Object.keys(gameState.players).length >= 6) {
    socket.emit('roomFull', 'This room is full (6 players max).');
    socket.disconnect();
    return;
  }

  socket.data.roomCode = roomCode;
  socket.data.playerId = pid;
  socket.join(roomCode);

  // If this seat already has a live socket (second tab, or a reconnect racing
  // the old socket's disconnect), the newest connection wins. Rebind first so
  // the old socket's disconnect handler sees itself superseded and leaves the
  // seat alone.
  const previousSocketId = socketIdForPlayer(roomCode, pid);
  registerPlayerSocket(roomCode, pid, socket.id);
  if (previousSocketId && previousSocketId !== socket.id) {
    getIo().sockets.sockets.get(previousSocketId)?.disconnect();
  }

  const player = gameState.players[pid];
  if (!player) {
    gameState.players[pid] = {
      id: pid,
      username: username ?? nextDefaultUsername(gameState),
      ready: false,
      connected: true,
      actionPoints: 3,
      partyLeaderId: undefined,
      slainMonsters: [],
      zones: {
        hand: [],
        party: [],
      }
    };
    // No-op unless a game is in progress (lobby joins have no session yet).
    logGame(gameState, 'player_joined', { username: gameState.players[pid]?.username }, pid);
  } else {
    const held = cancelSeatRemoval(roomCode, pid);
    const wasDisconnected = player.connected === false;
    player.connected = true;
    if (username) player.username = username;
    if (wasDisconnected) {
      logEvent(gameState, 'system', `${nameOf(gameState, pid)} reconnected.`, { id: pid, username: player.username });
      logGame(gameState, 'player_reconnected', {
        username: player.username,
        ...(held ? { downtimeMs: Date.now() - held.disconnectedAt } : {}),
      }, pid);
    } else if (previousSocketId && previousSocketId !== socket.id) {
      // Same player, new tab — seat handed to the new socket without a gap.
      logGame(gameState, 'player_reconnected', { username: player.username, takeover: true }, pid);
    }
  }

  if (!gameState.activePlayerId) {
    gameState.activePlayerId = pid;
  }

  if (!gameState.lobbyLeaderId) {
    gameState.lobbyLeaderId = pid;
  }

  const sendRoomUpdate = () => {
    const current = getRoomState(roomCode);
    if (!current) return;
    getIo().to(roomCode).emit('stateUpdate', current);
    getIo().to(roomCode).emit('playersUpdated', Object.values(current.players));
  };

  sendRoomUpdate();

  socket.on('sendChat', (message) => {
    const gameState = getRoomState(socket.data.roomCode as string);
    if (!gameState) return;
    const sender = gameState.players[pid];
    if (!sender) return;
    const text = (message ?? '').toString().trim().slice(0, 500);
    if (!text) return;
    logEvent(gameState, 'chat', text, { id: pid, username: sender.username });
    sendRoomUpdate();
  });

  // One report per connection per cooldown window, so a stuck button (or a
  // troll) can't flood the bugs/ prefix.
  const BUG_REPORT_COOLDOWN_MS = 30_000;
  let lastBugReportAt = 0;
  const validBugCategories = new Set<string>(BUG_CATEGORIES.map(c => c.id));

  socket.on('reportBug', (report) => {
    const gameState = getRoomState(socket.data.roomCode as string);
    if (!gameState) return;

    const description = (report?.description ?? '').toString().trim().slice(0, 2000);
    if (!description) {
      socket.emit('bugReportAck', { ok: false, message: 'Please describe the bug before sending.' });
      return;
    }
    const now = Date.now();
    if (now - lastBugReportAt < BUG_REPORT_COOLDOWN_MS) {
      socket.emit('bugReportAck', { ok: false, message: 'Please wait a bit before sending another report.' });
      return;
    }
    lastBugReportAt = now;

    const category: BugCategory = validBugCategories.has(report?.category as string)
      ? report.category
      : 'other';
    const reporter = gameState.players[pid];

    // Everything the player shouldn't have to describe: where the game stood,
    // where in the analytics replay to look, and what just happened on screen.
    void saveBugReport(roomCode, {
      reportedAt: new Date(now).toISOString(),
      roomCode,
      reporter: { id: pid, username: reporter?.username },
      category,
      description,
      client: {
        userAgent: (report?.client?.userAgent ?? '').toString().slice(0, 300),
        viewport: (report?.client?.viewport ?? '').toString().slice(0, 30),
      },
      game: {
        status: gameState.status,
        turnNumber: gameState.turnNumber,
        activePlayerId: gameState.activePlayerId,
        winnerId: gameState.winnerId ?? null,
        pendingChallenge: gameState.pendingChallenge ?? null,
        modifierPhase: gameState.modifierPhase ?? null,
        session: currentSessionInfo(gameState) ?? null,
      },
      recentLog: gameState.gameLog.slice(-20),
    });

    // Also stamp the report into the game's event stream, where it lands with
    // the full board snapshot attached (no-op if no session is active).
    logGame(gameState, 'bug_report', { category, description }, pid);

    socket.emit('bugReportAck', { ok: true, message: 'Thanks — your report was sent.' });
  });

  socket.on('toggleReady', () => {
    const gameState = getRoomState(socket.data.roomCode as string);
    if (!gameState || gameState.status !== 'waiting') return;
    const player = gameState.players[pid];
    if (!player) return;
    player.ready = !player.ready;
    sendRoomUpdate();
  });

  socket.on('startGame', () => {
    const gameState = getRoomState(socket.data.roomCode as string);
    if (!gameState || gameState.status !== 'waiting') {
      return;
    }

    if (Object.keys(gameState.players).length < 2) {
      socket.emit('actionFailed', 'Need at least 2 players to start.');
      return;
    }

    // The lobby leader starts the game, so only everyone else has to ready up.
    const allReady = Object.values(gameState.players)
      .every(p => p.id === gameState.lobbyLeaderId || p.ready);
    if (!allReady) {
      socket.emit('actionFailed', 'All players must be ready before starting.');
      return;
    }

    const { monsterDeck, partyLeaderDeck, mainDeck } = initializeDecks();
    gameState.monsterDeck = monsterDeck;
    gameState.partyLeaderDeck = partyLeaderDeck;
    gameState.mainDeck = mainDeck;
    gameState.discardPile = [];
    gameState.discardedMonsters = [];
    gameState.activeMonsters = drawCards(gameState.monsterDeck, 3) as MonsterInstance[];

    const playerIds = Object.keys(gameState.players);
    for (const playerId of playerIds) {
      const player = gameState.players[playerId];
      if (!player) continue;
      const cards = drawCards(gameState.mainDeck, 5);
      player.zones.hand.push(...cards);
      player.ready = false;
    }

    gameState.status = 'rolling';
    gameState.diceRolls = {};
    gameState.availablePartyLeaderCards = [];
    gameState.partyLeaderSelectionOrder = [];
    gameState.currentSelectionPlayerId = undefined;
    gameState.currentRollerId = playerIds[0] ?? undefined;
    gameState.turnNumber = 0;
    logEvent(gameState, 'system', `${nameOf(gameState, pid)} started the game.`, { id: pid, username: gameState.players[pid]?.username });

    beginGameSession(gameState);
    logGame(gameState, 'game_start', {
      players: Object.values(gameState.players).map(p => ({ id: p.id, username: p.username })),
      lobbyLeaderId: gameState.lobbyLeaderId,
      targetMonstersToWin: gameState.targetMonstersToWin ?? 3,
      activeMonsters: gameState.activeMonsters.map(m => m.templateId),
    }, pid);

    sendRoomUpdate();
  });

  socket.on('drawFromMain', () => {
    const gameState = getRoomState(socket.data.roomCode as string);
    if (!gameState) return;

    if (gameState.status !== 'in_progress') {
      socket.emit('actionFailed', 'Cannot draw now.');
      return;
    }

    const player = gameState.players[pid];
    if (!player) return;

    if (pid !== gameState.activePlayerId) {
      socket.emit('actionFailed', 'Not your turn to draw.');
      return;
    }

    if ((player.actionPoints ?? 0) < 1) {
      socket.emit('actionFailed', 'Not enough AP to draw a card.');
      return;
    }

    if (gameState.mainDeck.length === 0) {
      socket.emit('actionFailed', 'No cards to draw.');
      return;
    }

    const card = drawCardsForPlayer(gameState, player, 1)[0];
    if (!card) return;

    player.actionPoints = (player.actionPoints ?? 0) - 1;
    logEvent(gameState, 'action', `${nameOf(gameState, pid)} drew a card.`, { id: pid, username: player.username });
    logGame(gameState, 'draw_action', { templateId: card.templateId, apRemaining: player.actionPoints }, pid);

    socket.emit('cardDrawn', { instanceId: card.instanceId, templateId: card.templateId });

    sendRoomUpdate();
  });

  socket.on('mulligan', () => {
    const gameState = getRoomState(socket.data.roomCode as string);
    if (!gameState || gameState.status !== 'in_progress') return;
    if (pid !== gameState.activePlayerId) {
      socket.emit('actionFailed', 'Not your turn.');
      return;
    }
    const player = gameState.players[pid];
    if (!player) return;
    if ((player.actionPoints ?? 0) < 3) {
      socket.emit('actionFailed', 'Not enough AP to mulligan (costs 3 AP).');
      return;
    }
    if (gameState.mainDeck.length < 5) {
      socket.emit('actionFailed', 'Not enough cards in the deck to mulligan.');
      return;
    }

    const mulliganDiscarded = player.zones.hand.map(c => c.templateId);
    gameState.discardPile.push(...player.zones.hand);
    player.zones.hand = [];
    drawCardsForPlayer(gameState, player, 5);
    player.actionPoints = (player.actionPoints ?? 0) - 3;
    logEvent(gameState, 'action', `${nameOf(gameState, pid)} mulliganed their hand.`, { id: pid, username: player.username });
    logGame(gameState, 'mulligan', {
      discarded: mulliganDiscarded,
      newHand: player.zones.hand.map(c => c.templateId),
    }, pid);

    sendRoomUpdate();
  });

  socket.on('playHero', (instanceId) => {
    const gameState = getRoomState(socket.data.roomCode as string);
    if (!gameState) return;

    if (gameState.status !== 'in_progress') {
      socket.emit('actionFailed', 'Cannot play hero now.');
      return;
    }

    if (pid !== gameState.activePlayerId) {
      socket.emit('actionFailed', 'Not your turn.');
      return;
    }

    const player = gameState.players[pid];
    if (!player) return;

    if ((player.actionPoints ?? 0) < 1) {
      socket.emit('actionFailed', 'Not enough AP to play a hero.');
      return;
    }

    const cardIndex = player.zones.hand.findIndex((card) => card.instanceId === instanceId);
    if (cardIndex === -1) {
      socket.emit('actionFailed', 'Hero card not found in hand.');
      return;
    }

    const card = player.zones.hand[cardIndex];
    if (!card || card.cardType !== 'hero') {
      socket.emit('actionFailed', 'Only hero cards can be played to your party.');
      return;
    }

    const playedCards = player.zones.hand.splice(cardIndex, 1);
    const playedCard = playedCards[0];
    if (!playedCard) {
      socket.emit('actionFailed', 'Failed to play hero card.');
      return;
    }

    player.actionPoints = (player.actionPoints ?? 0) - 1;
    logEvent(gameState, 'action', `${nameOf(gameState, pid)} played ${gameState.cardTemplates[playedCard.templateId]?.name ?? 'a hero'}.`, { id: pid, username: player.username });

    const roomCode = socket.data.roomCode as string;
    const eligibleChallengerIds = getEligibleChallengerIds(gameState, pid);
    logGame(gameState, 'hero_played', {
      templateId: playedCard.templateId,
      challengeWindowOpened: eligibleChallengerIds.length > 0,
      eligibleChallengerIds,
    }, pid);

    if (eligibleChallengerIds.length > 0) {
      openChallengeWindow(roomCode, gameState, {
        pendingCardInstance: playedCard,
        pendingPlayerId: pid,
        pendingCardType: 'hero',
        eligibleChallengerIds,
        passedPlayerIds: new Set(),
        challengerRollBonus: 0,
      });
    } else {
      player.zones.party.push(playedCard);
      applyWinIfMet(gameState, player, pid);
      markHeroPlayedFromAbility(roomCode, playedCard.instanceId);
      socket.emit('heroPlayAccepted', playedCard.instanceId);
    }

    sendRoomUpdate();
  });

  socket.on('playMagic', (cardInstanceId) => {
    const gameState = getRoomState(socket.data.roomCode as string);
    if (!gameState || gameState.status !== 'in_progress') {
      socket.emit('actionFailed', 'Cannot play a magic card now.');
      return;
    }
    if (pid !== gameState.activePlayerId) {
      socket.emit('actionFailed', 'Not your turn.');
      return;
    }
    const player = gameState.players[pid];
    if (!player) return;
    if ((player.actionPoints ?? 0) < 1) {
      socket.emit('actionFailed', 'Not enough AP to play a magic card.');
      return;
    }
    const cardIndex = player.zones.hand.findIndex(c => c.instanceId === cardInstanceId);
    if (cardIndex === -1) {
      socket.emit('actionFailed', 'Magic card not found in hand.');
      return;
    }
    const card = player.zones.hand[cardIndex];
    if (!card || card.cardType !== 'magic') {
      socket.emit('actionFailed', 'Selected card is not a magic card.');
      return;
    }
    const template = gameState.cardTemplates[card.templateId];
    if (!template?.effect) {
      socket.emit('actionFailed', 'This magic card has no effect defined.');
      return;
    }
    player.actionPoints = (player.actionPoints ?? 0) - 1;
    const [removedMagicCard] = player.zones.hand.splice(cardIndex, 1);
    if (!removedMagicCard) { sendRoomUpdate(); return; }
    logEvent(gameState, 'action', `${nameOf(gameState, pid)} played ${template.name ?? 'a magic card'}.`, { id: pid, username: player.username });

    const magicRoomCode = socket.data.roomCode as string;
    const steps: Effect[] = template.effect.steps ?? [template.effect as unknown as Effect];
    const magicEligibleIds = getEligibleChallengerIds(gameState, pid);
    logGame(gameState, 'magic_played', {
      templateId: removedMagicCard.templateId,
      challengeWindowOpened: magicEligibleIds.length > 0,
      eligibleChallengerIds: magicEligibleIds,
    }, pid);

    if (magicEligibleIds.length > 0) {
      openChallengeWindow(magicRoomCode, gameState, {
        pendingCardInstance: removedMagicCard,
        pendingPlayerId: pid,
        pendingCardType: 'magic',
        magicSteps: steps,
        eligibleChallengerIds: magicEligibleIds,
        passedPlayerIds: new Set(),
        challengerRollBonus: 0,
      });
    } else {
      gameState.discardPile.push(removedMagicCard);
      processMagicCardSteps(socket, gameState, player, removedMagicCard.instanceId, steps, undefined, true);
    }

    sendRoomUpdate();
  });

  socket.on('playItem', (itemInstanceId, targetHeroInstanceId) => {
    const gameState = getRoomState(socket.data.roomCode as string);
    if (!gameState) return;

    if (gameState.status !== 'in_progress') {
      socket.emit('actionFailed', 'Cannot play item now.');
      return;
    }

    if (pid !== gameState.activePlayerId) {
      socket.emit('actionFailed', 'Not your turn.');
      return;
    }

    const player = gameState.players[pid];
    if (!player) return;

    if ((player.actionPoints ?? 0) < 1) {
      socket.emit('actionFailed', 'Not enough AP to play an item.');
      return;
    }

    const itemIndex = player.zones.hand.findIndex((card) => card.instanceId === itemInstanceId);
    if (itemIndex === -1) {
      socket.emit('actionFailed', 'Item not found in hand.');
      return;
    }

    const itemCard = player.zones.hand[itemIndex];
    if (!itemCard || itemCard.cardType !== 'item') {
      socket.emit('actionFailed', 'Only item cards can be equipped to heroes.');
      return;
    }

    const itemTemplate = gameState.cardTemplates[itemCard.templateId];
    if ((itemTemplate?.subtype as string | undefined)?.toLowerCase() === 'cursed') {
      socket.emit('actionFailed', 'Cursed items must be played on opponents using the cursed item flow.');
      return;
    }

    const targetHero = player.zones.party.find((card) => card.instanceId === targetHeroInstanceId);
    if (!targetHero) {
      socket.emit('actionFailed', 'Target hero not found in your party.');
      return;
    }

    if (targetHero.equippedItem) {
      socket.emit('actionFailed', 'That hero already has an equipped item.');
      return;
    }

    const [removedItem] = player.zones.hand.splice(itemIndex, 1);
    if (!removedItem) {
      socket.emit('actionFailed', 'Failed to remove item from hand.');
      return;
    }

    player.actionPoints = (player.actionPoints ?? 0) - 1;
    logEvent(gameState, 'action', `${nameOf(gameState, pid)} equipped ${itemTemplate?.name ?? 'an item'} to ${gameState.cardTemplates[targetHero.templateId]?.name ?? 'a hero'}.`, { id: pid, username: player.username });

    const itemRoomCode = socket.data.roomCode as string;
    const itemEligibleIds = playerHasSlainEffectFlag(gameState, player, 'blockItemChallenges')
      ? []
      : getEligibleChallengerIds(gameState, pid);
    logGame(gameState, 'item_played', {
      templateId: removedItem.templateId,
      targetHeroTemplateId: targetHero.templateId,
      challengeWindowOpened: itemEligibleIds.length > 0,
      eligibleChallengerIds: itemEligibleIds,
    }, pid);

    if (itemEligibleIds.length > 0) {
      openChallengeWindow(itemRoomCode, gameState, {
        pendingCardInstance: removedItem,
        pendingPlayerId: pid,
        pendingCardType: 'item',
        itemTargetPlayerId: pid,
        itemTargetHeroInstanceId: targetHeroInstanceId,
        eligibleChallengerIds: itemEligibleIds,
        passedPlayerIds: new Set(),
        challengerRollBonus: 0,
      });
    } else {
      player.zones.party.push(removedItem);
      targetHero.equippedItem = removedItem.instanceId;
    }

    sendRoomUpdate();
  });

  socket.on('playCursedItem', (itemInstanceId, targetPlayerId, targetHeroInstanceId) => {
    const gameState = getRoomState(socket.data.roomCode as string);
    if (!gameState) return;

    if (gameState.status !== 'in_progress') {
      socket.emit('actionFailed', 'Cannot play cursed item now.');
      return;
    }

    if (pid !== gameState.activePlayerId) {
      socket.emit('actionFailed', 'Not your turn.');
      return;
    }

    if (pid === targetPlayerId) {
      socket.emit('actionFailed', 'Cannot play cursed item on your own heroes.');
      return;
    }

    const player = gameState.players[pid];
    if (!player) return;

    const targetPlayer = gameState.players[targetPlayerId];
    if (!targetPlayer) {
      socket.emit('actionFailed', 'Target player not found.');
      return;
    }

    if ((player.actionPoints ?? 0) < 1) {
      socket.emit('actionFailed', 'Not enough AP to play a cursed item.');
      return;
    }

    const itemIndex = player.zones.hand.findIndex((card) => card.instanceId === itemInstanceId);
    if (itemIndex === -1) {
      socket.emit('actionFailed', 'Cursed item not found in hand.');
      return;
    }

    const itemCard = player.zones.hand[itemIndex];
    if (!itemCard || itemCard.cardType !== 'item') {
      socket.emit('actionFailed', 'Only item cards can be equipped to heroes.');
      return;
    }

    const itemTemplate = gameState.cardTemplates[itemCard.templateId];
    if ((itemTemplate?.subtype as string | undefined)?.toLowerCase() !== 'cursed') {
      socket.emit('actionFailed', 'Only cursed items can be played on opponent heroes.');
      return;
    }

    const targetHero = targetPlayer.zones.party.find((card) => card.instanceId === targetHeroInstanceId);
    if (!targetHero) {
      socket.emit('actionFailed', 'Target hero not found in opponent\'s party.');
      return;
    }

    if (targetHero.equippedItem) {
      socket.emit('actionFailed', 'That hero already has an equipped item.');
      return;
    }

    const [removedCursedItem] = player.zones.hand.splice(itemIndex, 1);
    if (!removedCursedItem) {
      socket.emit('actionFailed', 'Failed to remove cursed item from hand.');
      return;
    }

    player.actionPoints = (player.actionPoints ?? 0) - 1;

    const cursedRoomCode = socket.data.roomCode as string;
    const cursedEligibleIds = playerHasSlainEffectFlag(gameState, player, 'blockItemChallenges')
      ? []
      : getEligibleChallengerIds(gameState, pid);
    logGame(gameState, 'cursed_item_played', {
      templateId: removedCursedItem.templateId,
      targetPlayerId,
      targetHeroTemplateId: targetHero.templateId,
      challengeWindowOpened: cursedEligibleIds.length > 0,
      eligibleChallengerIds: cursedEligibleIds,
    }, pid);

    if (cursedEligibleIds.length > 0) {
      openChallengeWindow(cursedRoomCode, gameState, {
        pendingCardInstance: removedCursedItem,
        pendingPlayerId: pid,
        pendingCardType: 'item',
        itemTargetPlayerId: targetPlayerId,
        itemTargetHeroInstanceId: targetHeroInstanceId,
        eligibleChallengerIds: cursedEligibleIds,
        passedPlayerIds: new Set(),
        challengerRollBonus: 0,
      });
    } else {
      targetPlayer.zones.party.push(removedCursedItem);
      targetHero.equippedItem = removedCursedItem.instanceId;
    }

    sendRoomUpdate();
  });

  socket.on('playChallenge', (challengeCardInstanceId) => {
    const gameState = getRoomState(socket.data.roomCode as string);
    const roomCode = socket.data.roomCode as string;
    if (!gameState) return;

    const pending = pendingChallenges.get(roomCode);
    if (!pending) {
      socket.emit('actionFailed', 'No active challenge window.');
      return;
    }
    if (pending.challengerId) {
      socket.emit('actionFailed', 'This card play has already been challenged.');
      return;
    }
    if (!pending.eligibleChallengerIds.includes(pid) || pending.passedPlayerIds.has(pid)) {
      socket.emit('actionFailed', 'You are not eligible to challenge.');
      return;
    }

    const player = gameState.players[pid];
    if (!player) return;

    const challengeCard = player.zones.hand.find(
      c => c.instanceId === challengeCardInstanceId && c.cardType === 'challenge'
    );
    if (!challengeCard) {
      socket.emit('actionFailed', 'Challenge card not found in hand.');
      return;
    }

    const template = gameState.cardTemplates[challengeCard.templateId];
    const req = template?.onEvent?.requirement;
    if (req?.cardType === 'hero' && req.class && req.eligibility === 'self') {
      const hasClass = player.zones.party.some(
        partyCard => getHeroEffectiveClass(gameState, player, partyCard) === req.class
      );
      if (!hasClass) {
        socket.emit('actionFailed', `You need a ${req.class} hero in your party to play this challenge card.`);
        return;
      }
    }

    pending.challengerId = pid;
    pending.challengeCardInstanceId = challengeCardInstanceId;
    pending.challengerRollBonus = getChallengeCardBonus(template);
    logGame(gameState, 'challenge_played', {
      challengeCardTemplateId: challengeCard.templateId,
      challengerBonus: pending.challengerRollBonus,
      againstPlayerId: pending.pendingPlayerId,
      againstCardTemplateId: pending.pendingCardInstance.templateId,
      againstCardType: pending.pendingCardType,
    }, pid);

    const gsPending = gameState.pendingChallenge;
    if (gsPending) gsPending.challengerId = pid;

    const challengedPlayerId = pending.pendingPlayerId;
    resolveChallengeRollOff(roomCode, pending, gameState, sendRoomUpdate);

    // m_009 Bloodwing: if the challenged player has slain a Bloodwing, the
    // challenger must DISCARD a card (resolved after the challenge card is spent).
    const challengedPlayer = gameState.players[challengedPlayerId];
    if (
      challengedPlayer &&
      playerHasSlainEffectAction(gameState, challengedPlayer, 'FORCE_CHALLENGER_DISCARD') &&
      player.zones.hand.length > 0
    ) {
      const opts = player.zones.hand.map(c => ({
        id: c.instanceId,
        label: gameState.cardTemplates[c.templateId]?.name || c.templateId,
        payload: { cardInstanceId: c.instanceId },
      }));
      emitAbilityPrompt(pid, {
        promptId: buildPromptId(),
        roomCode,
        heroInstanceId: '',
        sourcePlayerId: pid,
        promptType: 'discardCard',
        message: 'Bloodwing: you challenged its owner — discard a card.',
        options: opts,
        effect: { action: 'SLAIN_FORCE_DISCARD' },
        remainingEffects: [],
        isSlainPassive: true,
      });
      sendRoomUpdate();
    }
  });

  socket.on('passChallenge', () => {
    const gameState = getRoomState(socket.data.roomCode as string);
    const roomCode = socket.data.roomCode as string;
    if (!gameState) return;

    const pending = pendingChallenges.get(roomCode);
    if (!pending || pending.challengerId) return;
    if (!pending.eligibleChallengerIds.includes(pid) || pending.passedPlayerIds.has(pid)) return;

    pending.passedPlayerIds.add(pid);
    const remaining = pending.eligibleChallengerIds.filter(id => !pending.passedPlayerIds.has(id));
    logGame(gameState, 'challenge_passed', {
      againstCardTemplateId: pending.pendingCardInstance.templateId,
      remainingEligible: remaining,
      resolvedUnchallenged: remaining.length === 0,
    }, pid);

    if (remaining.length === 0) {
      executePendingCardPlay(roomCode, pending, gameState);
      pendingChallenges.delete(roomCode);
      delete gameState.pendingChallenge;
    } else {
      const gsPending = gameState.pendingChallenge;
      if (gsPending) gsPending.eligibleChallengerIds = remaining;
    }

    sendRoomUpdate();
  });

  socket.on('playModifier', (modifierInstanceId, choiceIndex) => {
    const roomCode = socket.data.roomCode as string;
    const gameState = getRoomState(roomCode);
    if (!gameState) return;

    if (pendingChallenges.has(roomCode)) {
      socket.emit('actionFailed', 'Cannot play a modifier during a challenge window.');
      return;
    }

    const phase = modifierPhases.get(roomCode);
    if (!phase) {
      socket.emit('actionFailed', 'No active modifier phase.');
      return;
    }

    const isRollerTurn = phase.phase === 'roller_turn' && pid === phase.rollingPlayerId;
    const isOpponentTurn = phase.phase === 'opponent_turn' && phase.opponentQueue[0] === pid;
    if (!isRollerTurn && !isOpponentTurn) {
      socket.emit('actionFailed', 'It is not your turn to play a modifier.');
      return;
    }

    // h_002 Shadow Saint: no player other than the active player may play
    // Modifier cards until the end of the active player's turn.
    if (gameState.roomFlags?.lockModifiers && pid !== gameState.activePlayerId) {
      socket.emit('actionFailed', 'Modifier cards are locked for other players this turn.');
      return;
    }

    const player = gameState.players[pid];
    if (!player) return;

    const cardIndex = player.zones.hand.findIndex(c => c.instanceId === modifierInstanceId && c.cardType === 'modifier');
    if (cardIndex === -1) {
      socket.emit('actionFailed', 'Modifier card not found in hand.');
      return;
    }

    const [card] = player.zones.hand.splice(cardIndex, 1);
    if (!card) return;
    gameState.discardPile.push(card);

    const template = gameState.cardTemplates[card.templateId];
    const amount = getModifierAmount(template, choiceIndex, phase.rollContext);
    const choiceLabel = getModifierChoiceLabel(template, choiceIndex, phase.rollContext);
    phase.accumulatedModifier += amount;
    // mod_007 "DISCARD your hand, +7": the player discards the rest of their hand.
    if (modifierDiscardsHand(template, choiceIndex, phase.rollContext) && player.zones.hand.length > 0) {
      gameState.discardPile.push(...player.zones.hand);
      player.zones.hand = [];
    }
    // p_004 Protecting Horn: +1 (or -1 matching direction) when THIS player plays a modifier
    if (amount !== 0 && player.partyLeaderId) {
      const plTemplate = gameState.cardTemplates[player.partyLeaderId];
      if (plTemplate?.effect?.triggerEvent === 'ON_MODIFIER_PLAYED') {
        phase.accumulatedModifier += amount > 0 ? 1 : -1;
      }
    }
    // m_017 Abyss Queen: when an OPPONENT plays a modifier on the roller's roll,
    // the roller gains a flat bonus to that roll.
    if (pid !== phase.rollingPlayerId) {
      const roller = gameState.players[phase.rollingPlayerId];
      if (roller) phase.accumulatedModifier += getSlainOpponentModifierBonus(gameState, roller);
    }

    phase.modifiersPlayed.push({
      playerName: player.username ?? pid,
      cardName: template?.name ?? card.templateId,
      amount,
      choiceLabel,
    });
    logGame(gameState, 'modifier_played', {
      templateId: card.templateId,
      amount,
      choiceLabel,
      rollContext: phase.rollContext,
      rollingPlayerId: phase.rollingPlayerId,
      newTotal: phase.rawDiceTotal + phase.persistentBonus + phase.accumulatedModifier,
      requiredRoll: phase.requiredRoll,
    }, pid);

    // m_006 Crowned Serpent: each time ANY player plays a modifier, every player
    // who has slain a Crowned Serpent may draw a card.
    for (const pid of Object.keys(gameState.players)) {
      triggerSlainMonsterPassive(gameState, pid, 'ON_MODIFIER_PLAYED_ANY');
    }

    if (phase.phase === 'opponent_turn') phase.cardPlayedThisCycle = true;

    if (phase.phase === 'roller_turn') {
      const newTotal = phase.rawDiceTotal + phase.persistentBonus + phase.accumulatedModifier;
      if (newTotal >= phase.requiredRoll) {
        phase.phase = 'opponent_turn';
        phase.opponentQueue = phase.allOpponentsWithModifiers.filter(
          pid => gameState.players[pid]?.zones.hand.some(c => c.cardType === 'modifier')
        );
        phase.cardPlayedThisCycle = false;
        if (phase.opponentQueue.length === 0) {
          finalizeRoll(roomCode, phase, gameState, sendRoomUpdate);
          return;
        }
      }
    }

    updateModifierPhaseGameState(roomCode, phase, gameState);
    sendRoomUpdate();
  });

  socket.on('passModifier', () => {
    const roomCode = socket.data.roomCode as string;
    const gameState = getRoomState(roomCode);
    if (!gameState) return;

    const phase = modifierPhases.get(roomCode);
    if (!phase) {
      socket.emit('actionFailed', 'No active modifier phase.');
      return;
    }

    const isRollerTurn = phase.phase === 'roller_turn' && pid === phase.rollingPlayerId;
    const isOpponentTurn = phase.phase === 'opponent_turn' && phase.opponentQueue[0] === pid;
    if (!isRollerTurn && !isOpponentTurn) {
      socket.emit('actionFailed', 'It is not your turn to pass.');
      return;
    }

    logGame(gameState, 'modifier_passed', {
      rollContext: phase.rollContext,
      rollingPlayerId: phase.rollingPlayerId,
      phaseStage: phase.phase,
      currentTotal: phase.rawDiceTotal + phase.persistentBonus + phase.accumulatedModifier,
      requiredRoll: phase.requiredRoll,
    }, pid);

    if (phase.phase === 'roller_turn') {
      phase.phase = 'opponent_turn';
      phase.opponentQueue = phase.allOpponentsWithModifiers.filter(
        pid => gameState.players[pid]?.zones.hand.some(c => c.cardType === 'modifier')
      );
      phase.cardPlayedThisCycle = false;
      if (phase.opponentQueue.length === 0) {
        finalizeRoll(roomCode, phase, gameState, sendRoomUpdate);
        return;
      }
      updateModifierPhaseGameState(roomCode, phase, gameState);
      sendRoomUpdate();
      return;
    }

    advanceModifierQueue(roomCode, phase, gameState, sendRoomUpdate);
  });

  socket.on('usePartyLeaderAbility', () => {
    const roomCode = socket.data.roomCode as string;
    const gameState = getRoomState(roomCode);
    if (!gameState || gameState.status !== 'in_progress') return;
    if (pid !== gameState.activePlayerId) {
      socket.emit('actionFailed', 'Not your turn.');
      return;
    }
    if (pendingChallenges.has(roomCode) || modifierPhases.has(roomCode)) {
      socket.emit('actionFailed', 'Cannot use party leader ability during an active roll or challenge.');
      return;
    }

    const player = gameState.players[pid];
    if (!player) return;

    const partyLeaderCard = player.zones.party.find(c => c.cardType === 'party_leader');
    if (!partyLeaderCard) {
      socket.emit('actionFailed', 'No party leader in play.');
      return;
    }
    if (partyLeaderCard.effectUsedThisTurn) {
      socket.emit('actionFailed', 'Party leader ability already used this turn.');
      return;
    }

    const template = gameState.cardTemplates[partyLeaderCard.templateId];
    if (!template?.effect?.isOptional) {
      socket.emit('actionFailed', 'This party leader ability triggers automatically.');
      return;
    }

    const apCost = typeof template.effect.apCost === 'number' ? template.effect.apCost : 0;
    if (apCost > 0 && (player.actionPoints ?? 0) < apCost) {
      socket.emit('actionFailed', `Not enough AP (costs ${apCost} AP).`);
      return;
    }
    if (apCost > 0) {
      player.actionPoints = (player.actionPoints ?? 0) - apCost;
    }

    if (template.effect.action === 'STEAL_CARD') {
      const opponents = Object.entries(gameState.players).filter(
        ([id, p]) => id !== pid && p.zones.hand.length > 0
      );
      if (opponents.length === 0) {
        player.actionPoints = (player.actionPoints ?? 0) + apCost;
        socket.emit('actionFailed', 'No opponents have cards to steal.');
        return;
      }
      const options: AbilityPromptOption[] = opponents.map(([id, p]) => ({
        id: `player_${id}`,
        label: `${p.username ?? id} (${p.zones.hand.length} card${p.zones.hand.length !== 1 ? 's' : ''})`,
        payload: { playerId: id },
      }));
      logGame(gameState, 'party_leader_ability_used', { action: 'STEAL_CARD', apCost }, pid);
      emitAbilityPrompt(pid, {
        promptId: buildPromptId(),
        roomCode,
        heroInstanceId: partyLeaderCard.instanceId,
        sourcePlayerId: pid,
        promptType: 'selectPlayer',
        message: 'Choose an opponent to steal a card from.',
        options,
        effect: { action: 'STEAL_CARD' },
        remainingEffects: [],
        isPartyLeaderAbility: true,
      });
    } else if (template.effect.action === 'SEARCH_DISCARD') {
      if (gameState.discardPile.length === 0) {
        player.actionPoints = (player.actionPoints ?? 0) + apCost;
        socket.emit('actionFailed', 'The discard pile is empty.');
        return;
      }
      const options: AbilityPromptOption[] = gameState.discardPile.map((card) => {
        const t = gameState.cardTemplates[card.templateId];
        return {
          id: card.instanceId,
          label: t?.name ?? card.templateId,
          payload: { cardInstanceId: card.instanceId },
        };
      });
      logGame(gameState, 'party_leader_ability_used', { action: 'SEARCH_DISCARD', apCost }, pid);
      emitAbilityPrompt(pid, {
        promptId: buildPromptId(),
        roomCode,
        heroInstanceId: partyLeaderCard.instanceId,
        sourcePlayerId: pid,
        promptType: 'selectCard',
        message: 'Choose a card from the discard pile to add to your hand.',
        options,
        effect: { action: 'SEARCH_DISCARD' },
        remainingEffects: [],
        isPartyLeaderAbility: true,
      });
    }
    sendRoomUpdate();
  });

  socket.on('attackMonster', (monsterInstanceId) => {
    const roomCode = socket.data.roomCode as string;
    const gameState = getRoomState(roomCode);
    if (!gameState || gameState.status !== 'in_progress') return;

    if (pid !== gameState.activePlayerId) {
      socket.emit('actionFailed', 'Not your turn.');
      return;
    }

    if (pendingChallenges.has(roomCode) || modifierPhases.has(roomCode)) {
      socket.emit('actionFailed', 'Cannot attack while another action is pending.');
      return;
    }

    const player = gameState.players[pid];
    if (!player) return;

    if ((player.actionPoints ?? 0) < 2) {
      socket.emit('actionFailed', 'Not enough AP to attack a monster (costs 2 AP).');
      return;
    }

    const monster = gameState.activeMonsters.find(m => m.instanceId === monsterInstanceId);
    if (!monster) {
      socket.emit('actionFailed', 'Monster not found.');
      return;
    }

    const monsterTemplate = gameState.cardTemplates[monster.templateId];
    const reqCheck = checkMonsterRequirements(gameState, player, monsterTemplate);
    if (!reqCheck.met) {
      socket.emit('actionFailed', `Requirements not met: ${reqCheck.missing}`);
      return;
    }
    if (!monsterTemplate) {
      socket.emit('actionFailed', 'Monster template not found.');
      return;
    }

    player.actionPoints = (player.actionPoints ?? 0) - 2;
    logEvent(gameState, 'action', `${nameOf(gameState, pid)} is attacking ${monsterTemplate.name ?? 'a monster'}.`, { id: pid, username: player.username });
    logGame(gameState, 'monster_attack_started', {
      monsterTemplateId: monster.templateId,
      apRemaining: player.actionPoints,
    }, pid);
    executeMonsterAttackRoll(roomCode, socket, gameState, player, monster, monsterTemplate, sendRoomUpdate);
  });

  socket.on('rollHeroAbility', (heroInstanceId) => {
    const gameState = getRoomState(socket.data.roomCode as string);
    if (!gameState) return;

    if (gameState.status !== 'in_progress') {
      socket.emit('actionFailed', 'Cannot roll hero ability now.');
      return;
    }

    if (pid !== gameState.activePlayerId) {
      socket.emit('actionFailed', 'Not your turn.');
      return;
    }

    const player = gameState.players[pid];
    if (!player) return;

    const hero = player.zones.party.find((card) => card.instanceId === heroInstanceId);
    if (!hero || hero.cardType !== 'hero') {
      socket.emit('actionFailed', 'Hero not found in your party.');
      return;
    }

    if (hero.effectUsedThisTurn) {
      socket.emit('actionFailed', 'This hero ability has already been used this turn.');
      return;
    }

    const playedFromAbility = heroesPlayedFromAbilityThisTurn.get(socket.data.roomCode as string)?.has(heroInstanceId) ?? false;
    if (!playedFromAbility) {
      if ((player.actionPoints ?? 0) < 1) {
        socket.emit('actionFailed', 'Not enough AP to use a hero ability.');
        return;
      }
      player.actionPoints = (player.actionPoints ?? 0) - 1;
    }

    let preRollBonus = 0;
    const equippedItemId = hero.equippedItem;
    if (equippedItemId) {
      const itemInstance = player.zones.party.find(c => c.instanceId === equippedItemId);
      if (itemInstance) {
        const itemTemplate = gameState.cardTemplates[itemInstance.templateId];

        const passives = itemTemplate?.passiveModifiers;
        if (passives?.some(p => p.stat === 'heroEffectLocked')) {
          if (!playedFromAbility) player.actionPoints = (player.actionPoints ?? 0) + 1;
          socket.emit('actionFailed', 'This hero\'s effect is locked by an equipped item.');
          sendRoomUpdate();
          return;
        }

        // ci_005 Soulbound Grimoire: rolling this hero's effect costs a fixed total
        // of AP (default 2). Charge the difference beyond the base cost already paid.
        const rollCostPassive = passives?.find(p => p.stat === 'rollCostAP');
        if (rollCostPassive) {
          const totalCost = typeof rollCostPassive.value === 'number' ? rollCostPassive.value : 2;
          const alreadyPaid = playedFromAbility ? 0 : 1;
          const extra = totalCost - alreadyPaid;
          if (extra > 0) {
            if ((player.actionPoints ?? 0) < extra) {
              if (!playedFromAbility) player.actionPoints = (player.actionPoints ?? 0) + 1; // refund base
              socket.emit('actionFailed', `Rolling this hero's effect costs ${totalCost} AP (cursed item).`);
              sendRoomUpdate();
              return;
            }
            player.actionPoints = (player.actionPoints ?? 0) - extra;
          }
        }

        const itemTrigger = itemTemplate?.trigger;
        if (itemTrigger?.event === 'ON_HERO_ROLL_ATTEMPT' && itemTrigger.scope === 'equipped_hero') {
          const modifyEffect = itemTrigger.effects.find(e => e.action === 'MODIFY_ROLL');
          if (modifyEffect) {
            if (!itemTrigger.optional) {
              preRollBonus += modifyEffect.amount ?? 0;
            } else {
              const maxDiscard = (itemTrigger.cost?.[0]?.max as number | undefined) ?? 3;
              const minDiscard = (itemTrigger.cost?.[0]?.min as number | undefined) ?? 0;
              const bonusPerCard = modifyEffect.amount ?? 0;
              const availableMax = Math.min(maxDiscard, player.zones.hand.length);
              if (availableMax < 1) {
                // Nothing to discard — just roll with no bonus.
                executeRollAndEmit(socket, gameState, player, hero, 0, sendRoomUpdate);
                return;
              }
              const cardOptions: AbilityPromptOption[] = player.zones.hand.map(c => ({
                id: c.instanceId,
                label: gameState.cardTemplates[c.templateId]?.name || c.templateId,
                payload: { cardInstanceId: c.instanceId },
              }));
              emitAbilityPrompt(pid, {
                promptId: buildPromptId(),
                roomCode: socket.data.roomCode as string,
                heroInstanceId: hero.instanceId,
                sourcePlayerId: pid,
                promptType: 'multiSelectCard',
                message: `${itemTemplate?.name ?? itemInstance.templateId}: select up to ${availableMax} card${availableMax > 1 ? 's' : ''} to discard for +${bonusPerCard} each, then confirm.`,
                options: cardOptions,
                minSelections: minDiscard,
                maxSelections: availableMax,
                effect: { action: 'ITEM_I004_DISCARD_SELECT', bonusPerCard },
                remainingEffects: [],
                isItemTrigger: true,
                itemInstanceId: itemInstance.instanceId,
              });
              sendRoomUpdate();
              return;
            }
          }
        }
      }
    }

    executeRollAndEmit(socket, gameState, player, hero, preRollBonus, sendRoomUpdate);
  });

  socket.on('activateHeroAbility', (heroInstanceId) => {
    const gameState = getRoomState(socket.data.roomCode as string);
    if (!gameState || gameState.status !== 'in_progress') return;
    if (pid !== gameState.activePlayerId) {
      socket.emit('actionFailed', 'Not your turn.');
      return;
    }
    const player = gameState.players[pid];
    if (!player) return;

    activateHeroAbility(socket, gameState, heroInstanceId, sendRoomUpdate);
  });

  // Logged before handling so the snapshot shows the pre-resolution board; the
  // effect's outcome is visible in the next event's snapshot.
  const logPromptResponse = (promptId: string, selectedOptionIds: string[]) => {
    const gameState = getRoomState(socket.data.roomCode as string);
    const prompt = abilityPromptRequests.get(promptId);
    if (!gameState || !prompt) return;
    logGame(gameState, 'prompt_response', {
      promptType: prompt.promptType,
      message: prompt.message,
      effectAction: prompt.effect.action,
      selected: selectedOptionIds.map(id => prompt.options.find(o => o.id === id)?.label ?? id),
      selectedOptionIds,
    }, pid);
  };

  socket.on('respondToAbilityPrompt', (promptId, selectedOptionId) => {
    logPromptResponse(promptId, [selectedOptionId]);
    handlePromptResponse(socket, promptId, selectedOptionId, sendRoomUpdate);
  });

  socket.on('respondToAbilityPromptMulti', (promptId, selectedOptionIds) => {
    logPromptResponse(promptId, selectedOptionIds);
    handleMultiPromptResponse(socket, promptId, selectedOptionIds, sendRoomUpdate);
  });

  socket.on('rollForFirst', () => {
    const gameState = getRoomState(socket.data.roomCode as string);
    if (!gameState || gameState.status !== 'rolling' || !gameState.currentRollerId) {
      return;
    }

    if (pid !== gameState.currentRollerId) {
      return;
    }

      const player = gameState.players[pid];
      if (!player) return;

    const die1 = Math.floor(Math.random() * 6) + 1;
    const die2 = Math.floor(Math.random() * 6) + 1;
    const total = die1 + die2;

    // Initial "roll for first" should not include any temporary roll bonuses.
    gameState.diceRolls[pid] = total;
    logGame(gameState, 'turn_order_roll', { die1, die2, total }, pid);

    advanceFirstRoll(socket.data.roomCode as string, gameState);

    sendRoomUpdate();
  });

  socket.on('continueGame', () => {
    const gameState = getRoomState(socket.data.roomCode as string);
    if (!gameState) return;

    if (gameState.status !== 'roll_complete' && gameState.status !== 'party_leader_review') {
      return;
    }

    if (pid !== gameState.lobbyLeaderId) {
      return;
    }

    // Manual continue skips whatever remains of the auto-advance countdown.
    clearAutoAdvance(socket.data.roomCode as string, gameState);

    if (gameState.status === 'roll_complete') {
      beginPartyLeaderSelection(gameState);
    } else {
      beginInProgress(gameState);
    }

    sendRoomUpdate();
  });

  socket.on('endTurn', () => {
    const gameState = getRoomState(socket.data.roomCode as string);
    if (!gameState || gameState.status !== 'in_progress') return;
    if (pid !== gameState.activePlayerId) return;
    if (pendingChallenges.has(socket.data.roomCode as string)) {
      socket.emit('actionFailed', 'Cannot end turn while a challenge is pending.');
      return;
    }
    if (modifierPhases.has(socket.data.roomCode as string)) {
      socket.emit('actionFailed', 'Cannot end turn during a modifier phase.');
      return;
    }

    advanceTurn(socket.data.roomCode as string, gameState, pid, false);

    sendRoomUpdate();
  });

  socket.on('choosePartyLeader', (instanceId) => {
    const gameState = getRoomState(socket.data.roomCode as string);
    if (!gameState || gameState.status !== 'party_leader_selection') {
      return;
    }

    if (pid !== gameState.currentSelectionPlayerId) {
      return;
    }

    const cardIndex = gameState.availablePartyLeaderCards.findIndex(
      (card) => card.instanceId === instanceId
    );

    if (cardIndex === -1) {
      return;
    }

    const chosenCard = gameState.availablePartyLeaderCards.splice(cardIndex, 1)[0];
    if (!chosenCard) {
      return;
    }
    const player = gameState.players[pid];
    if (!player) {
      return;
    }

    player.zones.party = [chosenCard];
    player.partyLeaderId = chosenCard.templateId;
    logEvent(gameState, 'system', `${nameOf(gameState, pid)} chose ${gameState.cardTemplates[chosenCard.templateId]?.name ?? 'a party leader'} as their party leader.`, { id: pid, username: player.username });
    logGame(gameState, 'party_leader_chosen', {
      templateId: chosenCard.templateId,
      remainingChoices: gameState.availablePartyLeaderCards.map(c => c.templateId),
    }, pid);

    advanceLeaderSelection(socket.data.roomCode as string, gameState);
    // The next picker may be a held (disconnected) seat — auto-pick for them.
    ensureSelectionProgress(socket.data.roomCode as string, gameState);

    sendRoomUpdate();
  });

  socket.on('quitGame', () => {
    const gameState = getRoomState(socket.data.roomCode as string);
    if (!gameState) return;

    // Close the analytics session while the final board is still intact.
    void endGameSession(gameState, 'reset', { resetBy: pid });

    gameState.status = 'waiting';
    gameState.activePlayerId = gameState.lobbyLeaderId || '';
    gameState.turnNumber = 0;
    gameState.phase = 'DRAW';
    gameState.stack = [];
    gameState.monsterDeck = [];
    gameState.partyLeaderDeck = [];
    gameState.mainDeck = [];
    gameState.activeMonsters = [];
    gameState.discardedMonsters = [];
    gameState.discardPile = [];
    gameState.diceRolls = {};
    clearAutoAdvance(socket.data.roomCode as string, gameState);
    pendingChallenges.delete(socket.data.roomCode as string);
    delete gameState.pendingChallenge;
    modifierPhases.delete(socket.data.roomCode as string);
    delete gameState.modifierPhase;
    gameState.currentRollerId = undefined;
    gameState.firstPlayerId = undefined;
    gameState.rollWinnerId = undefined;
    gameState.availablePartyLeaderCards = [];
    gameState.partyLeaderSelectionOrder = [];
    gameState.currentSelectionPlayerId = undefined;

    // Back in the lobby there is no seat-holding — drop anyone still
    // disconnected rather than let a ghost block the ready-up gate.
    for (const playerId of Object.keys(gameState.players)) {
      if (gameState.players[playerId]?.connected === false) {
        cancelSeatRemoval(socket.data.roomCode as string, playerId);
        delete gameState.players[playerId];
      }
    }

    for (const playerId of Object.keys(gameState.players)) {
      const player = gameState.players[playerId];
      if (!player) continue;
      player.zones.hand = [];
      player.zones.party = [];
      player.actionPoints = 3;
      player.partyLeaderId = undefined;
      player.slainMonsters = [];
      player.ready = false;
    }

    // Fresh game back in the lobby — start the log over with the reset notice.
    gameState.gameLog = [];
    logEvent(gameState, 'system', `${nameOf(gameState, pid)} reset the game.`, { id: pid, username: gameState.players[pid]?.username });

    sendRoomUpdate();
  });

  socket.on('pingServer', () => {
    socket.emit('pongClient', { message: 'Connection successful!' });
  });

  socket.on('setUsername', (username) => {
    const gameState = getRoomState(socket.data.roomCode as string);
    if (gameState) {
      const player = gameState.players[pid];
      if (player) {
        player.username = username;
      } else {
        gameState.players[pid] = {
          id: pid,
          username: username,
          ready: false,
          connected: true,
          actionPoints: 3,
          partyLeaderId: undefined,
          slainMonsters: [],
          zones: {
            hand: [],
            party: [],
          }
        };
      }
      sendRoomUpdate();
    }
  });

  socket.on('disconnect', () => {
    const roomCode = socket.data.roomCode as string | undefined;
    if (!roomCode) return;

    const gameState = getRoomState(roomCode);
    if (!gameState) return;

    // A newer socket already took this seat over — nothing to release.
    if (socketIdForPlayer(roomCode, pid) !== socket.id) return;
    unregisterPlayerSocket(roomCode, pid, socket.id);

    const player = gameState.players[pid];
    if (!player) return;

    const wasActivePlayer = gameState.activePlayerId === pid;
    player.connected = false;

    // Anything the game is waiting on from them resolves as a pass right away.
    resolveDeparture(roomCode, gameState, pid);

    // Leadership must stay with someone who can actually click things.
    if (gameState.lobbyLeaderId === pid) {
      gameState.lobbyLeaderId = nextConnectedAfter(gameState, pid) ?? gameState.lobbyLeaderId;
    }

    // Once a game is underway the seat survives a grace period for reconnects;
    // in the lobby (or after game over) there is nothing worth holding.
    const holdSeat = gameState.status !== 'waiting' && gameState.status !== 'finished';
    logGame(gameState, 'player_disconnected', {
      username: player.username,
      wasActivePlayer,
      seatHeldMs: holdSeat ? SEAT_GRACE_MS : 0,
    }, pid);

    if (holdSeat) {
      logEvent(gameState, 'system', `${nameOf(gameState, pid)} disconnected — holding their seat for ${Math.round(SEAT_GRACE_MS / 60000)} minutes.`, { id: pid, username: player.username });
      scheduleSeatRemoval(roomCode, pid);
      sendRoomUpdate();
      return;
    }

    removePlayerSeat(roomCode, gameState, pid, 'left');
  });
};

io.on('connection', handleConnection);

// Exported for tests: integration tests listen on an ephemeral port and connect
// real socket.io clients, then close via io.close().
export { handleConnection, httpServer, io };

const PORT = process.env.PORT || 3001;
// Only bind a port when run as the entrypoint. Importing server.ts in tests
// (Vitest sets process.env.VITEST) must not boot a real server.
if (!process.env.VITEST) {
  // Ship any game logs a previous process left behind before serving traffic.
  void sweepOrphanedLogs();

  httpServer.listen(PORT, () => {
    console.log(`Server listening on port ${PORT}`);
  });

  // ECS sends SIGTERM before killing the task; close open analytics sessions
  // (reason server_shutdown) and let the uploads finish, capped so a wedged S3
  // call can't stall the stop past the orchestrator's grace period.
  let shuttingDown = false;
  const shutdown = (signal: NodeJS.Signals) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`Received ${signal}, flushing analytics before exit…`);
    void (async () => {
      try {
        await Promise.race([
          shutdownAnalytics(),
          new Promise(resolve => setTimeout(resolve, 10_000)),
        ]);
      } finally {
        process.exit(0);
      }
    })();
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}
